// 토스증권 Open API — 보유 종목 동기화 전용. 조회 API(계좌·보유 주식)만 부르고 주문 API 는 절대 쓰지 않는다.
// 필요 환경변수: TOSS_CLIENT_ID, TOSS_CLIENT_SECRET (토스증권 WTS > 설정 > Open API 에서 발급)
// 토스는 등록된 허용 IP 에서만 응답하므로 IP 가 고정된 곳(집 NAS 등)에서 실행해야 한다.
const BASE = process.env.TOSS_API_BASE || 'https://openapi.tossinvest.com';

const configured = () => !!(process.env.TOSS_CLIENT_ID && process.env.TOSS_CLIENT_SECRET);

// 클라이언트당 유효한 토큰은 1개뿐이라(새로 받으면 이전 것은 무효) 만료 전까지 재사용한다.
let tok = null;
async function token() {
  if (tok && Date.now() < tok.exp - 60e3) return tok.value;
  const r = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.TOSS_CLIENT_ID, client_secret: process.env.TOSS_CLIENT_SECRET }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw await tossError(r, j, '토큰 발급');
  tok = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tok.value;
}

async function get(path, account, retry = true) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${await token()}`, ...(account != null ? { 'X-Tossinvest-Account': String(account) } : {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && retry) { tok = null; return get(path, account, false); }   // 만료·무효 토큰 → 한 번 재발급
  if (!r.ok) throw await tossError(r, j, path);
  return j.result;
}

async function publicIp() {
  try { const r = await fetch('https://api.ipify.org?format=json'); return (await r.json()).ip; } catch { return null; }
}
async function tossError(r, j, what) {
  const code = (j.error && j.error.code) || (typeof j.error === 'string' ? j.error : '') || '';
  const msg = (j.error && j.error.message) || j.error_description || '';
  if (r.status === 403) {
    const ip = await publicIp();
    return new Error(`토스증권이 접속을 차단했습니다 (403). 토스증권 WTS > 설정 > Open API > 허용 IP 관리에 이 서버의 공인 IP${ip ? ` ${ip}` : ''}를 등록해 주세요.`);
  }
  if (r.status === 401) return new Error(`토스증권 인증에 실패했습니다 (${code || '401'}). TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 을 확인해 주세요.${msg ? ` (${msg})` : ''}`);
  if (r.status === 429) return new Error('토스증권 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.');
  return new Error(`토스증권 ${what} 오류 (${r.status}${code ? ` ${code}` : ''})${msg ? `: ${msg}` : ''}`);
}

// 모든 종합매매 계좌의 미국 주식 보유분을 합친다 (같은 종목은 수량 합산, 평균가는 가중 평균)
async function fetchUsHoldings() {
  const accounts = (await get('/api/v1/accounts')) || [];
  const brokerage = accounts.filter(a => !a.accountType || a.accountType === 'BROKERAGE');
  const merged = new Map();
  let skippedKr = 0;
  for (const a of brokerage) {
    const ov = (await get('/api/v1/holdings', a.accountSeq)) || {};
    for (const it of ov.items || []) {
      if (it.marketCountry !== 'US') { skippedKr++; continue; }
      const symbol = String(it.symbol || '').toUpperCase().replace(/[./]/g, '-');   // Yahoo 표기: BRK.B → BRK-B
      const qty = Number(it.quantity), avg = Number(it.averagePurchasePrice);
      if (!symbol || !(qty > 0) || !(avg > 0)) continue;
      const m = merged.get(symbol) || { shares: 0, cost: 0 };
      m.shares += qty; m.cost += qty * avg;
      merged.set(symbol, m);
    }
  }
  return {
    accounts: brokerage.length, skippedKr,
    holdings: [...merged].map(([symbol, m]) => ({ symbol, shares: +m.shares.toFixed(6), avgCost: +(m.cost / m.shares).toFixed(4) })),
  };
}

// 앱의 종목 목록에 반영: 보유 종목은 토스와 똑같이 맞추고(토스에 없으면 삭제), 관심 종목은 그대로 둔다.
async function syncPortfolio({ getJSON, setJSON, now = Date.now() }) {
  const at = new Date(now).toISOString();
  try {
    const t = await fetchUsHoldings();
    if (!t.accounts) throw new Error('토스증권 종합매매 계좌를 찾지 못했습니다.');
    const p = await getJSON('portfolio', { holdings: [], settings: null });
    const incoming = new Map(t.holdings.map(h => [h.symbol, h]));
    const next = [], added = [], updated = [], removed = [];
    for (const h of p.holdings || []) {
      const n = incoming.get(h.symbol);
      if (n) {
        if (h.watch) added.push(h.symbol);   // 관심 종목이었는데 매수함 → 보유로
        else if (Math.abs(h.shares - n.shares) > 1e-9 || Math.abs(h.avgCost - n.avgCost) > 1e-6) updated.push(`${h.symbol} ${h.shares}→${n.shares}주`);
        next.push({ symbol: h.symbol, watch: false, shares: n.shares, avgCost: n.avgCost });
        incoming.delete(h.symbol);
      } else if (h.watch) next.push(h);
      else removed.push(h.symbol);           // 토스에 없는 보유 종목(전량 매도) → 삭제
    }
    for (const n of incoming.values()) { next.push({ symbol: n.symbol, watch: false, shares: n.shares, avgCost: n.avgCost }); added.push(n.symbol); }
    await setJSON('portfolio', { ...p, holdings: next, updatedAt: at, syncedFrom: 'toss' });
    const rec = { at, ok: true, count: t.holdings.length, skippedKr: t.skippedKr, added, updated, removed };
    await setJSON('toss:last', rec);
    return rec;
  } catch (e) {
    const rec = { at, ok: false, error: e.message };
    await setJSON('toss:last', rec).catch(() => {});
    throw e;
  }
}

module.exports = { configured, fetchUsHoldings, syncPortfolio };
