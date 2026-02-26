import { handleAutomationSnapshot, sendJson, setCorsHeaders } from '../../server.mjs';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    await handleAutomationSnapshot(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error?.message || 'Erro interno no servidor.' });
  }
}
