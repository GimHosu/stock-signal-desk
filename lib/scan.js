// 종목 발굴 스캔 — S&P 500 전 종목에 같은 신호 규칙을 적용한다.
// 시세 함수를 주입받아 서버(api/scan.js)와 브라우저(로컬 모드) 양쪽에서 쓴다.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const Signal = isNode ? require('./signal.js') : root.Signal;
  const UNIVERSE = isNode ? require('./universe.js') : root.UNIVERSE;

  const round = (v) => v == null || isNaN(v) ? null : Math.round(v * 100) / 100;
  // 저장 용량을 줄이려고 화면에 필요한 값만 남긴다. 보유 종목이 아니므로 손절/익절 규칙은 빠진다.
  const compact = (s, n, sec, a) => ({
    s, n, sec, score: a.score, key: a.key, label: a.label,
    price: round(a.price), chgPct: round(a.chgPct), rsi: a.rsi == null ? null : Math.round(a.rsi),
    reasons: a.reasons.filter(r => r.pts).sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts)).slice(0, 3).map(r => [r.pts, r.text]),
  });

  async function runScan({ fetchSeries, concurrency = 8, onProgress, previous, now = Date.now() }) {
    const results = [], errors = [];
    let i = 0, done = 0, live = false, day = null;
    const worker = async () => {
      while (i < UNIVERSE.length) {
        const [s, n, sec] = UNIVERSE[i++];
        try {
          const d = await fetchSeries(s);
          const a = Signal.analyze(d, { symbol: s, watch: true }, Signal.DEFAULT_SETTINGS);
          const p = d.period && d.period.regular;
          if (p && now / 1000 >= p.start && now / 1000 < p.end) live = true;
          if (!day || d.tradeDay > day) day = d.tradeDay;
          results.push(compact(s, n, sec, a));
        } catch (e) { errors.push(s); }
        done++;
        if (onProgress) onProgress(done, UNIVERSE.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    results.sort((a, b) => b.score - a.score || a.s.localeCompare(b.s));

    // 이전 스캔과 비교할 점수(prev): 거래일이 바뀌었으면 이전 스캔 점수, 같은 날 재스캔이면 이전 스캔의 비교값을 유지
    if (previous && previous.results) {
      const old = new Map(previous.results.map(r => [r.s, r]));
      const sameDay = previous.day === day;
      for (const r of results) {
        const o = old.get(r.s);
        if (o) r.prev = sameDay ? o.prev : o.score;
      }
    }
    return { at: new Date(now).toISOString(), day, live, total: UNIVERSE.length, errors, results };
  }

  const api = { runScan, UNIVERSE };
  if (isNode) module.exports = api;
  else root.Scan = api;
})(this);
