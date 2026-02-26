import { handleHealth, setCorsHeaders, sendJson } from '../server.mjs';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    await handleHealth(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error?.message || 'Erro interno no servidor.' });
  }
}
