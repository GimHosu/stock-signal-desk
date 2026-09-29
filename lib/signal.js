// 신호 엔진 — 브라우저(<script src="/lib/signal.js">, window.Signal)와
// 서버(require('../lib/signal.js'))가 같은 규칙을 쓰도록 한 파일에 모아 둔다.
(function (root) {
  const pct = (v, d = 2) => v == null || isNaN(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';

  // ────────────────────────── Yahoo 응답 → 시계열 ──────────────────────────
  function parseChart(j, symbol) {
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw new Error(`'${symbol}' 데이터가 없습니다.`);
    const q = r.indicators.quote[0];
    const out = { symbol: r.meta.symbol, name: r.meta.longName || r.meta.shortName || r.meta.symbol, currency: r.meta.currency, date: [], close: [], high: [], low: [], volume: [] };
    r.timestamp.forEach((t, i) => {
      if (q.close[i] == null) return;
      out.date.push(new Date(t * 1000));
      out.close.push(q.close[i]); out.high.push(q.high[i]); out.low.push(q.low[i]); out.volume.push(q.volume[i] || 0);
    });
    if (out.close.length < 60) throw new Error('분석에 필요한 거래일 데이터가 부족합니다.');

    // 장중에는 일봉 마지막 값보다 meta.regularMarketPrice 가 더 최신이므로 오늘 봉에 반영한다.
    const mt = r.meta, tz = mt.exchangeTimezoneName || 'America/New_York';
    const dayKey = (dt) => dt.toLocaleDateString('en-CA', { timeZone: tz });
    if (mt.regularMarketPrice && mt.regularMarketTime) {
      const lt = new Date(mt.regularMarketTime * 1000), L = out.close.length - 1, px = mt.regularMarketPrice;
      if (dayKey(lt) === dayKey(out.date[L])) {
        out.close[L] = px; out.high[L] = Math.max(out.high[L], px); out.low[L] = Math.min(out.low[L], px);
      } else if (lt > out.date[L]) {
        out.date.push(lt); out.close.push(px); out.high.push(px); out.low.push(px); out.volume.push(mt.regularMarketVolume || 0);
      }
      out.priceTime = lt;
    }
    out.period = mt.currentTradingPeriod;
    out.tradeDay = dayKey(out.date[out.date.length - 1]); // 거래소 기준 마지막 거래일 (YYYY-MM-DD)
    return out;
  }

  // ────────────────────────── 지표 ──────────────────────────
  function sma(a, n) {
    const o = Array(a.length).fill(null); let s = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  function ema(a, n) {
    const o = Array(a.length).fill(null); const k = 2 / (n + 1);
    let start = a.findIndex(v => v != null); if (start < 0) return o;
    if (start + n > a.length) return o;
    let s = 0; for (let i = start; i < start + n; i++) s += a[i];
    o[start + n - 1] = s / n;
    for (let i = start + n; i < a.length; i++) o[i] = a[i] * k + o[i - 1] * (1 - k);
    return o;
  }
  function rsi(c, n = 14) {
    const o = Array(c.length).fill(null); let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return o;
  }
  function macd(c) {
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const line = c.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
    const sig = ema(line, 9);
    return { line, sig, hist: line.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null) };
  }
  function bollinger(c, n = 20, k = 2) {
    const mid = sma(c, n);
    const up = [], lo = [];
    for (let i = 0; i < c.length; i++) {
      if (mid[i] == null) { up.push(null); lo.push(null); continue; }
      let v = 0; for (let j = i - n + 1; j <= i; j++) v += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(v / n); up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd);
    }
    return { mid, up, lo };
  }

  // ────────────────────────── 규칙 기반 신호 엔진 ──────────────────────────
  // 각 규칙이 점수를 더하거나 빼고, 합계(−100~+100)로 매수/보유/매도를 판정한다.
  function analyze(d, h, settings) {
    const c = d.close, L = c.length - 1, px = c[L];
    const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
    const r = rsi(c), m = macd(c), bb = bollinger(c), v20 = sma(d.volume, 20);
    const reasons = []; let score = 0;
    const add = (pts, text) => { score += pts; reasons.push({ pts, text }); };

    // 1) 장기 추세
    if (s200[L] != null) {
      const gap = (px / s200[L] - 1) * 100;
      if (px > s200[L]) add(15, `주가가 200일선 위(${pct(gap, 1)}) — 장기 상승 추세`);
      else add(-15, `주가가 200일선 아래(${pct(gap, 1)}) — 장기 하락 추세`);
      // 골든/데드 크로스 (최근 10거래일)
      for (let i = L; i > L - 10 && i > 0; i--) {
        if (s50[i] == null || s200[i] == null || s50[i - 1] == null || s200[i - 1] == null) break;
        const now = s50[i] - s200[i], prev = s50[i - 1] - s200[i - 1];
        if (prev <= 0 && now > 0) { add(20, `골든크로스 발생 (${L - i}거래일 전, 50일선이 200일선 상향 돌파)`); break; }
        if (prev >= 0 && now < 0) { add(-20, `데드크로스 발생 (${L - i}거래일 전, 50일선이 200일선 하향 돌파)`); break; }
      }
    }
    // 2) 중기 추세
    if (s50[L] != null) {
      if (px > s50[L] && s20[L] > s50[L]) add(10, '주가 > 20일선 > 50일선 — 중기 정배열');
      else if (px < s50[L] && s20[L] < s50[L]) add(-10, '주가 < 20일선 < 50일선 — 중기 역배열');
      else add(0, '20일선과 50일선이 엇갈림 — 중기 추세 불분명');
    }
    // 3) RSI
    const rv = r[L];
    if (rv != null) {
      if (rv < 30) add(20, `RSI ${rv.toFixed(0)} — 과매도 구간, 반등 가능성`);
      else if (rv < 40) add(5, `RSI ${rv.toFixed(0)} — 약세이나 과매도에 근접`);
      else if (rv > 70) add(-20, `RSI ${rv.toFixed(0)} — 과매수 구간, 단기 조정 가능성`);
      else if (rv > 60) add(-5, `RSI ${rv.toFixed(0)} — 과매수에 근접`);
      else add(0, `RSI ${rv.toFixed(0)} — 중립`);
    }
    // 4) MACD
    let crossed = false;
    for (let i = L; i > L - 3; i--) {
      if (m.hist[i] == null || m.hist[i - 1] == null) break;
      if (m.hist[i - 1] <= 0 && m.hist[i] > 0) { add(15, `MACD 매수 교차 (${L - i}거래일 전)`); crossed = true; break; }
      if (m.hist[i - 1] >= 0 && m.hist[i] < 0) { add(-15, `MACD 매도 교차 (${L - i}거래일 전)`); crossed = true; break; }
    }
    if (!crossed && m.hist[L] != null) {
      if (m.hist[L] > 0) add(5, 'MACD가 시그널선 위 — 상승 모멘텀 유지');
      else add(-5, 'MACD가 시그널선 아래 — 하락 모멘텀 유지');
    }
    // 5) 볼린저밴드
    if (bb.lo[L] != null) {
      if (px < bb.lo[L]) add(10, '볼린저밴드 하단 이탈 — 단기 낙폭 과대');
      else if (px > bb.up[L]) add(-10, '볼린저밴드 상단 돌파 — 단기 과열');
    }
    // 6) 거래량
    if (v20[L - 1] && d.volume[L] > v20[L - 1] * 2) {
      const chg = c[L] - c[L - 1];
      if (chg > 0) add(5, `평균 대비 ${(d.volume[L] / v20[L - 1]).toFixed(1)}배 거래량 동반 상승`);
      else add(-5, `평균 대비 ${(d.volume[L] / v20[L - 1]).toFixed(1)}배 거래량 동반 하락`);
    }
    // 7) 내 포지션 기준 (손절 / 익절)
    const plPct = h && !h.watch && h.avgCost > 0 ? (px / h.avgCost - 1) * 100 : null;
    if (plPct != null) {
      if (plPct <= settings.stopPct) add(-30, `수익률 ${pct(plPct, 1)} — 손절 기준(${settings.stopPct}%) 도달`);
      else if (plPct >= settings.takePct) add(-15, `수익률 ${pct(plPct, 1)} — 익절 기준(+${settings.takePct}%) 도달, 분할 익절 고려`);
    }

    score = Math.max(-100, Math.min(100, score));
    let key, label;
    if (score >= 40) { key = 'buy'; label = '강력 매수'; }
    else if (score >= 15) { key = 'buy'; label = '매수'; }
    else if (score > -15) { key = 'hold'; label = '보유'; }
    else if (score > -40) { key = 'sell'; label = '매도'; }
    else { key = 'sell'; label = '강력 매도'; }

    const yr = c.slice(-252);
    return {
      score, key, label, reasons,
      price: px, prev: c[L - 1], chg: px - c[L - 1], chgPct: (px / c[L - 1] - 1) * 100, date: d.date[L],
      rsi: rv, s20: s20[L], s50: s50[L], s200: s200[L], hist: m.hist[L],
      high52: Math.max(...yr), low52: Math.min(...yr),
      stopPrice: plPct != null ? h.avgCost * (1 + settings.stopPct / 100) : null,
      takePrice: plPct != null ? h.avgCost * (1 + settings.takePct / 100) : null,
      plPct, series: { s20, s50, rsi: r },
    };
  }

  const DEFAULT_SETTINGS = { stopPct: -8, takePct: 25 };
  const api = { parseChart, analyze, sma, ema, rsi, macd, bollinger, pct, DEFAULT_SETTINGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Signal = api;
})(this);
