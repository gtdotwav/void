import { handleAgentSignedUrl, sendJson, setCorsHeaders } from '../../server.mjs';

function toRequestUrl(req) {
  const origin = `http://${req.headers.host || 'localhost'}`;
  return new URL(req.url || '/api/agent/signed-url', origin);
}

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
    await handleAgentSignedUrl(req, res, toRequestUrl(req));
  } catch (error) {
    sendJson(res, 500, { error: error?.message || 'Erro interno no servidor.' });
  }
}
