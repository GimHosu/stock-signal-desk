// 서버 전용 도우미: Redis(Upstash REST) 저장소, 비밀번호 확인, Yahoo 시세, 텔레그램 발송.
const crypto = require('crypto');
const Signal = require('./signal.js');

// Vercel 마켓플레이스의 Upstash 연동은 KV_REST_API_* 또는 UPSTASH_REDIS_REST_* 이름으로 환경변수를 넣는다.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const hasStore = () => !!(KV_URL && KV_TOKEN);

function missingConfig() {
  const m = [];
  if (!process.env.APP_PASSWORD) m.push('APP_PASSWORD');
  if (!KV_URL || !KV_TOKEN) m.push('Upstash Redis');
  return m;
}

async function redis(...args) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`저장소 오류: ${j.error || r.status}`);
  return j.result;
}
const getJSON = async (key, fallback) => { const v = await redis('GET', `ssd:${key}`); return v ? JSON.parse(v) : fallback; };
const setJSON = (key, value) => redis('SET', `ssd:${key}`, JSON.stringify(value));

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function checkPassword(req) {
  const pw = process.env.APP_PASSWORD;
  return !!pw && crypto.timingSafeEqual(sha(req.headers['x-app-password'] || ''), sha(pw));
}

function sanitizeHoldings(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter(h => h && /^[A-Z0-9.\-^=]{1,15}$/.test(String(h.symbol || '').toUpperCase()) && (h.watch || (h.shares > 0 && h.avgCost > 0)))
    .slice(0, 200)
    .map(h => h.watch
      ? { symbol: String(h.symbol).toUpperCase(), watch: true, shares: 0, avgCost: 0 }
      : { symbol: String(h.symbol).toUpperCase(), watch: false, shares: +h.shares, avgCost: +h.avgCost });
}

// events=div: 배당 기록도 함께 받아 배당수익률을 계산한다
const yahooChartUrl = (symbol) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false&events=div`;

async function fetchSeries(symbol) {
  const r = await fetch(yahooChartUrl(symbol), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(r.status === 404 ? '종목을 찾을 수 없음' : `시세 오류 ${r.status}`);
  return Signal.parseChart(await r.json(), symbol);
}

async function telegramCall(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 환경변수가 없습니다.');
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`텔레그램 오류: ${j.description || r.status}`);
  return j.result;
}
async function telegram(text) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!chat) throw new Error('TELEGRAM_CHAT_ID 환경변수가 없습니다.');
  await telegramCall('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
}
// 봇에게 메시지를 보낸 채팅 목록 → TELEGRAM_CHAT_ID 를 찾는 데 쓴다.
async function findChats() {
  const updates = await telegramCall('getUpdates', {});
  const seen = new Map();
  for (const u of updates) {
    const c = (u.message || u.edited_message || u.channel_post || {}).chat;
    if (c) seen.set(c.id, { id: c.id, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' });
  }
  return [...seen.values()];
}

// ────────────────────────── SEC 재무 데이터 ──────────────────────────
// SEC 는 연락처가 담긴 User-Agent 를 요구한다. data.sec.gov 는 기본값으로도 응답하지만,
// www.sec.gov 의 티커 목록(S&P 500 밖 종목용)은 SEC_USER_AGENT="이름 이메일" 환경변수가 있어야 받을 수 있다.
const SEC_UA = process.env.SEC_USER_AGENT || 'StockSignalDesk/1.0 personal-use';
const FUND_TTL = 7 * 864e5, TICKER_TTL = 30 * 864e5;

async function secJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`SEC 응답 오류 (${r.status})${r.status === 403 ? ' — SEC_USER_AGENT 환경변수에 "이름 이메일"을 넣어 주세요' : ''}`);
  return r.json();
}
async function cached(key, ttl, load) {
  if (hasStore()) { try { const c = await getJSON(key, null); if (c && Date.now() - c.at < ttl) return c.value; } catch {} }
  const value = await load();
  // '재무 정보 없음' 결과는 저장하지 않는다 (SEC_USER_AGENT 를 나중에 설정해도 바로 반영되도록)
  if (hasStore() && value != null && !value.unavailable) { try { await setJSON(key, { at: Date.now(), value }); } catch {} }
  return value;
}
async function cikFor(symbol) {
  const { UNIVERSE } = require('./scan.js');
  const hit = UNIVERSE.find(x => x[0] === symbol && x[3]);
  if (hit) return hit[3];
  if (hasStore()) { try { const u = await getJSON('universe', null); const s = u && u.list.find(x => x[0] === symbol && x[3]); if (s) return s[3]; } catch {} }
  if (!process.env.SEC_USER_AGENT) return null;                    // S&P 500 밖 종목은 SEC 티커 목록이 필요
  const map = await cached('sec:tickers', TICKER_TTL, async () => {
    const j = await secJSON('https://www.sec.gov/files/company_tickers.json');
    const m = {}; for (const k in j) m[j[k].ticker.toUpperCase().replace(/\./g, '-')] = j[k].cik_str; return m;
  });
  return map[symbol] || null;
}
async function fetchFundamentals(symbol) {
  const { extract } = require('./fundamentals.js');
  return cached(`fund:${symbol}`, FUND_TTL, async () => {
    const cik = await cikFor(symbol);
    if (!cik) return { unavailable: true, reason: process.env.SEC_USER_AGENT ? 'SEC에 등록된 미국 상장사가 아닙니다 (ETF·해외 기업 등).' : 'S&P 500 밖 종목은 SEC_USER_AGENT 환경변수를 설정하면 조회할 수 있습니다.' };
    const facts = await secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`);
    if (!facts) return { unavailable: true, reason: 'SEC 재무 데이터가 없습니다.' };
    try { return extract(facts); } catch (e) { return { unavailable: true, reason: e.message }; }
  });
}

