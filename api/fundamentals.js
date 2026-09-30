// 재무 정보 (SEC 공시 기준 최근 4분기): 순이익·EPS·매출·영업이익률·매출 성장률
// 공개 데이터라 비밀번호 없이 조회한다. 결과는 서버 저장소(있으면)와 CDN 에 캐시한다.
const { fetchFundamentals } = require('../lib/server.js');

module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) return res.status(400).json({ error: '종목 코드 형식이 올바르지 않습니다.' });
  try {
    const f = await fetchFundamentals(symbol);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(f);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
