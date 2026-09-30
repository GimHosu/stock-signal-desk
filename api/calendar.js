// 증시 주요 일정 중 외부 데이터가 필요한 것: 이번 주 미국 경제지표 + 대형주 실적 발표(Finnhub)
// 휴장일·옵션 만기·FOMC 는 화면이 lib/calendar.js 로 직접 계산한다.
const { checkPassword, fetchCalendar } = require('../lib/server.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.APP_PASSWORD && !checkPassword(req)) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  try {
    return res.status(200).json(await fetchCalendar());
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
