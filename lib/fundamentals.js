// SEC XBRL companyfacts → 핵심 재무 지표 (서버·브라우저 공용, 순수 함수)
// 최근 4분기(TTM) = 최근 연간(10-K) + 올해 누적(10-Q YTD) − 작년 같은 기간 누적
(function (root) {
  const DAY = 864e5;
  const days = (e) => (Date.parse(e.end) - Date.parse(e.start)) / DAY;
  const near = (a, b, tol = 10) => Math.abs(Date.parse(a) - Date.parse(b)) <= tol * DAY;
  const shift = (iso, d = 0, y = 0) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() + y); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

  // 한 계정(예: NetIncomeLoss)의 기간 값들 → { ttm, end, basis, annual, prevAnnual }
  function flow(entries) {
    if (!entries || !entries.length) return null;
    const uniq = new Map();
    for (const e of entries) if (e.start && e.end && /^10-[KQ]/.test(e.form || '')) uniq.set(e.start + '|' + e.end, e);
    const list = [...uniq.values()];
    const annual = list.filter(e => days(e) > 340 && days(e) < 390).sort((a, b) => a.end < b.end ? -1 : 1);
    if (!annual.length) return null;
    const A = annual[annual.length - 1], prevA = annual.length > 1 ? annual[annual.length - 2] : null;
    let ttm = A.val, end = A.end, basis = 'FY';
    const ytd = list.filter(e => days(e) < 340 && e.end > A.end && near(e.start, shift(A.end, 1))).sort((a, b) => a.end < b.end ? -1 : 1);
    if (ytd.length) {
      const Y = ytd[ytd.length - 1];
      const P = list.find(e => days(e) < 340 && near(e.start, A.start) && near(e.end, shift(Y.end, 0, -1)));
      if (P) { ttm = A.val + Y.val - P.val; end = Y.end; basis = 'TTM'; }
    }
    return { ttm, end, basis, annual: A.val, annualEnd: A.end, prevAnnual: prevA && near(prevA.end, shift(A.end, 0, -1), 20) ? prevA.val : null };
  }

  // 후보 계정 중 가장 최근까지 보고된 것을 쓴다 (회사마다 매출 계정 이름이 다름)
  function pick(gaap, names, unit = 'USD') {
    let best = null;
    for (const n of names) {
      const f = flow(gaap[n] && gaap[n].units && gaap[n].units[unit]);
      if (f && (!best || f.end > best.end)) best = { ...f, concept: n };
    }
    return best;
  }

  function extract(facts) {
    const gaap = facts && facts.facts && facts.facts['us-gaap'];
    if (!gaap) throw new Error('미국 회계기준(US-GAAP) 재무 데이터가 없습니다.');
    const ni = pick(gaap, ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic']);
    const rev = pick(gaap, ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'RevenuesNetOfInterestExpense']);
    const op = pick(gaap, ['OperatingIncomeLoss']);
    const eps = pick(gaap, ['EarningsPerShareDiluted', 'EarningsPerShareBasic'], 'USD/shares');
    if (!ni) throw new Error('순이익 데이터가 없습니다.');
    const sameBasis = (x) => x && ni && x.end === ni.end;   // 같은 기간끼리만 비율 계산
    return {
      name: facts.entityName, cik: facts.cik,
      asOf: ni.end, basis: ni.basis,
      netIncome: ni.ttm,
      revenue: rev ? rev.ttm : null,
      opIncome: op ? op.ttm : null,
      opMargin: sameBasis(rev) && sameBasis(op) && rev.ttm ? op.ttm / rev.ttm * 100 : null,
      netMargin: sameBasis(rev) && rev.ttm ? ni.ttm / rev.ttm * 100 : null,
      eps: eps ? eps.ttm : null,
      revGrowth: rev && rev.prevAnnual ? (rev.annual / rev.prevAnnual - 1) * 100 : null,   // 최근 회계연도 매출 성장률
      niGrowth: ni.prevAnnual && ni.prevAnnual > 0 ? (ni.annual / ni.prevAnnual - 1) * 100 : null,
      fiscalYearEnd: ni.annualEnd,
    };
  }

  const api = { extract, flow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fundamentals = api;
})(this);
