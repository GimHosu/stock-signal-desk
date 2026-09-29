// 장 마감 신호 점검 — 저장소·시세·발송 함수를 주입받아 동작한다 (서버 의존성 없음, 테스트 용이).
const { analyze, pct, DEFAULT_SETTINGS } = require('./signal.js');

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const isLive = (d, nowSec) => { const p = d.period && d.period.regular; return !!p && nowSec >= p.start && nowSec < p.end; };

// signals 저장 형식: { AAPL: { label, key, score, day: 'YYYY-MM-DD' } } — 거래일마다 확정 신호 1개
async function runCheck({ getJSON, setJSON, fetchSeries, send, appUrl, now = Date.now() }, { manual = false } = {}) {
  const p = await getJSON('portfolio', { holdings: [], settings: null });
  const settings = Object.assign({}, DEFAULT_SETTINGS, p.settings || {});
  const list = p.holdings || [];
  const prev = await getJSON('signals', {});

  const rows = [], errors = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const h = list[i++];
      try { const d = await fetchSeries(h.symbol); rows.push({ h, d, a: analyze(d, h, settings) }); }
      catch (e) { errors.push(`${h.symbol}: ${e.message}`); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  rows.sort((x, y) => list.indexOf(x.h) - list.indexOf(y.h));

  const next = {}, changes = [];
  let live = false, day = null;
  for (const r of rows) {
    const sym = r.h.symbol, old = prev[sym];
    if (isLive(r.d, now / 1000)) { live = true; if (old) next[sym] = old; continue; } // 장중 잠정 신호는 기록하지 않음
    day = r.d.tradeDay;
    if (old && old.day === day) { next[sym] = old; continue; }                      // 이 거래일은 이미 처리됨 (휴장일·중복 실행)
    if (old && old.label !== r.a.label) changes.push({ ...r, old });
    next[sym] = { label: r.a.label, key: r.a.key, score: r.a.score, day };
  }
  for (const h of list) if (!next[h.symbol] && prev[h.symbol]) next[h.symbol] = prev[h.symbol]; // 조회 실패 종목은 이전 값 유지
  await setJSON('signals', next);

  const sent = changes.length > 0 || manual;
  if (sent) await send(buildMessage({ rows, changes, errors, manual, live, day, appUrl }));
  return { checked: rows.length, changes: changes.map(c => ({ symbol: c.h.symbol, from: c.old.label, to: c.a.label })), errors, sent, live };
}

function buildMessage({ rows, changes, errors, manual, live, day, appUrl }) {
  const icon = (k) => k === 'buy' ? '🟢' : k === 'sell' ? '🔴' : '⚪';
  const score = (s) => (s > 0 ? '+' : '') + s;
  const money = (v) => '$' + v.toFixed(2);
  const tag = (h) => h.watch ? ' (관심)' : '';
  const out = [`📊 <b>Stock Signal Desk</b> · ${live ? '장중 잠정 신호' : `${day || ''} 장 마감`}`];

  if (changes.length) {
    out.push('', `<b>신호 변경 ${changes.length}건</b>`);
    for (const r of changes) {
      out.push(`${icon(r.a.key)} <b>${esc(r.h.symbol)}</b>${tag(r.h)}  ${r.old.label} → <b>${r.a.label}</b> (${score(r.a.score)})`);
      out.push(`    ${money(r.a.price)} (${pct(r.a.chgPct)})${r.a.plPct != null ? ` · 수익률 ${pct(r.a.plPct, 1)}` : ''}`);
      r.a.reasons.filter(x => x.pts).sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts)).slice(0, 2)
        .forEach(x => out.push(`    · ${esc(x.text)}`));
    }
  } else if (manual) {
    out.push('', live ? '장중이라 확정 신호가 없습니다. 아래는 현재 잠정 신호입니다.' : '어제와 달라진 신호가 없습니다.');
  }
  if (manual && rows.length) {
    out.push('', '<b>전체 신호</b>');
    for (const r of rows) out.push(`${icon(r.a.key)} ${esc(r.h.symbol)}${tag(r.h)} ${r.a.label} (${score(r.a.score)}) · ${money(r.a.price)}`);
  }
  if (errors.length) out.push('', `⚠️ 조회 실패: ${errors.map(esc).join(', ')}`);
  if (appUrl) out.push('', `<a href="${appUrl}">앱 열기</a>`);

  let text = out.join('\n');
  if (text.length > 4000) text = text.slice(0, text.lastIndexOf('\n', 3950)) + '\n…';  // 텔레그램 4096자 제한
  return text;
}

module.exports = { runCheck, buildMessage };
