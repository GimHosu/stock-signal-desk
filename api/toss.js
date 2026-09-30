// 토스증권 보유 종목 동기화
//  - GET  (x-app-password)             → { configured, last } 마지막 동기화 결과
//  - POST {action:'sync'} (x-app-password 또는 내부 스케줄러 Bearer CRON_SECRET) → 지금 동기화
const { missingConfig, getJSON, setJSON, checkPassword } = require('../lib/server.js');
const toss = require('../lib/toss.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.authorization === `Bearer ${secret}`;
  if (!isCron && !checkPassword(req)) return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });
  const missing = missingConfig();
  if (missing.length) return res.status(503).json({ ok: false, error: `설정 누락: ${missing.join(', ')}` });

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, configured: toss.configured(), last: await getJSON('toss:last', null) });
    }
    if (!toss.configured()) return res.status(400).json({ ok: false, error: 'TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 환경변수가 없습니다.' });
    return res.status(200).json({ ok: true, ...(await toss.syncPortfolio({ getJSON, setJSON })) });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }
};
