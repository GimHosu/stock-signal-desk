// 텔레그램 알림.
//  - GET  (Vercel Cron, Authorization: Bearer CRON_SECRET) → 매일 장 마감 후 신호가 바뀐 종목만 발송
//  - POST {action:'test'} (x-app-password) → 테스트 메시지 / TELEGRAM_CHAT_ID 찾기
//  - POST {action:'run'}  (x-app-password) → 지금 점검하고 결과를 항상 발송
const { missingConfig, getJSON, setJSON, checkPassword, fetchSeries, telegram, findChats } = require('../lib/server.js');
const { runCheck } = require('../lib/alerts.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.authorization === `Bearer ${secret}`;
  if (!isCron && !checkPassword(req)) return res.status(401).json({ ok: false, error: '인증에 실패했습니다.' });

  const action = isCron ? 'daily' : (req.body && req.body.action);
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const appUrl = host ? `https://${host}` : null;

  try {
    if (action === 'test') {
      if (!process.env.TELEGRAM_BOT_TOKEN) return res.status(200).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN 환경변수가 없습니다.' });
      if (!process.env.TELEGRAM_CHAT_ID) return res.status(200).json({ ok: false, needChatId: true, chats: await findChats() });
      await telegram('✅ <b>Stock Signal Desk</b> 테스트 알림입니다.\n장 마감 후 신호가 바뀐 종목이 있으면 이 채팅으로 알려 드립니다.');
      return res.status(200).json({ ok: true });
    }
    if (action === 'daily' || action === 'run') {
      const missing = missingConfig();
      if (missing.length) throw new Error(`설정 누락: ${missing.join(', ')}`);
      const result = await runCheck({ getJSON, setJSON, fetchSeries, send: telegram, appUrl }, { manual: action === 'run' });
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(400).json({ ok: false, error: '알 수 없는 요청입니다.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
