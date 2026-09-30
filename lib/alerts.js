// 장 마감 신호 점검 — 저장소·시세·발송 함수를 주입받아 동작한다 (서버 의존성 없음, 테스트 용이).
const { analyze, pct, DEFAULT_SETTINGS, SIGNAL_VERSION } = require('./signal.js');

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const isLive = (d, nowSec) => { const p = d.period && d.period.regular; return !!p && nowSec >= p.start && nowSec < p.end; };

// signals 저장 형식: { AAPL: { label, key, score, day: 'YYYY-MM-DD' } } — 거래일마다 확정 신호 1개
// 실행 기록: lastRun:cron / lastRun:manual — 설정 화면에서 "마지막 자동 점검" 으로 보여 준다
async function runCheck(deps, { manual = false } = {}) {
  const { setJSON, now = Date.now() } = deps;
  const trigger = manual ? 'manual' : 'cron';
  try {
    const r = await check(deps, { manual });
    await setJSON(`lastRun:${trigger}`, { at: new Date(now).toISOString(), ok: true, ...r });
    return r;
  } catch (e) {
    await setJSON(`lastRun:${trigger}`, { at: new Date(now).toISOString(), ok: false, error: e.message }).catch(() => {});
    throw e;
  }
}

// 7일 안에 실적을 발표하는 종목 (Finnhub 키가 있을 때만)
async function upcomingEarnings(list, fetchEvents) {
  if (!fetchEvents) return [];
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const h = list[i++];
      try { const e = await fetchEvents(h.symbol); const n = e && !e.unavailable && e.earnings.next; if (n && n.daysTo >= 0 && n.daysTo <= 7) out.push({ h, n }); } catch {}
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out.sort((a, b) => a.n.date < b.n.date ? -1 : 1);
}

async function check({ getJSON, setJSON, fetchSeries, fetchEvents, send, appUrl, now = Date.now() }, { manual }) {
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
  let live = false, day = null, fresh = 0, baseline = 0;
  for (const r of rows) {
    // 점수 체계가 바뀌기 전의 기록은 비교하지 않고 새 기준값으로 다시 시작
    const sym = r.h.symbol, old = prev[sym] && prev[sym].v === SIGNAL_VERSION ? prev[sym] : null;
    if (isLive(r.d, now / 1000)) { live = true; if (old) next[sym] = old; continue; } // 장중 잠정 신호는 기록하지 않음
    day = r.d.tradeDay;
    if (old && old.day === day) { next[sym] = old; continue; }                      // 이 거래일은 이미 처리됨 (휴장일·중복 실행)
    fresh++;
    if (!old) baseline++;                                                            // 처음 보는 종목: 기준값만 기록
    else if (old.label !== r.a.label) changes.push({ ...r, old });
    next[sym] = { v: SIGNAL_VERSION, label: r.a.label, key: r.a.key, score: r.a.score, grade: r.a.grade, day };
  }
  for (const h of list) if (!next[h.symbol] && prev[h.symbol]) next[h.symbol] = prev[h.symbol]; // 조회 실패 종목은 이전 값 유지
  await setJSON('signals', next);

  // 수동 점검은 항상, 자동 점검은 신호 변경이 있거나 '매일 요약 받기'가 켜져 있을 때 발송
  const summary = manual || !!settings.dailySummary;
  const sent = changes.length > 0 || summary;
  const upcoming = sent ? await upcomingEarnings(list, fetchEvents) : [];
  if (sent) await send(buildMessage({ rows, changes, errors, summary, live, day, fresh, baseline, upcoming, appUrl }));
  return {
    checked: rows.length, day, live, fresh, baseline, errors, sent, upcoming: upcoming.length,
    changes: changes.map(c => ({ symbol: c.h.symbol, from: c.old.label, to: c.a.label })),
  };
}

function buildMessage({ rows, changes, errors, summary, live, day, fresh, baseline, upcoming = [], appUrl }) {
  const icon = (k) => k === 'buy' ? '🟢' : k === 'sell' ? '🔴' : '⚪';
  const score = (a) => `${a.score}점·${a.grade}`;
  const money = (v) => '$' + v.toFixed(2);
  const tag = (h) => h.watch ? ' (관심)' : '';
  const out = [`📊 <b>Stock Signal Desk</b> · ${live ? '장중 잠정 신호' : `${day || ''} 장 마감`}`];

  if (changes.length) {
    out.push('', `<b>신호 변경 ${changes.length}건</b>`);
    for (const r of changes) {
      out.push(`${icon(r.a.key)} <b>${esc(r.h.symbol)}</b>${tag(r.h)}  ${r.old.label} → <b>${r.a.label}</b> (${r.old.score}→${score(r.a)})`);
      out.push(`    ${money(r.a.price)} (${pct(r.a.chgPct)})${r.a.plPct != null ? ` · 수익률 ${pct(r.a.plPct, 1)}` : ''}`);
      out.push(`    진입 ${money(r.a.plan.entry)} · 목표 ${money(r.a.plan.tp)} · 손절 ${money(r.a.plan.sl)}`);
      r.a.reasons.filter(x => x.pts).sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts)).slice(0, 2)
        .forEach(x => out.push(`    · ${esc(x.text)}`));
    }
  } else if (summary) {
    const note = live ? '장중이라 확정 신호가 없습니다. 아래는 현재 잠정 신호입니다.'
      : !fresh ? '새 거래일 데이터가 없습니다 (미국 증시 휴장일이거나 이미 점검한 날입니다).'
      : baseline < fresh ? '어제와 달라진 신호가 없습니다.' : '';
    if (note) out.push('', note);
  }
  if (summary && baseline) {
    if (out.length === 1) out.push('');   // 제목 바로 아래면 한 줄 띄움
    out.push(`처음 점검한 종목 ${baseline}개는 오늘 신호를 기준으로 기록했습니다. 다음 거래일부터 변경 여부를 비교합니다.`);
  }
  if (summary && rows.length) {
    out.push('', '<b>전체 신호</b>');
    for (const r of rows) out.push(`${icon(r.a.key)} ${esc(r.h.symbol)}${tag(r.h)} ${r.a.label} (${score(r.a)}) · ${money(r.a.price)}`);
  }
  if (upcoming.length) {
    out.push('', '<b>📅 7일 안에 실적 발표</b>');
    for (const { h, n } of upcoming) {
      const [, mo, dd] = n.date.split('-');
      out.push(`• ${esc(h.symbol)}${tag(h)} ${+mo}/${+dd} ${n.hourText} (${n.daysTo === 0 ? '오늘' : `D-${n.daysTo}`})${n.epsEstimate != null ? ` · 예상 EPS $${n.epsEstimate.toFixed(2)}` : ''}`);
    }
  }
  if (errors.length) out.push('', `⚠️ 조회 실패: ${errors.map(esc).join(', ')}`);
  if (appUrl) out.push('', `<a href="${appUrl}">앱 열기</a>`);

  let text = out.join('\n');
  if (text.length > 4000) text = text.slice(0, text.lastIndexOf('\n', 3950)) + '\n…';  // 텔레그램 4096자 제한
  return text;
}

module.exports = { runCheck, buildMessage };
