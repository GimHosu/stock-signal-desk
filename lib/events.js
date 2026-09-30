// 실적 발표 일정 & 뉴스 심리 (Finnhub 응답 → 요약) — 서버·브라우저 공용, 순수 함수
// 뉴스 심리는 금융 헤드라인 키워드 사전으로 센다. 문맥은 이해하지 못한다 (예: "소송 승소"도 '소송'으로 셈).
(function (root) {
  // [정규식, 가중치, 태그]
  const POS = [
    [/\b(beats?|topp?(ed|s)?|surpass\w*|exceed\w*)\b/, 2, '실적 상회'],
    [/\bupgrad\w*/, 2, '투자의견 상향'],
    [/\b(rais\w*|lifts?|lifted|boost\w*|hik\w*)\b[^.]{0,30}\b(guidance|outlook|forecast|price target|target|dividend)/, 2, '전망·목표가 상향'],
    [/\b(wins?|won|award\w*|secur\w*)\b[^.]{0,20}\b(contract|deal|order)/, 2, '수주'],
    [/\b(record|all-time high)\b/, 1, '사상 최대'],
    [/\b(buyback|repurchase)/, 1, '자사주 매입'],
    [/\b(approv\w*|clearance)\b/, 1, '승인'],
    [/\b(partnership|partners with|collaborat\w*)\b/, 1, '제휴'],
    [/\b(surg\w*|soar\w*|jump\w*|rall(y|ies|ied)|spik\w*|climb\w*|rises?|gains?)\b/, 1, '주가 상승'],
    [/\b(outperform|overweight|buy rating|bullish)\b/, 1, '긍정 평가'],
    [/\b(strong|robust|accelerat\w*)\b[^.]{0,20}\b(demand|growth|sales|results)/, 1, '수요·성장 호조'],
  ];
  const NEG = [
    [/\b(miss(es|ed)?|falls? short|below (estimates|expectations))\b/, 2, '실적 하회'],
    [/\bdowngrad\w*/, 2, '투자의견 하향'],
    [/\b(cuts?|lower\w*|slash\w*|reduc\w*|trims?)\b[^.]{0,30}\b(guidance|outlook|forecast|price target|target|dividend)/, 2, '전망·목표가 하향'],
    [/\b(lawsuits?|sued|sues|litigation|class action)\b/, 2, '소송'],
    [/\b(probe|investigat\w*|subpoena|charged|fraud|indict\w*)\b/, 2, '조사·규제'],
    [/\brecall\w*/, 2, '리콜'],
    [/\b(bankrupt\w*|default\w*|going concern)\b/, 3, '파산 위험'],
    [/\b(layoffs?|job cuts|cuts? jobs|restructur\w*)\b/, 1, '구조조정'],
    [/\b(resign\w*|steps? down|ousted|departs?)\b/, 1, '경영진 이탈'],
    [/\b(plung\w*|tumbl\w*|slump\w*|sinks?|sank|drops?|dropped|falls|fell|declin\w*|slid(es)?|slip\w*|tank\w*)\b/, 1, '주가 하락'],
    [/\b(warn\w*|weak\w*|slowdown|headwinds?)\b/, 1, '경고·둔화'],
    [/\b(delay\w*|halt\w*|suspend\w*|outage|breach|hack\w*)\b/, 1, '차질·사고'],
    [/\b(antitrust|fined|penalt\w*|sanction\w*|tariffs?)\b/, 1, '규제·제재'],
    [/\b(underperform|underweight|sell rating|bearish|short seller)\b/, 1, '부정 평가'],
  ];

  function scoreHeadline(text) {
    const t = String(text || '').toLowerCase();
    let pos = 0, neg = 0; const tags = [];
    for (const [re, w, tag] of POS) if (re.test(t)) { pos += w; tags.push(['+', tag]); }
    for (const [re, w, tag] of NEG) if (re.test(t)) { neg += w; tags.push(['-', tag]); }
    const net = pos - neg;
    return { net, tone: net > 0 ? 'pos' : net < 0 ? 'neg' : 'neu', tags };
  }

  // 미국 동부 날짜 (YYYY-MM-DD) — 실적 일정은 거래소 날짜 기준
  const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  function summarizeNews(items, now = Date.now(), days = 7, max = 10) {
    const seen = new Set(), list = [];
    for (const n of (items || []).slice().sort((a, b) => b.datetime - a.datetime)) {
      const key = String(n.headline || '').toLowerCase().trim();
      if (!key || seen.has(key) || now - n.datetime * 1000 > days * 864e5) continue;
      seen.add(key);
      const s = scoreHeadline(n.headline);
      list.push({ t: n.datetime, headline: n.headline, source: n.source, url: n.url, net: s.net, tone: s.tone, tags: s.tags.map(x => x[1]) });
      if (list.length >= max) break;
    }
    const pos = list.filter(x => x.tone === 'pos').length, neg = list.filter(x => x.tone === 'neg').length;
    const score = list.reduce((s, x) => s + x.net, 0);
    const count = (sign) => { const m = {}; list.forEach(x => x.tags.forEach(tg => { if ((sign === '+') === POS.some(p => p[2] === tg)) m[tg] = (m[tg] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k]) => k); };
    return {
      items: list, total: list.length, pos, neg, neu: list.length - pos - neg, score,
      label: score >= 3 && pos > neg ? '긍정' : score <= -3 && neg > pos ? '부정' : '중립',
      posTags: count('+').slice(0, 3), negTags: count('-').slice(0, 3),
    };
  }

  const HOUR = { bmo: '장 시작 전', amc: '장 마감 후', dmh: '장중' };
  function summarizeEarnings(rows, now = Date.now()) {
    const today = etDay(now);
    const list = (rows || []).filter(r => r.date).sort((a, b) => a.date < b.date ? -1 : 1);
    const nx = list.find(r => r.date >= today && r.epsActual == null) || list.find(r => r.date > today);
    const past = list.filter(r => r.date < today && r.epsActual != null);
    const ls = past[past.length - 1];
    const pack = (r) => r && {
      date: r.date, hour: r.hour || '', hourText: HOUR[r.hour] || '시간 미정', quarter: r.quarter, year: r.year,
      epsEstimate: r.epsEstimate, epsActual: r.epsActual, revenueEstimate: r.revenueEstimate, revenueActual: r.revenueActual,
      surprisePct: r.epsActual != null && r.epsEstimate ? (r.epsActual - r.epsEstimate) / Math.abs(r.epsEstimate) * 100 : null,
      daysTo: Math.round((Date.parse(r.date) - Date.parse(today)) / 864e5),
    };
    return { next: pack(nx), last: pack(ls) };
  }

  function summarize({ earnings, news }, now = Date.now()) {
    return { at: now, earnings: summarizeEarnings(earnings, now), news: summarizeNews(news, now) };
  }

  const api = { scoreHeadline, summarizeNews, summarizeEarnings, summarize, etDay, HOUR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Events = api;
})(this);
