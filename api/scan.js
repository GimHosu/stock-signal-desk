// 종목 발굴 (S&P 500 스캔).
//  - GET  (x-app-password)                      → 저장된 최근 스캔 결과
//  - GET  (Vercel Cron, Bearer CRON_SECRET)     → 매일 장 마감 후 새로 스캔해 저장
//  - POST (x-app-password)                      → 지금 새로 스캔해 저장
const { missingConfig, getJSON, setJSON, checkPassword, fetchSeries } = require('../lib/server.js');
const { runScan } = require('../lib/scan.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const missing = missingConfig();
  if (missing.length) return res.status(503).json({ error: `서버 저장소가 설정되지 않았습니다: ${missing.join(', ')}` });
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && req.headers.authorization === `Bearer ${secret}`;
  if (!isCron && !checkPassword(req)) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });

  try {
    if (req.method === 'GET' && !isCron) {
      return res.status(200).json((await getJSON('scan', null)) || { results: null });
    }
    const previous = await getJSON('scan', null);
    const saved = await getJSON('universe', null);   // '목록 갱신'으로 저장한 목록이 있으면 그것을, 없으면 내장 목록을 스캔
    const scan = await runScan({ fetchSeries, universe: saved && saved.list, concurrency: 8, previous });
    if (scan.results.length < scan.total / 2) {
      throw new Error(`시세 조회 실패가 많습니다 (${scan.errors.length}/${scan.total}). 잠시 후 다시 시도해 주세요.`);
    }
    await setJSON('scan', scan);
    return res.status(200).json(scan);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
