// Stock Signal Desk — NAS(Docker)용 서버. 외부 패키지 없이 Node 표준 라이브러리만 쓴다.
//  · 화면 파일(index.html, lib/*.js)을 제공하고
//  · Vercel 서버리스 함수(api/*.js)를 그대로 실행하고
//  · Vercel Cron 대신 정해진 시각에 토스 동기화·알림·스캔을 실행한다.
// 환경변수: PORT(8080) · BASE_PATH(예: /finance) · DATA_DIR(/data) 와 README 의 앱 설정값들
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Windows 에서 편집한 .env 는 줄 끝에 CR(\r)이나 공백·따옴표가 붙을 수 있어 값이 달라진다 → 시작할 때 정리
for (const k of Object.keys(process.env)) {
  const v = process.env[k], t = v.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (t !== v) process.env[k] = t;
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8080;
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, '');               // 하위 경로로 서비스할 때 (예: /finance)
if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(ROOT, 'data');     // 저장소 폴더 (Docker 에서는 /data 볼륨)
if (!process.env.CRON_SECRET) process.env.CRON_SECRET = crypto.randomBytes(24).toString('hex');   // 내부 스케줄러 인증용

const API = new Set(['chart', 'portfolio', 'alert', 'scan', 'universe', 'fundamentals', 'events', 'calendar', 'toss']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Vercel 의 res.status().json() 형태를 흉내 낸다
function helpers(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => (b !== null && typeof b === 'object' && !Buffer.isBuffer(b) ? res.json(b) : (res.end(b), res));
  return res;
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('요청 본문이 너무 큽니다.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  helpers(res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://localhost');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return res.status(400).end('Bad request'); }
  if (BASE) {
    if (p === BASE) { res.statusCode = 301; res.setHeader('Location', `${BASE}/${url.search}`); return res.end(); }
    if (p.startsWith(`${BASE}/`)) p = p.slice(BASE.length);   // 프록시가 경로 앞부분을 지우고 보내도 그대로 동작
  }
  try {
    if (p === '/healthz') return res.json({ ok: true });

    const m = p.match(/^\/api\/([a-z]+)\/?$/);
    if (m) {
      if (!API.has(m[1])) return res.status(404).json({ error: 'Not found' });
      req.query = Object.fromEntries(url.searchParams);
      req.body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const raw = await readBody(req);
        try { req.body = raw ? JSON.parse(raw) : {}; } catch { return res.status(400).json({ error: '요청 본문(JSON) 형식이 올바르지 않습니다.' }); }
      }
      return await require(path.join(ROOT, 'api', `${m[1]}.js`))(req, res);
    }

    // 정적 파일은 index.html 과 lib/*.js 만 내보낸다 (api 코드·.env·data 는 제공하지 않음)
    const file = p === '/' || p === '/index.html' ? 'index.html' : /^\/lib\/[a-z0-9_-]+\.js$/i.test(p) ? p.slice(1) : null;
    if (!file) return res.status(404).end('Not found');
    const buf = await fs.promises.readFile(path.join(ROOT, file));
    res.setHeader('Content-Type', TYPES[path.extname(file)]);
    res.setHeader('Cache-Control', file === 'index.html' ? 'no-cache' : 'public, max-age=300');
    return res.end(buf);
  } catch (e) {
    log('ERROR', req.method, p, e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message }); else res.end();
  }
});

// ────────────────────────── 스케줄러 (Vercel Cron 대체) ──────────────────────────
// 시각은 UTC. 평일(월~금) 기준, 미국 장 마감(서머타임 20:00 / 표준시 21:00 UTC) 뒤에 실행한다.
//   토스 동기화 21:45 → 신호 점검·텔레그램 22:00 (한국 07:00) → S&P 500 스캔 22:15
const JOBS = [
  { name: 'toss-sync', api: 'toss', method: 'POST', body: { action: 'sync' }, at: process.env.TOSS_SYNC_UTC || '21:45', enabled: () => require('../lib/toss.js').configured() },
  { name: 'daily-alert', api: 'alert', method: 'GET', at: process.env.ALERT_UTC || '22:00', enabled: () => true },
  { name: 'daily-scan', api: 'scan', method: 'GET', at: process.env.SCAN_UTC || '22:15', enabled: () => true },
];
async function runJob(job) {
  const req = { method: job.method, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, query: {}, body: job.body || {} };
  const out = { statusCode: 200 };
  const res = { setHeader() {}, getHeader() {}, status(c) { out.statusCode = c; return res; }, json(o) { out.body = o; return res; }, send(b) { out.body = b; return res; }, end() { return res; } };
  const started = Date.now();
  try {
    await require(path.join(ROOT, 'api', `${job.api}.js`))(req, res);
    const b = out.body || {};
    log(`[${job.name}] ${out.statusCode} ${Math.round((Date.now() - started) / 1000)}s`, b.error ? `오류: ${b.error}` : JSON.stringify(b).slice(0, 200));
  } catch (e) { log(`[${job.name}] 실패: ${e.message}`); }
}
const ran = new Map();
setInterval(() => {
  const now = new Date(), hm = now.toISOString().slice(11, 16), day = now.getUTCDay();
  if (day === 0 || day === 6) return;
  for (const job of JOBS) {
    const key = now.toISOString().slice(0, 10);
    if (job.at === hm && ran.get(job.name) !== key && job.enabled()) { ran.set(job.name, key); runJob(job); }
  }
}, 20 * 1000);

// 컨테이너를 새로 켰을 때 토스 동기화가 20시간 넘게 안 됐으면 한 번 실행
setTimeout(async () => {
  try {
    if (!require('../lib/toss.js').configured()) return;
    const last = await require('../lib/server.js').getJSON('toss:last', null);
    if (!last || Date.now() - Date.parse(last.at) > 20 * 36e5) runJob(JOBS[0]);
  } catch (e) { log('시작 시 토스 동기화 확인 실패:', e.message); }
}, 15 * 1000);

server.listen(PORT, () => {
  log(`Stock Signal Desk: http://0.0.0.0:${PORT}${BASE || ''}/  (데이터: ${process.env.DATA_DIR})`);
  const miss = require('../lib/server.js').missingConfig();
  if (miss.length) log('주의 — 설정 누락:', miss.join(', '));
  // .env 가 제대로 읽혔는지 확인용 (값은 출력하지 않음)
  const on = (k) => (process.env[k] ? '설정됨' : '없음');
  log(`설정 확인 — 비밀번호: ${on('APP_PASSWORD')} · 텔레그램: ${on('TELEGRAM_BOT_TOKEN')}/${on('TELEGRAM_CHAT_ID')} · Finnhub: ${on('FINNHUB_API_KEY')} · 토스: ${on('TOSS_CLIENT_ID')}/${on('TOSS_CLIENT_SECRET')}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('종료'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
