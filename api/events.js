// 실적 발표 일정 & 최근 7일 뉴스 심리 (Finnhub). Finnhub 무료 한도를 아끼려고 1시간 캐시한다.
// 앱 비밀번호가 설정돼 있으면 비밀번호가 맞을 때만 응답한다 (남이 내 API 한도를 쓰지 못하도록).
const { checkPassword, fetchEvents } = require('../lib/server.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.APP_PASSWORD && !checkPassword(req)) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return res.status(400).json({ error: '종목 코드 형식이 올바르지 않습니다.' });
  try {
    return res.status(200).json(await fetchEvents(symbol));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
