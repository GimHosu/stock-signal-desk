// 증시 주요 일정 — 서버·브라우저 공용 (순수 함수)
//  · 규칙으로 계산: 뉴욕증시 휴장일·조기 폐장, 옵션 만기일(셋째 금요일)·쿼드러플 위칭
//  · 고정 목록: FOMC 금리 결정일 (연준 발표 일정 — 해마다 추가 필요)
//  · 경제지표: 경제 캘린더 피드(이번 주)를 한국어 제목으로 변환
(function (root) {
  // 연준 FOMC 정례회의 (둘째 날 = 금리 결정·성명 발표, 미국 동부 14:00). sep: 경제전망(점도표) 발표 회의
  const FOMC = [
    { date: '2026-01-28' }, { date: '2026-03-18', sep: true }, { date: '2026-04-29' }, { date: '2026-06-17', sep: true },
    { date: '2026-07-29' }, { date: '2026-09-16', sep: true }, { date: '2026-10-28' }, { date: '2026-12-09', sep: true },
  ];

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();         // 0=일
  const nthWeekday = (y, m, wd, n) => { const first = dow(y, m, 1); return 1 + ((wd - first + 7) % 7) + (n - 1) * 7; };
  const lastWeekday = (y, m, wd) => { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return last - ((dow(y, m, last) - wd + 7) % 7); };
  function easter(y) {   // 그레고리력 부활절 (익명 알고리즘)
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }
  const shiftDay = (date, n) => { const t = new Date(date.getTime() + n * 864e5); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
  // 토요일이면 금요일, 일요일이면 월요일로 대체 휴장
  const observed = (y, m, d) => { const w = dow(y, m, d), t = new Date(Date.UTC(y, m - 1, d)); return w === 6 ? shiftDay(t, -1) : w === 0 ? shiftDay(t, 1) : ymd(y, m, d); };

  // 뉴욕증권거래소(NYSE) 휴장일 & 조기 폐장(미국 동부 13:00)
  function marketHolidays(y) {
    const out = [];
    const add = (date, title, type = 'holiday') => out.push({ date, title, type });
    if (dow(y, 1, 1) !== 6) add(observed(y, 1, 1), '새해 첫날 휴장');              // 1/1 이 토요일이면 대체 휴장 없음
    add(ymd(y, 1, nthWeekday(y, 1, 1, 3)), '마틴 루터 킹 데이 휴장');
    add(ymd(y, 2, nthWeekday(y, 2, 1, 3)), '대통령의 날 휴장');
    add(shiftDay(easter(y), -2), '성금요일 휴장');
    add(ymd(y, 5, lastWeekday(y, 5, 1)), '메모리얼 데이 휴장');
    add(observed(y, 6, 19), '준틴스 휴장');
    add(observed(y, 7, 4), '독립기념일 휴장');
    add(ymd(y, 9, nthWeekday(y, 9, 1, 1)), '노동절 휴장');
    const tg = nthWeekday(y, 11, 4, 4);
    add(ymd(y, 11, tg), '추수감사절 휴장');
    add(observed(y, 12, 25), '크리스마스 휴장');
    const w4 = dow(y, 7, 4);
    if (w4 >= 2 && w4 <= 5) add(ymd(y, 7, 3), '독립기념일 전날 조기 폐장 (13:00)', 'early');
    add(ymd(y, 11, tg + 1), '추수감사절 다음 날 조기 폐장 (13:00)', 'early');
    const w24 = dow(y, 12, 24);
    if (w24 >= 1 && w24 <= 4) add(ymd(y, 12, 24), '크리스마스 이브 조기 폐장 (13:00)', 'early');
    return out;
  }

  // 옵션 만기일: 매월 셋째 금요일 (휴장이면 전날). 3·6·9·12월은 쿼드러플 위칭 + S&P 500 분기 리밸런싱
  function optionExpirations(y) {
    const hol = new Set(marketHolidays(y).filter(x => x.type === 'holiday').map(x => x.date));
    const out = [];
    for (let m = 1; m <= 12; m++) {
      let d = ymd(y, m, nthWeekday(y, m, 5, 3));
      if (hol.has(d)) d = shiftDay(new Date(d + 'T00:00:00Z'), -1);
      const quad = m % 3 === 0;
      out.push({ date: d, type: 'opex', title: quad ? '쿼드러플 위칭 (선물·옵션 동시 만기)' : '월간 옵션 만기일',
        detail: quad ? '주가지수·개별주식 선물과 옵션이 한꺼번에 만기되고, S&P 500 분기 리밸런싱도 이날 장 마감에 반영됩니다. 장 막판 거래량과 변동성이 커지기 쉽습니다.' : '개별주식·지수 옵션 만기일입니다. 만기 전후로 변동성이 커질 수 있습니다.',
        impact: quad ? 'High' : 'Low' });
    }
    return out;
  }

  // 미국 동부 시각 → Date (서머타임 자동 반영)
  function etToDate(date, hh, mm) {
    const [y, m, d] = date.split('-').map(Number);
    for (const off of [4, 5]) {
      const t = new Date(Date.UTC(y, m - 1, d, hh + off, mm));
      const h = +t.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
      if (h % 24 === hh) return t;
    }
    return new Date(Date.UTC(y, m - 1, d, hh + 5, mm));
  }

  function fomcEvents() {
    const out = [];
    for (const f of FOMC) {
      out.push({ date: f.date, at: etToDate(f.date, 14, 0).toISOString(), type: 'fomc', impact: 'High',
        title: `FOMC 금리 결정${f.sep ? ' · 점도표 발표' : ''}`,
        detail: `연준이 기준금리를 발표하고 30분 뒤 의장 기자회견이 열립니다.${f.sep ? ' 이번 회의는 경제전망(점도표)도 함께 나와 금리 경로 전망이 바뀔 수 있습니다.' : ''}` });
      const minutes = shiftDay(new Date(f.date + 'T00:00:00Z'), 21);   // 의사록: 3주 뒤 수요일 14:00
      out.push({ date: minutes, at: etToDate(minutes, 14, 0).toISOString(), type: 'fomc', impact: 'Medium', title: 'FOMC 의사록 공개', detail: '3주 전 FOMC 회의의 논의 내용이 공개됩니다.' });
    }
    return out;
  }

  // 경제지표 영어 제목 → 한국어 (자주 나오는 미국 지표)
  const TITLES = [
    [/^Non-Farm Employment Change/i, '비농업 고용 (고용보고서)'], [/^Unemployment Rate/i, '실업률'], [/^Average Hourly Earnings/i, '평균 시간당 임금'],
    [/^Core CPI/i, '근원 소비자물가(CPI)'], [/^CPI/i, '소비자물가(CPI)'], [/^Core PPI/i, '근원 생산자물가(PPI)'], [/^PPI/i, '생산자물가(PPI)'],
    [/^Core PCE Price Index/i, '근원 PCE 물가'], [/^PCE Price Index/i, 'PCE 물가'], [/GDP Price Index/i, 'GDP 물가지수'], [/GDP/i, 'GDP 성장률'],
    [/^Core Retail Sales/i, '근원 소매판매'], [/^Retail Sales/i, '소매판매'], [/^ISM Manufacturing PMI/i, 'ISM 제조업 PMI'], [/^ISM Services PMI/i, 'ISM 서비스업 PMI'],
    [/^Unemployment Claims/i, '신규 실업수당 청구건수'], [/^JOLTS/i, 'JOLTS 구인건수'], [/^ADP Non-Farm/i, 'ADP 민간고용'],
    [/Consumer Confidence/i, '소비자신뢰지수'], [/UoM Consumer Sentiment/i, '미시간대 소비자심리'], [/UoM Inflation Expectations/i, '미시간대 기대인플레이션'],
    [/^Federal Funds Rate/i, 'FOMC 기준금리 결정'], [/^FOMC Statement/i, 'FOMC 성명'], [/^FOMC Press Conference/i, 'FOMC 기자회견'], [/^FOMC Meeting Minutes/i, 'FOMC 의사록'],
    [/^Fed Chair (\w+) Speaks/i, '연준 의장 $1 연설'], [/^FOMC Member (\w+) Speaks/i, 'FOMC 위원 $1 연설'], [/^President (\w+) Speaks/i, '$1 대통령 연설'],
    [/^Durable Goods Orders/i, '내구재 주문'], [/^Core Durable Goods/i, '근원 내구재 주문'], [/^Empire State Manufacturing/i, '뉴욕 제조업지수'], [/^Philly Fed Manufacturing/i, '필라델피아 제조업지수'],
    [/Building Permits/i, '건축허가'], [/Housing Starts/i, '주택착공'], [/Existing Home Sales/i, '기존주택 판매'], [/New Home Sales/i, '신규주택 판매'], [/Pending Home Sales/i, '주택 계약 대기'],
    [/Industrial Production/i, '산업생산'], [/Trade Balance/i, '무역수지'], [/Crude Oil Inventories/i, '원유 재고'], [/Flash Manufacturing PMI/i, '제조업 PMI 속보치'], [/Flash Services PMI/i, '서비스업 PMI 속보치'],
    [/Employment Cost Index/i, '고용비용지수'], [/Prelim Nonfarm Productivity/i, '비농업 생산성'], [/Treasury Currency Report/i, '재무부 환율보고서'], [/Beige Book/i, '베이지북'],
  ];
  const PRE = { final: '확정치 ', prelim: '예비치 ', advance: '속보치 ', revised: '수정치 ' };
  const SFX = { 'm/m': ' (전월비)', 'y/y': ' (전년비)', 'q/q': ' (전분기비)' };
  function koTitle(t) {
    const s = String(t || '').replace(/^(Final|Prelim|Advance|Revised)\s+/i, '');
    for (const [re, ko] of TITLES) {
      const m = s.match(re);
      if (!m) continue;
      const pre = (t.match(/^(Final|Prelim|Advance|Revised)\b/i) || [])[1];
      const sfx = (t.match(/\b(m\/m|y\/y|q\/q)\s*$/i) || [])[1];
      return (pre ? PRE[pre.toLowerCase()] : '') + ko.replace('$1', m[1] || '') + (sfx ? SFX[sfx.toLowerCase()] : '');
    }
    return t;   // 사전에 없는 지표는 영어 그대로
  }

  // 경제 캘린더 피드(ForexFactory 형식) → 미국 중요 지표만
  function parseEconomic(feed) {
    return (feed || []).filter(x => x.country === 'USD' && (x.impact === 'High' || x.impact === 'Medium')).map(x => {
      const at = new Date(x.date);
      return { date: at.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), at: at.toISOString(), type: 'econ', impact: x.impact,
        title: koTitle(x.title), titleEn: x.title, forecast: x.forecast || null, previous: x.previous || null };
    });
  }

  // 모든 일정 합치기: from ~ to (YYYY-MM-DD, 미국 동부 날짜)
  function build({ from, to, economic = [], earnings = [] }) {
    const ys = [+from.slice(0, 4), +to.slice(0, 4)];
    const years = ys[0] === ys[1] ? [ys[0]] : ys;
    const fixed = years.flatMap(y => [...marketHolidays(y), ...optionExpirations(y)]).map(x => ({ impact: x.type === 'holiday' ? 'High' : x.impact || 'Medium', ...x }));
    const all = [...fixed, ...fomcEvents(), ...economic, ...earnings].filter(x => x.date >= from && x.date <= to);
    // 경제 피드에 이미 있는 FOMC 결정은 중복 제거
    const econFomc = new Set(economic.filter(x => /FOMC|Federal Funds/.test(x.titleEn || '')).map(x => x.date));
    return all.filter(x => !(x.type === 'fomc' && /금리 결정/.test(x.title) && econFomc.has(x.date)))
      .sort((a, b) => (a.at || a.date + 'T23:59') < (b.at || b.date + 'T23:59') ? -1 : 1);
  }

  const MEGA = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'AVGO', 'TSLA', 'BRK.B', 'JPM', 'LLY', 'V', 'MA', 'WMT', 'ORCL', 'NFLX', 'COST', 'XOM', 'UNH', 'PLTR'];

  const api = { FOMC, MEGA, marketHolidays, optionExpirations, fomcEvents, parseEconomic, koTitle, build, etToDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Cal = api;
})(this);
