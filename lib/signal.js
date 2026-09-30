// 신호 엔진 — 브라우저(<script src="/lib/signal.js">, window.Signal)와
// 서버(require('../lib/signal.js'))가 같은 규칙을 쓰도록 한 파일에 모아 둔다.
//
// 종합 퀀트 점수(0~100) = 4개 매트릭스 × 25점
//   1. 추세(Trend)  2. 모멘텀 반등(Momentum)  3. 변동성·지지선(Volatility)  4. 시장강도·거래량(Strength)
// + 다이버전스, 5대 핵심 조건, 진입·목표·손절가, MDD, 규칙 기반 진단 문장
(function (root) {
  const SIGNAL_VERSION = 2; // 점수 체계가 바뀌면 올린다 → 이전 체계의 신호 기록과 비교하지 않음

  const pct = (v, d = 2) => v == null || isNaN(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  const fx = (v, d = 2) => v == null || isNaN(v) ? '–' : v.toFixed(d);
  const usd = (v) => v == null || isNaN(v) ? '–' : '$' + v.toFixed(2);

  // ────────────────────────── Yahoo 응답 → 시계열 ──────────────────────────
  function parseChart(j, symbol) {
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw new Error(`'${symbol}' 데이터가 없습니다.`);
    const q = r.indicators.quote[0];
    const out = { symbol: r.meta.symbol, name: r.meta.longName || r.meta.shortName || r.meta.symbol, currency: r.meta.currency, date: [], close: [], high: [], low: [], volume: [] };
    r.timestamp.forEach((t, i) => {
      const c = q.close[i];
      if (c == null) return;
      out.date.push(new Date(t * 1000));
      out.close.push(c); out.high.push(q.high[i] ?? c); out.low.push(q.low[i] ?? c); out.volume.push(q.volume[i] || 0);
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
    // 배당 기록 (차트 요청에 events=div 가 있을 때)
    const dv = r.events && r.events.dividends;
    out.dividends = dv ? Object.values(dv).map(x => ({ date: new Date(x.date * 1000), amount: x.amount })).sort((a, b) => a.date - b.date) : [];
    return out;
  }

  // ────────────────────────── 지표 ──────────────────────────
  function sma(a, n) {
    const o = Array(a.length).fill(null); let s = 0;
    for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  // 앞쪽이 null 로 채워진 배열에 함수 적용 (예: 스토캐스틱 %K 의 이동평균)
  const onValid = (a, fn) => { const s = a.findIndex(v => v != null); return s < 0 ? a.map(() => null) : Array(s).fill(null).concat(fn(a.slice(s))); };
  const smaN = (a, n) => onValid(a, x => sma(x, n));
  function ema(a, n) {
    const o = Array(a.length).fill(null); const k = 2 / (n + 1);
    const start = a.findIndex(v => v != null); if (start < 0 || start + n > a.length) return o;
    let s = 0; for (let i = start; i < start + n; i++) s += a[i];
    o[start + n - 1] = s / n;
    for (let i = start + n; i < a.length; i++) o[i] = a[i] * k + o[i - 1] * (1 - k);
    return o;
  }
  // Wilder 평활 (RSI·ATR·ADX)
  function rma(a, n) {
    const o = Array(a.length).fill(null);
    const s = a.findIndex(v => v != null); if (s < 0 || s + n > a.length) return o;
    let acc = 0; for (let i = s; i < s + n; i++) acc += a[i];
    o[s + n - 1] = acc / n;
    for (let i = s + n; i < a.length; i++) o[i] = (o[i - 1] * (n - 1) + a[i]) / n;
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
    const mid = sma(c, n), up = [], lo = [];
    for (let i = 0; i < c.length; i++) {
      if (mid[i] == null) { up.push(null); lo.push(null); continue; }
      let v = 0; for (let j = i - n + 1; j <= i; j++) v += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(v / n); up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd);
    }
    return { mid, up, lo };
  }
  const trueRange = (h, l, c) => c.map((_, i) => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  function dmi(h, l, c, n = 14) {
    const pdm = [0], mdm = [0];
    for (let i = 1; i < c.length; i++) {
      const u = h[i] - h[i - 1], d = l[i - 1] - l[i];
      pdm.push(u > d && u > 0 ? u : 0); mdm.push(d > u && d > 0 ? d : 0);
    }
    const atr = rma(trueRange(h, l, c), n), p = rma(pdm, n), m = rma(mdm, n);
    const pdi = p.map((v, i) => v == null || !atr[i] ? null : 100 * v / atr[i]);
    const mdi = m.map((v, i) => v == null || !atr[i] ? null : 100 * v / atr[i]);
    const dx = pdi.map((v, i) => v == null ? null : v + mdi[i] === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / (v + mdi[i]));
    return { pdi, mdi, adx: rma(dx, n), atr };
  }
  // 파라볼릭 SAR (0.02, 최대 0.2)
  function parabolic(h, l, step = 0.02, max = 0.2) {
    const o = Array(h.length).fill(null); if (h.length < 3) return o;
    let up = h[1] >= h[0], ep = up ? h[1] : l[1], af = step, s = up ? l[0] : h[0];
    o[1] = s;
    for (let i = 2; i < h.length; i++) {
      s += af * (ep - s);
      if (up) {
        s = Math.min(s, l[i - 1], l[i - 2]);
        if (l[i] < s) { up = false; s = ep; ep = l[i]; af = step; }
        else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
      } else {
        s = Math.max(s, h[i - 1], h[i - 2]);
        if (h[i] > s) { up = true; s = ep; ep = h[i]; af = step; }
        else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
      }
      o[i] = s;
    }
    return o;
  }
  const hh = (a, n, i) => Math.max(...a.slice(Math.max(0, i - n + 1), i + 1));
  const ll = (a, n, i) => Math.min(...a.slice(Math.max(0, i - n + 1), i + 1));
  function stochastic(h, l, c, n = 14, k = 3, d = 3) {
    const raw = c.map((v, i) => { if (i < n - 1) return null; const H = hh(h, n, i), Lo = ll(l, n, i); return H === Lo ? 50 : (v - Lo) / (H - Lo) * 100; });
    const K = smaN(raw, k);
    return { k: K, d: smaN(K, d) };
  }
  function cci(h, l, c, n = 20) {
    const tp = c.map((v, i) => (h[i] + l[i] + v) / 3), m = sma(tp, n);
    return tp.map((v, i) => {
      if (m[i] == null) return null;
      let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= n; return md === 0 ? 0 : (v - m[i]) / (0.015 * md);
    });
  }
  const williamsR = (h, l, c, n = 14) => c.map((v, i) => { if (i < n - 1) return null; const H = hh(h, n, i), Lo = ll(l, n, i); return H === Lo ? -50 : (H - v) / (H - Lo) * -100; });
  function obv(c, v) { const o = [0]; for (let i = 1; i < c.length; i++) o.push(o[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0)); return o; }
  function mfi(h, l, c, v, n = 14) {
    const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
    return c.map((_, i) => {
      if (i < n) return null;
      let p = 0, m = 0;
      for (let j = i - n + 1; j <= i; j++) { const f = tp[j] * v[j]; if (tp[j] > tp[j - 1]) p += f; else if (tp[j] < tp[j - 1]) m += f; }
      return m === 0 ? 100 : 100 - 100 / (1 + p / m);
    });
  }
  // 매물대: 최근 구간 거래량을 가격대별로 나눠 가장 많이 거래된 가격(POC)을 찾는다 (일봉 근사)
  function pointOfControl(h, l, v, from, to, bins = 24) {
    const lo = Math.min(...l.slice(from, to + 1)), hi = Math.max(...h.slice(from, to + 1));
    const w = (hi - lo) / bins || 1, b = Array(bins).fill(0);
    for (let i = from; i <= to; i++) {
      const a = Math.max(0, Math.floor((l[i] - lo) / w)), z = Math.min(bins - 1, Math.floor((h[i] - lo) / w));
      for (let k = a; k <= z; k++) b[k] += v[i] / (z - a + 1);
    }
    return lo + (b.indexOf(Math.max(...b)) + 0.5) * w;
  }
  // 스윙 고점/저점: 좌우 w봉 안에서 가장 높거나 낮은 봉
  function swings(a, L, type, look = 60, w = 3) {
    const out = [];
    for (let i = Math.max(w, L - look); i <= L - w; i++) {
      let ok = true;
      for (let j = i - w; j <= i + w && ok; j++) if (j !== i && (type === 'low' ? a[j] < a[i] : a[j] > a[i])) ok = false;
      if (ok && (!out.length || i - out[out.length - 1] >= 5)) out.push(i);
    }
    return out;
  }

  // ────────────────────────── 다이버전스 ──────────────────────────
  // 강세: 가격은 더 낮은 저점, RSI(또는 MACD 히스토그램)는 더 높은 저점 → 하락 힘이 약해짐
  // 약세: 가격은 더 높은 고점, RSI(또는 MACD 히스토그램)는 더 낮은 고점 → 상승 힘이 약해짐
  function divergence(d, r, hist, L) {
    const found = [];
    const lows = swings(d.low, L, 'low'), highs = swings(d.high, L, 'high');
    if (lows.length >= 2) {
      const [i, j] = lows.slice(-2);
      if (d.low[j] < d.low[i] && (r[j] > r[i] || (hist[j] != null && hist[i] != null && hist[j] > hist[i]))) found.push({ type: 'bull', i, j });
    }
    if (highs.length >= 2) {
      const [i, j] = highs.slice(-2);
      if (d.high[j] > d.high[i] && (r[j] < r[i] || (hist[j] != null && hist[i] != null && hist[j] < hist[i]))) found.push({ type: 'bear', i, j });
    }
    const x = found.filter(f => L - f.j <= 15).sort((a, b) => b.j - a.j)[0];
    if (!x) return { type: 'none', title: '다이버전스 중립 (일반 추세)', status: '정상 추세', text: '최근 가격과 보조지표(RSI·MACD) 사이에 뚜렷한 괴리가 없습니다.' };
    const ago = L - x.j;
    return x.type === 'bull'
      ? { type: 'bull', ago, title: '강세 다이버전스 발생', status: '반등 신호 (BUY)', text: `${ago}거래일 전 저점이 이전 저점보다 낮았지만 RSI·MACD는 더 높아졌습니다. 하락 힘이 약해지는 반전 신호입니다.` }
      : { type: 'bear', ago, title: '약세 다이버전스 발생', status: '과열 경고 (SELL)', text: `${ago}거래일 전 고점이 이전 고점보다 높았지만 RSI·MACD는 더 낮아졌습니다. 상승 힘이 약해지는 경고 신호입니다.` };
  }

  // ────────────────────────── 판정 기준 ──────────────────────────
  // 추세 매트릭스와 반등 매트릭스는 서로 반대 상황에서 점수가 나므로 실제 합계는 대부분 15~60점에 모인다.
  // S&P 500 전 종목 분포(2026-09-29, 중앙값 37 · 상위 5% 50 · 최고 56)에 맞춰 기준을 정했다.
  //   강력 매수 ≈ 상위 5% · 매수 ≈ 다음 15% · 보유 ≈ 중간 55% · 매도 ≈ 15% · 강력 매도 ≈ 하위 10%
  const GRADES = [[55, 'S'], [50, 'A'], [44, 'B'], [35, 'C'], [26, 'D'], [0, 'F']];
  const LEVELS = [[50, 'buy', '강력 매수'], [44, 'buy', '매수'], [32, 'hold', '보유'], [26, 'sell', '매도'], [0, 'sell', '강력 매도']];
  const gradeOf = (s) => GRADES.find(([t]) => s >= t)[1];
  const levelOf = (s) => LEVELS.find(([t]) => s >= t);

  // ────────────────────────── 종합 분석 ──────────────────────────
  // fund: lib/fundamentals.js 의 결과 (없거나 { unavailable } 이면 재무 항목은 판정 제외)
  function analyze(d, h, settings, fund) {
    const c = d.close, hi = d.high, lo = d.low, v = d.volume, L = c.length - 1, px = c[L];
    const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
    const r = rsi(c), m = macd(c), bb = bollinger(c), dm = dmi(hi, lo, c), sar = parabolic(hi, lo);
    const st = stochastic(hi, lo, c), cc = cci(hi, lo, c), wr = williamsR(hi, lo, c), ob = obv(c, v), mf = mfi(hi, lo, c, v);
    const atr = dm.atr[L], atrPct = atr / px * 100;
    const rv = r[L], k = st.k[L], kd = st.d[L], pdi = dm.pdi[L], mdi = dm.mdi[L], adx = dm.adx[L];
    const gap200 = s200[L] ? (px / s200[L] - 1) * 100 : null;
    const roc = L >= 12 ? (px / c[L - 12] - 1) * 100 : null;
    const pivot = (hi[L - 1] + lo[L - 1] + c[L - 1]) / 3;
    const pctB = (px - bb.lo[L]) / (bb.up[L] - bb.lo[L]);
    const bw = bb.up.map((u, i) => u == null ? null : (u - bb.lo[i]) / bb.mid[i]);
    const bwWin = bw.slice(-120).filter(x => x != null), bwRank = bwWin.filter(x => x < bw[L]).length / bwWin.length;
    const kelMid = ema(c, 20)[L], kelAtr = rma(trueRange(hi, lo, c), 10)[L], kelLo = kelMid - 2 * kelAtr;
    const envLo = s20[L] * 0.95, disparity = px / s20[L] * 100;
    const vol20 = sma(v, 20), vol5 = sma(v, 5), vRatio = vol20[L - 1] ? v[L] / vol20[L - 1] : 1;
    const dollar = px * v[L], dollarAvg = c.slice(-21, -1).reduce((s, x, i) => s + x * v[L - 20 + i], 0) / 20;
    const obvAvg = sma(ob, 20)[L], vE5 = ema(v, 5)[L], vE10 = ema(v, 10)[L], vosc = vE10 ? (vE5 - vE10) / vE10 * 100 : 0;
    const poc = pointOfControl(hi, lo, v, Math.max(0, L - 59), L);
    const high20 = Math.max(...hi.slice(L - 20, L));
    let peak = -Infinity;
    const dd = c.map(x => { peak = Math.max(peak, x); return (x / peak - 1) * 100; });
    const mdd = Math.min(...dd), ddNow = dd[L], mddRatio = mdd < 0 ? ddNow / mdd * 100 : 0;
    const yr = c.slice(-252), high52 = Math.max(...yr), low52 = Math.min(...yr);

    // 최근 N봉 안의 상향 교차
    const crossUp = (a, b, n) => { for (let i = L; i > L - n; i--) if (a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i]) return L - i; return -1; };
    const gcAgo = crossUp(s50, s200, 20), stAgo = crossUp(st.k, st.d, 3), midAgo = crossUp(c, bb.mid, 5);

    const item = (label, max, pts, value) => ({ label, max, pts: Math.max(0, Math.min(max, pts)), value });
    const matrices = [
      { key: 'trend', name: '추세 지표', en: 'Trend Matrix', items: [
        item('이동평균 정배열 (20>50)', 4, s20[L] > s50[L] ? 4 : 0, s20[L] > s50[L] ? (px > s20[L] ? '정배열' : '20>50, 주가 이탈') : '역배열·혼조'),
        item('200일선 상회', 4, s200[L] && px > s200[L] ? 4 : 0, s200[L] ? `${px > s200[L] ? '상회' : '하회'} (${pct(gap200, 1)})` : '데이터 부족'),
        item('50/200 골든크로스', 3, s200[L] && s50[L] > s200[L] ? 3 : 0, !s200[L] ? '데이터 부족' : gcAgo >= 0 ? `${gcAgo}일 전 발생` : s50[L] > s200[L] ? '50일선 > 200일선' : '미발생'),
        item('MACD (12,26,9) & 0선', 5, (m.line[L] > m.sig[L] ? 3 : 0) + (m.line[L] > 0 ? 2 : 0), `${fx(m.line[L])} (Signal ${fx(m.sig[L])})`),
        item('DMI (+DI > −DI)', 3, pdi > mdi ? 3 : 0, `+DI ${fx(pdi, 1)} vs −DI ${fx(mdi, 1)}`),
        item('ADX 추세강도 (25 이상)', 2, adx >= 25 && pdi > mdi ? 2 : 0, `ADX ${fx(adx, 1)} ${adx >= 25 ? '(추세)' : '(횡보)'}`),
        item('ROC (12일 가격변화율)', 2, roc > 0 ? 2 : 0, pct(roc, 1)),
        item('피봇 & 파라볼릭 SAR', 2, (px > pivot ? 1 : 0) + (sar[L] < px ? 1 : 0), `SAR ${usd(sar[L])} ${sar[L] < px ? '하단(상승)' : '상단(하락)'}`),
      ] },
      { key: 'momentum', name: '모멘텀 반등', en: 'Momentum Matrix', items: [
        item('RSI 14 (과매도 반등)', 6, rv <= 30 ? 6 : rv <= 40 ? 4 : rv <= 50 ? 2 : 0, `RSI ${fx(rv, 1)}`),
        item('스토캐스틱 (14,3,3) 골든크로스', 5, stAgo >= 0 && k < 50 ? 5 : k > kd && k < 50 ? 3 : k < 20 ? 2 : 0, `%K ${fx(k, 1)} / %D ${fx(kd, 1)}${stAgo >= 0 ? ' 교차' : ''}`),
        item('CCI (−100 이탈)', 4, cc[L] <= -100 ? 4 : cc[L] <= -50 ? 2 : 0, `CCI ${fx(cc[L], 1)}`),
        item('20일 이격도', 4, disparity <= 95 ? 4 : disparity <= 98 ? 2 : 0, `${fx(disparity, 1)}%`),
        item('20일 고점 돌파 (P&F 근사)', 3, px > high20 ? 3 : 0, px > high20 ? '돌파' : `미돌파 (${usd(high20)})`),
        item('Williams %R 과매도', 3, wr[L] <= -80 ? 3 : wr[L] <= -60 ? 1 : 0, `%R ${fx(wr[L], 1)}`),
      ] },
      { key: 'volatility', name: '변동성 & 지지선', en: 'Volatility Matrix', items: [
        item('볼린저 %B 하단 지지', 6, pctB <= 0.2 ? 6 : pctB <= 0.4 ? 3 : 0, `%B ${fx(pctB * 100, 1)}%`),
        item('볼린저 스퀴즈 (수축)', 5, bwRank <= 0.2 ? 5 : bwRank <= 0.35 ? 2 : 0, `밴드폭 ${fx(bw[L] * 100, 1)}% (120일 하위 ${fx(bwRank * 100, 0)}%)`),
        item('볼린저 20일 중심선 돌파', 4, midAgo >= 0 ? 4 : px > bb.mid[L] ? 2 : 0, midAgo >= 0 ? `${midAgo}일 전 돌파` : px > bb.mid[L] ? '중심선 위' : '중심선 아래'),
        item('ATR (14) 변동성 안정', 4, atrPct <= 2.5 ? 4 : atrPct <= 4 ? 2 : 0, `${usd(atr)} (${fx(atrPct, 2)}%)`),
        item('엔벨로프 하단 지지', 3, px <= envLo * 1.02 ? 3 : 0, `하단 ${usd(envLo)}`),
        item('켈트너 채널 하단', 3, px <= kelLo + 0.25 * (kelMid - kelLo) ? 3 : 0, `하단 ${usd(kelLo)}`),
      ] },
      { key: 'strength', name: '시장강도 & 거래량', en: 'Strength Matrix', items: [
        item('거래량 배수 (20일 평균 대비)', 5, vRatio >= 2 ? 5 : vRatio >= 1.5 ? 3 : vRatio >= 1 ? 2 : 0, `${fx(vRatio, 2)}배`),
        item('거래량 이평 5/20 골든크로스', 4, vol5[L] > vol20[L] ? 4 : 0, vol5[L] > vol20[L] ? '5일 > 20일' : '5일 < 20일'),
        item('대량 거래대금 유입', 3, dollar >= dollarAvg && c[L] > c[L - 1] ? 3 : 0, `$${fx(dollar / 1e6, 0)}M`),
        item('매물대 (POC) 상회', 4, px > poc ? 4 : 0, `POC ${usd(poc)} ${px > poc ? '상회' : '하회'}`),
        item('OBV 매집', 4, ob[L] > obvAvg ? 4 : ob[L] > ob[L - 5] ? 1 : 0, ob[L] > obvAvg ? '매집 (20일 평균 위)' : ob[L] > ob[L - 5] ? '중립 (5일 상승)' : '분산'),
        item('MFI (자금흐름)', 3, mf[L] <= 30 ? 3 : mf[L] <= 40 ? 2 : 0, `MFI ${fx(mf[L], 1)}`),
        item('Volume Oscillator', 2, vosc > 0 ? 2 : 0, pct(vosc, 1)),
      ] },
    ];
    for (const mx of matrices) { mx.max = 25; mx.score = mx.items.reduce((s, x) => s + x.pts, 0); }
    let score = matrices.reduce((s, mx) => s + mx.score, 0);

    // 내 포지션 (보유 종목만): 손절·익절 기준 도달 시 감점
    const reasons = [];
    const plPct = h && !h.watch && h.avgCost > 0 ? (px / h.avgCost - 1) * 100 : null;
    if (plPct != null && settings) {
      if (plPct <= settings.stopPct) { score -= 20; reasons.push({ pts: -20, text: `수익률 ${pct(plPct, 1)} — 손절 기준(${settings.stopPct}%) 도달` }); }
      else if (plPct >= settings.takePct) { score -= 10; reasons.push({ pts: -10, text: `수익률 ${pct(plPct, 1)} — 익절 기준(+${settings.takePct}%) 도달, 분할 익절 고려` }); }
    }
    score = Math.max(0, Math.min(100, score));
    matrices.flatMap(mx => mx.items).filter(x => x.pts > 0).sort((a, b) => b.pts - a.pts)
      .forEach(x => reasons.push({ pts: x.pts, text: `${x.label}: ${x.value}` }));
    const [, key, label] = levelOf(score), grade = gradeOf(score);

    // 재무·밸류에이션: SEC 공시(최근 4분기) + Yahoo 배당 기록
    const F = fund && !fund.unavailable ? fund : null;
    const divTtm = (d.dividends || []).filter(x => x.date >= new Date(d.date[L] - 365 * 864e5)).reduce((s, x) => s + x.amount, 0);
    const fin = {
      available: !!F, reason: fund && fund.unavailable ? fund.reason : null,
      ...(F || {}),
      per: F && F.eps > 0 ? px / F.eps : null,
      divYield: divTtm > 0 ? divTtm / px * 100 : 0,
    };

    // 5대 핵심 조건 (재무 데이터가 없으면 흑자기업은 판정 제외)
    const big = (v) => v == null ? '–' : (v < 0 ? '−' : '') + '$' + (Math.abs(v) >= 1e9 ? (Math.abs(v) / 1e9).toFixed(2) + 'B' : (Math.abs(v) / 1e6).toFixed(0) + 'M');
    const profit = F ? { name: '흑자기업', ok: F.netIncome > 0 && (F.opIncome == null || F.opIncome > 0),
      value: F.netIncome > 0 ? (F.opIncome != null && F.opIncome <= 0 ? '영업 적자' : '안정적 흑자') : '적자',
      sub: `순이익 ${big(F.netIncome)}${F.eps != null ? ` · EPS $${F.eps.toFixed(2)}` : ''}${F.opMargin != null ? ` · 영업이익률 ${F.opMargin.toFixed(1)}%` : ''}` }
      : { name: '흑자기업', ok: null, value: '재무 정보 없음', sub: fund && fund.reason ? fund.reason : '재무 정보를 불러오는 중' };
    const conditions = [
      { name: '볼린저밴드 위치', ok: pctB <= 0.5, value: pctB <= 0.2 ? '하단 구간' : pctB <= 0.5 ? '하단~중단 구간' : pctB <= 0.8 ? '중단~상단 구간' : '상단 구간', sub: `하단 ${usd(bb.lo[L])} ~ 중단 ${usd(bb.mid[L])}` },
      { name: '200일선 상회', ok: !!s200[L] && px > s200[L], value: !s200[L] ? '데이터 부족' : px > s200[L] ? '200일선 상회' : '200일선 하회', sub: `200일선 ${usd(s200[L])}` },
      { name: 'RSI ≤ 40 (과매도)', ok: rv <= 40, value: `RSI ${fx(rv, 1)}`, sub: rv <= 40 ? '눌림목 분할매수 적기' : '기준 40 이하' },
      { name: 'MDD 최대낙폭 근접', ok: mddRatio >= 70, value: `현재 ${fx(ddNow, 2)}%`, sub: `2년 MDD ${fx(mdd, 2)}% · 도달률 ${fx(mddRatio, 0)}%` },
      profit,
    ];
    const condMet = conditions.filter(x => x.ok).length, condTotal = conditions.filter(x => x.ok != null).length;

    // 진입·손절·목표가: 현재가 아래 5% 이내에서 가장 가까운 지지선을 진입가로, 최근 60일 저점·ATR로 손절가, 위쪽 저항선으로 목표가
    const swingLow = Math.min(...lo.slice(-60));
    const supports = [bb.lo[L], s20[L], s50[L], s200[L], poc, kelLo].filter(x => x && x < px && x >= px * 0.95);
    const entry = supports.length ? Math.max(...supports) : px;
    let sl = Math.max(swingLow * 0.99, entry - 2.5 * atr);
    sl = Math.max(Math.min(sl, entry * 0.97), entry * 0.88);           // 손절 폭 3%~12%
    const risk = entry - sl;
    const resist = [bb.up[L], s200[L], s50[L], Math.max(...hi.slice(-60)), high52, poc]
      .filter(x => x && x >= entry + 1.5 * risk).sort((a, b) => a - b);
    const tp = resist[0] || entry + 2 * risk;
    const tp2 = resist.find(x => x > tp * 1.03) || Math.max(tp * 1.06, entry + 3 * risk);
    const rr = (tp - entry) / risk;
    const band = (x) => [x * 0.995, x * 1.005];
    const buys = [
      { range: [px * 0.99, px], weight: 30, note: '현재가 부근' },
      { range: band(entry < px * 0.99 ? entry : Math.max(bb.lo[L] < entry ? bb.lo[L] : entry - 0.4 * risk, sl + 0.5 * risk)), weight: 40, note: entry < px * 0.99 ? '지지선' : '볼린저 하단·눌림목' },
      { range: band(sl + 0.25 * risk), weight: 30, note: '손절선 직전 저점권' },
    ];
    const plan = { entry, sl, tp, tp2, rr, buys, entryGap: (entry / px - 1) * 100 };

    const div = divergence(d, r, m.hist, L);
    const ctx = { sym: d.symbol, px, score, grade, label, key, matrices, conditions, condMet, condTotal, plan, div, h, plPct, settings, fin, big,
      s200: s200[L], s50: s50[L], gap200, rv, k, pctB, bbLo: bb.lo[L], bbMid: bb.mid[L], bbUp: bb.up[L], macdLine: m.line[L], macdSig: m.sig[L], hist: m.hist[L],
      adx, pdi, mdi, atrPct, vRatio, mdd, ddNow, mddRatio };

    return {
      v: SIGNAL_VERSION, score, grade, key, label, reasons,
      price: px, prev: c[L - 1], chg: px - c[L - 1], chgPct: (px / c[L - 1] - 1) * 100, date: d.date[L],
      rsi: rv, s20: s20[L], s50: s50[L], s200: s200[L], hist: m.hist[L], high52, low52,
      stopPrice: plPct != null ? h.avgCost * (1 + settings.stopPct / 100) : null,
      takePrice: plPct != null ? h.avgCost * (1 + settings.takePct / 100) : null,
      plPct, matrices, conditions, condMet, condTotal, divergence: div, plan, fin,
      mdd: { max: mdd, now: ddNow, ratio: mddRatio },
      report: buildReport(ctx),
      series: { s20, s50, s200, bbUp: bb.up, bbMid: bb.mid, bbLo: bb.lo, rsi: r, macd: m.line, macdSig: m.sig, macdHist: m.hist, stK: st.k, stD: st.d, dd },
    };
  }

  // ────────────────────────── 규칙 기반 진단 문장 ──────────────────────────
  function buildReport(x) {
    const sorted = [...x.matrices].sort((a, b) => b.score - a.score), best = sorted[0], worst = sorted[sorted.length - 1];
    const p = x.plan;

    const summary = [
      `${x.sym}는 5대 핵심 조건 중 ${x.condMet}개${x.condTotal < 5 ? `(재무 제외 ${x.condTotal}개 중)` : ''}를 충족하며 종합 퀀트 점수 ${x.score}점(${x.grade}등급)을 기록했습니다.`,
      x.s200 == null ? '' : x.gap200 >= 0
        ? `200일 이동평균선(${usd(x.s200)})을 ${pct(x.gap200)} 상회하고 있어 장기 상승 추세가 유지되고 있습니다.`
        : `200일 이동평균선(${usd(x.s200)})을 ${pct(x.gap200)} 하회하고 있어 장기적으로는 하락 압력이 남아 있습니다.`,
      x.rv <= 30 ? `RSI(${fx(x.rv, 1)})가 과매도 구간에 들어와 기술적 반등 가능성이 높은 자리입니다.`
        : x.rv <= 40 ? `RSI(${fx(x.rv, 1)})와 스토캐스틱(%K ${fx(x.k, 1)})이 과매도에 가까워 분할 매수 관점에서 가격 매력이 있는 구간입니다.`
        : x.rv >= 70 ? `RSI(${fx(x.rv, 1)})가 과매수 구간이라 추격 매수보다는 조정을 기다리는 편이 유리합니다.`
        : `RSI(${fx(x.rv, 1)})는 중립 구간입니다.`,
      x.pctB <= 0.2 ? `볼린저밴드 하단(${usd(x.bbLo)}) 부근에서 지지를 시험하고 있습니다.`
        : x.pctB >= 0.8 ? `볼린저밴드 상단(${usd(x.bbUp)}) 부근이라 단기 과열에 유의해야 합니다.` : '',
    ].filter(Boolean).join(' ');

    const mddText = [
      `최근 2년 최대 낙폭(MDD)은 ${fx(x.mdd, 2)}%이고, 현재 고점 대비 ${fx(x.ddNow, 2)}% 하락해 MDD 도달률은 ${fx(x.mddRatio, 0)}%입니다.`,
      x.mddRatio >= 80 ? '과거 최대 낙폭에 근접한 구간으로, 통계적으로 하방 경직성이 확보될 가능성이 높은 국면입니다.'
        : x.mddRatio >= 50 ? '과거 최대 낙폭의 절반 이상을 반영한 조정 구간입니다.'
        : x.ddNow > -5 ? '고점 부근에서 거래되고 있어 낙폭 측면의 가격 매력은 크지 않습니다.'
        : '과거 최대 낙폭과 비교하면 아직 추가 하락 여지가 남아 있습니다.',
    ].join(' ');

    const pos = x.pctB <= 0.2 ? '하단' : x.pctB <= 0.5 ? '하단~중단' : x.pctB <= 0.8 ? '중단~상단' : '상단';
    const techText = [
      `현재가는 볼린저밴드 ${pos} 영역(%B ${fx(x.pctB * 100, 1)}%)에 있습니다.`,
      x.macdLine > x.macdSig ? `MACD가 시그널선 위에 있어 단기 모멘텀은 개선되고 있습니다.`
        : `MACD 히스토그램(${fx(x.hist)})이 음수로 아직 매수 교차가 나오지 않았습니다.`,
      x.adx >= 25 ? (x.pdi > x.mdi ? `ADX ${fx(x.adx, 1)}로 상승 추세의 강도가 뚜렷합니다.` : `ADX ${fx(x.adx, 1)}로 하락 추세의 힘이 강해 바닥 확인이 필요합니다.`)
        : `ADX ${fx(x.adx, 1)}로 뚜렷한 추세 없이 횡보하고 있습니다.`,
      x.div.type === 'none' ? '다이버전스는 관찰되지 않습니다.' : x.div.text,
      `4개 매트릭스 중 ${best.name}(${best.score}/25)이 가장 강하고, ${worst.name}(${worst.score}/25)이 가장 약합니다.`,
    ].join(' ');

    const f = x.fin, big = x.big;
    const fundText = !f.available ? `재무 정보가 없어 펀더멘털 판정은 제외했습니다.${f.reason ? ` (${f.reason})` : ''}${f.divYield > 0 ? ` 최근 1년 배당수익률은 ${fx(f.divYield, 2)}%입니다.` : ''}` : [
      f.netIncome > 0
        ? `최근 4분기 순이익 ${big(f.netIncome)}${f.opMargin != null ? `, 영업이익률 ${fx(f.opMargin, 1)}%` : ''}로 흑자를 내고 있습니다.`
        : `최근 4분기 순손실 ${big(f.netIncome)}로 적자 상태입니다. 기술적 반등이 나와도 실적 개선 여부를 함께 확인해야 합니다.`,
      f.opMargin == null ? '' : f.opMargin >= 20 ? '수익성이 매우 높은 편입니다.' : f.opMargin >= 10 ? '수익성은 양호한 편입니다.' : f.opMargin >= 0 ? '수익성은 낮은 편입니다.' : '영업 단계에서 손실을 내고 있습니다.',
      f.revGrowth == null ? '' : `최근 회계연도 매출은 전년 대비 ${pct(f.revGrowth, 1)} ${f.revGrowth >= 0 ? '증가' : '감소'}했습니다.`,
      f.per == null ? (f.eps != null && f.eps <= 0 ? 'EPS가 음수라 PER은 산정하지 않았습니다.' : '')
        : `EPS $${fx(f.eps, 2)} 기준 PER은 ${fx(f.per, 1)}배로 ${f.per < 15 ? '낮은 편(저평가 구간)' : f.per < 30 ? '시장 평균 수준' : '높은 편(성장 기대가 반영된 가격)'}입니다.`,
      f.divYield > 0 ? `최근 1년 배당수익률은 ${fx(f.divYield, 2)}%입니다.` : '배당은 지급하지 않습니다.',
    ].filter(Boolean).join(' ');

    const rng = ([a, b]) => `${usd(a)} ~ ${usd(b)}`;
    const planText = [
      x.plPct != null ? `현재 보유 수익률은 ${pct(x.plPct, 1)}입니다. 아래 가격은 추가 매수 시 참고용입니다.` : '',
      `분할 매수: 1차 ${rng(p.buys[0].range)} (비중 ${p.buys[0].weight}%, ${p.buys[0].note}), 2차 ${rng(p.buys[1].range)} (${p.buys[1].weight}%, ${p.buys[1].note}), 3차 ${rng(p.buys[2].range)} (${p.buys[2].weight}%, ${p.buys[2].note}).`,
      `손절 기준: ${usd(p.sl)} (진입가 대비 ${pct((p.sl / p.entry - 1) * 100, 1)}) — 최근 60일 저점과 ATR을 기준으로 잡았습니다. 이 가격을 종가로 이탈하면 비중 축소를 권합니다.`,
      `목표가: 1차 ${usd(p.tp)} (${pct((p.tp / p.entry - 1) * 100, 1)}), 2차 ${usd(p.tp2)} (${pct((p.tp2 / p.entry - 1) * 100, 1)}). 손익비는 1 : ${fx(p.rr, 1)}입니다.`,
    ].filter(Boolean).join(' ');

    const risks = [];
    if (x.plPct != null && x.settings && x.plPct <= x.settings.stopPct) risks.push(`보유 수익률 ${pct(x.plPct, 1)}로 손절 기준(${x.settings.stopPct}%)에 도달했습니다.`);
    if (x.s200 != null && x.gap200 < 0) risks.push('200일선 하회 — 중장기 하락 추세가 이어질 수 있습니다.');
    if (x.s50 != null && x.s200 != null && x.s50 < x.s200) risks.push('50일선이 200일선 아래 — 추세 전환 전까지 반등 폭이 제한될 수 있습니다.');
    if (x.macdLine < x.macdSig) risks.push('MACD 매수 교차 부재 — 바닥 다지기 기간이 길어질 수 있습니다.');
    if (x.adx >= 25 && x.mdi > x.pdi) risks.push(`강한 하락 추세 진행 중 (ADX ${fx(x.adx, 1)}, −DI 우위).`);
    if (x.div.type === 'bear') risks.push('약세 다이버전스 — 상승 탄력이 둔화되고 있습니다.');
    if (x.rv >= 70) risks.push(`RSI ${fx(x.rv, 1)} 과매수 — 단기 조정 가능성이 있습니다.`);
    if (x.atrPct >= 4) risks.push(`하루 평균 변동폭이 큽니다 (ATR ${fx(x.atrPct, 1)}%) — 분할 매수와 손절 준수가 필요합니다.`);
    if (x.mddRatio >= 90) risks.push('과거 최대 낙폭 수준 — 이탈 시 신저가 구간에 들어설 위험이 있습니다.');
    if (x.vRatio < 0.7) risks.push('거래량 부진 — 반등이 나와도 신뢰도가 낮을 수 있습니다.');
    if (p.rr < 1.5) risks.push(`손익비 1 : ${fx(p.rr, 1)} — 신규 진입 매력이 크지 않습니다.`);
    if (f.available && f.netIncome <= 0) risks.push('적자 기업 — 실적 개선 전까지 변동성이 커질 수 있습니다.');
    if (f.per != null && f.per >= 40) risks.push(`PER ${fx(f.per, 1)}배의 높은 밸류에이션 — 실적 실망 시 조정 폭이 클 수 있습니다.`);
    if (f.available && f.revGrowth != null && f.revGrowth < 0) risks.push(`매출 역성장 (${pct(f.revGrowth, 1)}) — 성장 둔화 우려가 있습니다.`);
    if (!risks.length) risks.push('뚜렷한 기술적·재무적 위험 신호는 없습니다.');
    risks.push('뉴스·거시 변수와 실적 발표 일정은 반영되지 않았습니다.');

    return { summary, mdd: mddText, tech: techText, fund: fundText, plan: planText, risks: risks.slice(0, 7) };
  }

  const DEFAULT_SETTINGS = { stopPct: -8, takePct: 25 };
  const api = { parseChart, analyze, sma, ema, rsi, macd, bollinger, pct, DEFAULT_SETTINGS, SIGNAL_VERSION, GRADES, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Signal = api;
})(this);
