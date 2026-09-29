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

  // ────────────────────────── 구성 종목 목록 갱신 (위키백과) ──────────────────────────
  // MediaWiki API 는 origin=* 로 CORS 를 허용하므로 브라우저와 서버 모두 같은 주소를 쓴다.
  const WIKI_API = 'https://en.wikipedia.org/w/api.php?action=parse&page=List_of_S%26P_500_companies&prop=text&format=json&formatversion=2&origin=*';
  const decode = (s) => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  // 위키백과 표(#constituents) HTML → [[티커, 회사명, 섹터], ...]. DOM 없이 정규식으로 읽어 서버에서도 동작한다.
  function parseUniverse(html) {
    const start = html.indexOf('id="constituents"');
    if (start < 0) throw new Error('위키백과에서 S&P 500 구성 종목 표를 찾지 못했습니다.');
    const table = html.slice(start, html.indexOf('</table>', start));
    const list = [];
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => decode(m[1].replace(/<[^>]+>/g, '')).trim());
      if (cells.length < 3 || !/^[A-Z0-9.\-]{1,10}$/.test(cells[0])) continue;
      list.push([cells[0].replace(/\./g, '-'), cells[1], cells[2]]);   // Yahoo 표기: BRK.B → BRK-B
    }
    if (list.length < 480 || list.length > 520) throw new Error(`종목 수가 예상과 다릅니다 (${list.length}개). 위키백과 표 구조가 바뀌었을 수 있습니다.`);
    return list;
  }
  async function fetchUniverse(fetchImpl, headers) {
    const r = await fetchImpl(WIKI_API, headers ? { headers } : undefined);
    if (!r.ok) throw new Error(`위키백과 응답 오류 (${r.status})`);
    const j = await r.json();
    return parseUniverse(j.parse.text);
  }
  function diffUniverse(oldList, newList) {
    const o = new Set(oldList.map(x => x[0])), n = new Set(newList.map(x => x[0]));
    return { added: newList.filter(x => !o.has(x[0])), removed: oldList.filter(x => !n.has(x[0])) };
  }

  async function runScan({ fetchSeries, universe, concurrency = 8, onProgress, previous, now = Date.now() }) {
    const list = universe && universe.length ? universe : UNIVERSE;
    const results = [], errors = [];
    let i = 0, done = 0, live = false, day = null;
    const worker = async () => {
      while (i < list.length) {
        const [s, n, sec] = list[i++];
        try {
          const d = await fetchSeries(s);
          const a = Signal.analyze(d, { symbol: s, watch: true }, Signal.DEFAULT_SETTINGS);
          const p = d.period && d.period.regular;
          if (p && now / 1000 >= p.start && now / 1000 < p.end) live = true;
          if (!day || d.tradeDay > day) day = d.tradeDay;
          results.push(compact(s, n, sec, a));
        } catch (e) { errors.push(s); }
        done++;
        if (onProgress) onProgress(done, list.length);
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
    return { at: new Date(now).toISOString(), day, live, total: list.length, errors, results };
  }

  const api = { runScan, UNIVERSE, parseUniverse, fetchUniverse, diffUniverse };
  if (isNode) module.exports = api;
  else root.Scan = api;
})(this);
