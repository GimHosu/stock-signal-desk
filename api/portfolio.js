// 보유·관심 종목과 설정을 서버(Redis)에 저장/조회한다. 알림 기능과 여러 기기 동기화에 쓰인다.
// APP_PASSWORD 가 맞아야 접근할 수 있다.
const { missingConfig, getJSON, setJSON, checkPassword, sanitizeHoldings } = require('../lib/server.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const missing = missingConfig();
  if (missing.length) return res.status(503).json({ error: `서버 저장소가 설정되지 않았습니다: ${missing.join(', ')}` });
  if (!checkPassword(req)) return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });

  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getJSON('portfolio', { holdings: [], settings: null }));
    }
    if (req.method === 'PUT') {
      const body = req.body || {};
      const holdings = sanitizeHoldings(body.holdings);
      if (!holdings) return res.status(400).json({ error: '종목 목록 형식이 올바르지 않습니다.' });
      const s = body.settings || {};
      const settings = {
        stopPct: -Math.abs(Number(s.stopPct) || 8),
        takePct: Math.abs(Number(s.takePct) || 25),
      };
      await setJSON('portfolio', { holdings, settings, updatedAt: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'GET 또는 PUT만 지원합니다.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
