// 서버 전용 도우미: Redis(Upstash REST) 저장소, 비밀번호 확인, Yahoo 시세, 텔레그램 발송.
const crypto = require('crypto');
const Signal = require('./signal.js');

// Vercel 마켓플레이스의 Upstash 연동은 KV_REST_API_* 또는 UPSTASH_REDIS_REST_* 이름으로 환경변수를 넣는다.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

const yahooChartUrl = (symbol) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`;

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

module.exports = { missingConfig, getJSON, setJSON, checkPassword, sanitizeHoldings, yahooChartUrl, fetchSeries, telegram, findChats };
