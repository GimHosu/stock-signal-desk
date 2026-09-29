// S&P 500 구성 종목 목록 (종목 발굴 스캔 대상).
//  - GET  (x-app-password) → 현재 쓰는 목록 정보 { source: 'saved' | 'builtin', at, count }
//  - POST (x-app-password) → 위키백과에서 최신 목록을 받아 저장하고 편입/편출 종목을 돌려준다
const { missingConfig, getJSON, setJSON, checkPassword } = require('../lib/server.js');
const { UNIVERSE, fetchUniverse, diffUniverse } = require('../lib/scan.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const missing = missingConfig();
  if (missing.length) return res.status(503).json({ error: `서버 저장소가 설정되지 않았습니다: ${missing.join(', ')}` });
  if (!checkPassword(req)) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });

  try {
    const saved = await getJSON('universe', null);
    const current = saved ? saved.list : UNIVERSE;
    if (req.method === 'GET') {
      return res.status(200).json({ source: saved ? 'saved' : 'builtin', at: saved ? saved.at : null, count: current.length });
    }
    if (req.method === 'POST') {
      // 위키미디어는 봇 요청에 설명이 담긴 User-Agent 를 요구한다
      const list = await fetchUniverse(fetch, { 'User-Agent': 'StockSignalDesk/1.0 (personal portfolio app)' });
      const at = new Date().toISOString();
      await setJSON('universe', { at, list });
      return res.status(200).json({ source: 'saved', at, count: list.length, ...diffUniverse(current, list) });
    }
    return res.status(405).json({ error: 'GET 또는 POST만 지원합니다.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