// ────────────────────────── 실적 일정 & 뉴스 (Finnhub) ──────────────────────────
const EVENTS_TTL = 60 * 60 * 1000;   // 1시간
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
async function finnhub(path) {
  const r = await fetch(`https://finnhub.io/api/v1/${path}&token=${encodeURIComponent(process.env.FINNHUB_API_KEY)}`);
  if (r.status === 401 || r.status === 403) throw new Error('Finnhub API 키가 올바르지 않거나 이 데이터에 권한이 없습니다.');
  if (r.status === 429) throw new Error('Finnhub 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.');
  if (!r.ok) throw new Error(`Finnhub 응답 오류 (${r.status})`);
  return r.json();
}
// 뉴스 헤드라인 한국어 번역: DEEPL_API_KEY 가 있으면 DeepL(공식), 없으면 Google 번역 무료 엔드포인트(비공식).
// 실패하면 null → 화면은 영어 원문을 그대로 보여 준다.
async function translateKo(texts) {
  if (!texts.length) return [];
  if (process.env.DEEPL_API_KEY) {
    try {
      const key = process.env.DEEPL_API_KEY, host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
      const body = new URLSearchParams([...texts.map(t => ['text', t]), ['target_lang', 'KO'], ['source_lang', 'EN']]);
      const r = await fetch(`https://${host}/v2/translate`, { method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${key}` }, body });
      if (r.ok) { const j = await r.json(); return j.translations.map(x => x.text); }
    } catch {}
  }
  const gtx = async (q) => {
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json())[0].map(s => s[0]).join('');
  };
  try {   // 한 번에 보내고 줄바꿈으로 다시 나눈다
    const lines = (await gtx(texts.join('\n'))).split('\n').map(s => s.trim());
    if (lines.length === texts.length) return lines;
  } catch {}
  return Promise.all(texts.map(t => gtx(t).then(s => s.trim()).catch(() => null)));
}

async function fetchEvents(symbol) {
  if (!process.env.FINNHUB_API_KEY) return { unavailable: true, reason: 'FINNHUB_API_KEY 환경변수를 설정하면 실적 일정과 뉴스를 볼 수 있습니다.' };
  const { summarize } = require('./events.js');
  return cached(`events:v2:${symbol}`, EVENTS_TTL, async () => {
    const s = encodeURIComponent(symbol.replace(/-/g, '.'));   // Finnhub 표기: BRK-B → BRK.B
    const now = Date.now();
    const [cal, news] = await Promise.all([
      finnhub(`calendar/earnings?symbol=${s}&from=${ymd(now - 200 * 864e5)}&to=${ymd(now + 120 * 864e5)}`),
      finnhub(`company-news?symbol=${s}&from=${ymd(now - 7 * 864e5)}&to=${ymd(now)}`),
    ]);
    const out = summarize({ earnings: (cal && cal.earningsCalendar) || [], news: Array.isArray(news) ? news : [] }, now);
    const ko = await translateKo(out.news.items.map(x => x.headline));   // 심리 분류는 영어 원문 기준, 번역은 표시용
    out.news.items.forEach((x, i) => { x.ko = ko[i] || null; });
    return out;
  });
}

// ────────────────────────── 증시 일정 ──────────────────────────
// 경제지표: ForexFactory 무료 피드(이번 주, 키 불필요) · 대형주 실적: Finnhub(키가 있을 때)
async function fetchCalendar() {
  const Cal = require('./calendar.js');
  const econ = await cached('cal:econ', 3 * 36e5, async () => {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`경제 캘린더 응답 오류 (${r.status})`);
    return Cal.parseEconomic(await r.json());
  }).catch(() => []);   // 경제지표를 못 받아도 나머지 일정은 보여 준다
  const mega = !process.env.FINNHUB_API_KEY ? [] : await cached('cal:mega', 6 * 36e5, async () => {
    const now = Date.now();
    const j = await finnhub(`calendar/earnings?from=${ymd(now)}&to=${ymd(now + 21 * 864e5)}`);
    const set = new Set(Cal.MEGA);
    return (j.earningsCalendar || []).filter(x => set.has(x.symbol)).map(x => ({
      date: x.date, type: 'earn', impact: 'Medium', symbol: x.symbol.replace('.', '-'),
      title: `${x.symbol.replace('.', '-')} 실적 발표`, hour: x.hour || '', epsEstimate: x.epsEstimate ?? null,
    }));
  }).catch(() => []);
  return { at: Date.now(), economic: econ, earnings: mega };
}

module.exports = { missingConfig, hasStore, getJSON, setJSON, checkPassword, sanitizeHoldings, yahooChartUrl, fetchSeries, telegram, findChats, fetchFundamentals, fetchEvents, fetchCalendar };
