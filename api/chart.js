// Vercel 서버리스 함수: Yahoo Finance 일봉 데이터를 받아 그대로 전달한다.
// 브라우저에서 Yahoo를 직접 호출하면 CORS로 막히기 때문에 이 프록시를 거친다.
module.exports = async (req, res) => {
  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol)) {
    return res.status(400).json({ error: '종목 코드 형식이 올바르지 않습니다.' });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) {
      const notFound = r.status === 404;
      return res.status(notFound ? 404 : 502).json({
        error: notFound ? `'${symbol}' 종목을 찾을 수 없습니다.` : `시세 서버 오류 (${r.status})`,
      });
    }
    const body = await r.text();
    // 15분 동안 CDN 캐시 → 같은 종목을 여러 번 열어도 Yahoo 호출이 늘지 않음
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(body);
  } catch (e) {
    return res.status(502).json({ error: '시세 서버에 연결하지 못했습니다.' });
  }
};
