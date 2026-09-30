// 섹터 강도 & 순환매 (RRG: Relative Rotation Graph) — 섹터 ETF 11개를 S&P 500(SPY)과 비교한다.
//   상대강도 RS = 섹터 ÷ SPY
//   RS-Ratio    = 100 × RS ÷ RS의 50일 평균        (100보다 크면 시장보다 강함)
//   RS-Momentum = 100 × RS-Ratio ÷ 10거래일 전 RS-Ratio (100보다 크면 강도가 좋아지는 중)
//   → 주도(강함·개선) · 약화(강함·둔화) · 소외(약함·둔화) · 개선(약함·개선)
(function (root) {
  const SECTORS = [
    { etf: 'XLK', en: 'Information Technology', ko: 'IT', type: 'cyclical' },
    { etf: 'XLC', en: 'Communication Services', ko: '커뮤니케이션', type: 'cyclical' },
    { etf: 'XLY', en: 'Consumer Discretionary', ko: '경기소비재', type: 'cyclical' },
    { etf: 'XLF', en: 'Financials', ko: '금융', type: 'cyclical' },
    { etf: 'XLI', en: 'Industrials', ko: '산업재', type: 'cyclical' },
    { etf: 'XLB', en: 'Materials', ko: '소재', type: 'cyclical' },
    { etf: 'XLE', en: 'Energy', ko: '에너지', type: 'cyclical' },
    { etf: 'XLV', en: 'Health Care', ko: '헬스케어', type: 'defensive' },
    { etf: 'XLP', en: 'Consumer Staples', ko: '필수소비재', type: 'defensive' },
    { etf: 'XLU', en: 'Utilities', ko: '유틸리티', type: 'defensive' },
    { etf: 'XLRE', en: 'Real Estate', ko: '부동산', type: 'defensive' },
  ];
  const BENCH = 'SPY';
  const QUAD = {
    leading: { ko: '주도', desc: '시장보다 강하고 더 강해지는 중' },
    weakening: { ko: '약화', desc: '시장보다 강하지만 힘이 빠지는 중' },
    lagging: { ko: '소외', desc: '시장보다 약하고 더 약해지는 중' },
    improving: { ko: '개선', desc: '시장보다 약하지만 좋아지는 중' },
  };
  // 시계 방향 순환: 소외 → 개선 → 주도 → 약화 → 소외
  const MOVE = {
    'lagging>improving': ['반등 시작', '소외 구간을 벗어나 자금이 들어오기 시작했습니다.', 'pos'],
    'improving>leading': ['주도권 확보', '시장 대비 강세로 올라섰습니다.', 'pos'],
    'leading>weakening': ['모멘텀 둔화', '여전히 강하지만 상승 탄력이 줄고 있습니다.', 'neg'],
    'weakening>lagging': ['약세 전환', '시장 대비 약세로 밀려났습니다.', 'neg'],
    'weakening>leading': ['재가속', '둔화되던 강세가 다시 살아났습니다.', 'pos'],
    'improving>lagging': ['반등 실패', '회복하던 흐름이 다시 꺾였습니다.', 'neg'],
    'lagging>weakening': ['급반등', '짧은 기간에 시장 대비 강세로 뛰어올랐습니다.', 'pos'],
    'leading>improving': ['급락', '짧은 기간에 시장 대비 약세로 밀렸습니다.', 'neg'],
    'leading>lagging': ['급격한 약세 전환', '2주 만에 주도에서 소외로 밀려났습니다. 자금이 빠져나가는 신호입니다.', 'neg'],
    'lagging>leading': ['급격한 강세 전환', '2주 만에 소외에서 주도로 올라섰습니다. 자금이 몰리는 신호입니다.', 'pos'],
    'improving>weakening': ['단기 과열', '빠르게 강세로 올라섰지만 탄력은 이미 둔화되고 있습니다.', 'neg'],
    'weakening>improving': ['눌림 후 반등', '약세로 밀렸다가 다시 좋아지고 있습니다.', 'pos'],
  };

  const quadOf = (ratio, mom) => ratio >= 100 ? (mom >= 100 ? 'leading' : 'weakening') : (mom >= 100 ? 'improving' : 'lagging');
  const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n);

  // 두 시계열을 거래일 기준으로 맞춘다 (종목마다 마지막 봉 시각이 다를 수 있음)
  function align(d, b) {
    const key = (dt) => dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const bm = new Map(b.date.map((dt, i) => [key(dt), b.close[i]]));
    const dates = [], s = [], m = [];
    d.date.forEach((dt, i) => { const k = key(dt); if (bm.has(k)) { dates.push(k); s.push(d.close[i]); m.push(bm.get(k)); } });
    return { dates, s, m };
  }
  const ret = (a, n) => a.length > n ? (a[a.length - 1] / a[a.length - 1 - n] - 1) * 100 : null;
  function ytd(dates, a) {
    const y = dates[dates.length - 1].slice(0, 4);
    const i = dates.findIndex(x => x.startsWith(y));
    return i > 0 ? (a[a.length - 1] / a[i - 1] - 1) * 100 : null;   // 작년 마지막 종가 대비
  }
  const PERIODS = [['w1', 5], ['m1', 21], ['m3', 63], ['m6', 126]];

  // series: { XLK: 시계열, ..., SPY: 시계열 } (Signal.parseChart 결과)
  function compute(series) {
    const bench = series[BENCH];
    if (!bench) throw new Error('S&P 500(SPY) 시세가 없습니다.');
    const rows = [];
    for (const sc of SECTORS) {
      const d = series[sc.etf]; if (!d) continue;
      const { dates, s, m } = align(d, bench);
      if (s.length < 80) continue;
      const rs = s.map((x, i) => x / m[i]);
      const rsAvg = sma(rs, 50);
      const ratio = rs.map((x, i) => rsAvg[i] == null ? null : 100 * x / rsAvg[i]);
      const mom = ratio.map((x, i) => x == null || ratio[i - 10] == null ? null : 100 * x / ratio[i - 10]);
      const L = s.length - 1;
      const tail = [30, 25, 20, 15, 10, 5, 0].map(k => L - k).filter(i => mom[i] != null).map(i => ({ date: dates[i], ratio: ratio[i], mom: mom[i], q: quadOf(ratio[i], mom[i]) }));
      if (!tail.length) continue;
      const now = tail[tail.length - 1], before = tail.find(t => t.date === dates[L - 10]) || tail[0];
      const r = {}, rel = {};
      for (const [k, n] of PERIODS) { r[k] = ret(s, n); rel[k] = r[k] == null ? null : r[k] - ret(m, n); }
      r.ytd = ytd(dates, s); rel.ytd = r.ytd == null ? null : r.ytd - ytd(dates, m);
      const move = before.q !== now.q ? MOVE[`${before.q}>${now.q}`] : null;
      rows.push({ ...sc, price: s[L], ret: r, rel, ratio: now.ratio, mom: now.mom, quad: now.q, prevQuad: before.q, move, tail });
    }
    const avg = (arr, k) => { const v = arr.map(x => x.rel[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const cyc = rows.filter(x => x.type === 'cyclical'), def = rows.filter(x => x.type === 'defensive');
    const risk = {};
    for (const k of ['m1', 'm3']) risk[k] = avg(cyc, k) != null && avg(def, k) != null ? avg(cyc, k) - avg(def, k) : null;
    risk.mode = risk.m1 == null ? 'unknown' : risk.m1 >= 2 ? 'on' : risk.m1 <= -2 ? 'off' : 'neutral';
    const benchRet = {}; for (const [k, n] of PERIODS) benchRet[k] = ret(bench.close, n);
    return { at: Date.now(), day: bench.tradeDay, rows, risk, bench: benchRet, text: describe(rows, risk) };
  }

  // 규칙 기반 요약 문장
  function describe(rows, risk) {
    const by = (q) => rows.filter(r => r.quad === q).sort((a, b) => (b.ratio + b.mom) - (a.ratio + a.mom));
    const names = (arr) => arr.map(r => r.ko).join('·');
    const lead = by('leading'), impr = by('improving'), weak = by('weakening'), lag = by('lagging');
    const top3 = [...rows].sort((a, b) => (b.rel.m3 ?? -1e9) - (a.rel.m3 ?? -1e9)).slice(0, 3);
    const out = [];
    out.push(lead.length ? `현재 시장을 주도하는 섹터는 ${names(lead)}입니다.` : '시장 대비 강하면서 더 강해지는 주도 섹터가 뚜렷하지 않습니다.');
    if (top3.length) out.push(`최근 3개월 시장 대비 성과는 ${top3.map(r => `${r.ko}(${r.rel.m3 >= 0 ? '+' : ''}${r.rel.m3.toFixed(1)}%p)`).join(', ')} 순으로 좋았습니다.`);
    if (impr.length) out.push(`${names(impr)}는 아직 시장보다 약하지만 흐름이 좋아지고 있어 다음 주도 섹터 후보입니다.`);
    if (weak.length) out.push(`${names(weak)}는 강세가 둔화되는 중이라 차익 실현 매물에 유의해야 합니다.`);
    const moves = rows.filter(r => r.move);
    out.push(moves.length ? `최근 2주 순환매 신호: ${moves.map(r => `${r.ko} ${QUAD[r.prevQuad].ko}→${QUAD[r.quad].ko}(${r.move[0]})`).join(', ')}.`
      : '최근 2주 동안 구역을 옮긴 섹터가 없어 뚜렷한 순환매는 관찰되지 않습니다.');
    if (risk.m1 != null) out.push(risk.mode === 'on'
      ? `경기민감 섹터가 방어 섹터보다 1개월 ${risk.m1.toFixed(1)}%p 앞서 위험 선호(Risk-on) 흐름입니다.`
      : risk.mode === 'off' ? `방어 섹터가 경기민감 섹터보다 1개월 ${(-risk.m1).toFixed(1)}%p 앞서 방어적(Risk-off) 흐름입니다.`
      : `경기민감 섹터와 방어 섹터의 1개월 성과 차이가 ${risk.m1 >= 0 ? '+' : ''}${risk.m1.toFixed(1)}%p로 뚜렷한 쏠림은 없습니다.`);
    return out.join(' ');
  }

  const api = { SECTORS, BENCH, QUAD, MOVE, compute, quadOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sectors = api;
})(this);
