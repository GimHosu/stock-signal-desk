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

module.exports = { missingConfig, hasStore, getJSON, setJSON, checkPassword, sanitizeHoldings, yahooChartUrl, fetchSeries, telegram, findChats, fetchFundamentals };
