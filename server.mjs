import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cwd, env } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(cwd());
const DOT_ENV_PATH = resolve(ROOT, '.env');

if (existsSync(DOT_ENV_PATH)) {
  const rawEnv = readFileSync(DOT_ENV_PATH, 'utf8');
  rawEnv.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !(key in env)) env[key] = value;
  });
}

const HOST = env.HOST || '0.0.0.0';
const PORT = Number(env.PORT || 8787);
const ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_AGENT_ID = env.ELEVENLABS_AGENT_ID || 'agent_3701khd9583qe1ctjzvqxtz38cfa';
const OPENAI_API_KEY = env.OPENAI_API_KEY || '';
const YT_DLP_BIN = env.YT_DLP_PATH || 'yt-dlp';
const ELEVENLABS_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const OPENAI_IMAGES_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const YT_DLP_HEALTH_TTL_MS = 60 * 1000;

let ytDlpHealthState = {
  checkedAt: 0,
  available: false,
  detail: 'not checked',
  command: YT_DLP_BIN
};
let ytDlpHealthPromise = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 260 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Payload too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const error = new Error('Invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function inferMimeTypeFromName(fileName, fallback = 'application/octet-stream') {
  const ext = extname(fileName || '').toLowerCase();
  return MIME_TYPES[ext] || fallback;
}

function parseDurationToSeconds(rawValue) {
  const direct = Number(rawValue);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const value = String(rawValue || '').trim();
  if (!value) return Number.NaN;
  if (!/^\d{1,3}:\d{1,2}(:\d{1,2})?$/.test(value)) return Number.NaN;
  const parts = value.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return Number.NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function isYoutubeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com');
  } catch (_error) {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 180000);
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_error) {
        // noop
      }
      rejectPromise(new Error(`${command} timed out.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const err = new Error(`${command} failed with exit code ${code}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      rejectPromise(err);
    });
  });
}

async function runYtDlp(args, options = {}) {
  const attempts = [];
  if (YT_DLP_BIN && YT_DLP_BIN !== 'yt-dlp') {
    attempts.push({ command: YT_DLP_BIN, args });
  } else {
    attempts.push({ command: 'yt-dlp', args });
    attempts.push({ command: 'python3', args: ['-m', 'yt_dlp', ...args] });
    attempts.push({ command: 'python', args: ['-m', 'yt_dlp', ...args] });
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await runCommand(attempt.command, attempt.args, options);
    } catch (error) {
      lastError = error;
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
  }

  const error = new Error(
    `yt-dlp não encontrado. Instale o binário ou módulo python (tentativas: ${attempts.map((a) => a.command).join(', ')})`
  );
  error.code = 'ENOENT';
  if (lastError) error.cause = lastError;
  throw error;
}

async function getYtDlpHealth(force = false) {
  const now = Date.now();
  if (!force && ytDlpHealthState.checkedAt && now - ytDlpHealthState.checkedAt < YT_DLP_HEALTH_TTL_MS) {
    return ytDlpHealthState;
  }
  if (ytDlpHealthPromise && !force) return ytDlpHealthPromise;

  ytDlpHealthPromise = (async () => {
    try {
      const result = await runYtDlp(['--version'], { timeoutMs: 10000 });
      const versionLine = String(result.stdout || result.stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || 'version unknown';
      ytDlpHealthState = {
        checkedAt: Date.now(),
        available: true,
        detail: versionLine,
        command: YT_DLP_BIN
      };
    } catch (error) {
      ytDlpHealthState = {
        checkedAt: Date.now(),
        available: false,
        detail: error?.message || 'yt-dlp unavailable',
        command: YT_DLP_BIN
      };
    } finally {
      ytDlpHealthPromise = null;
    }
    return ytDlpHealthState;
  })();

  return ytDlpHealthPromise;
}

async function buildHealthPayload() {
  const ytDlp = await getYtDlpHealth(false);
  const hasElevenLabsKey = Boolean(ELEVENLABS_API_KEY);
  return {
    ok: true,
    service: 'jv-video-studio',
    now: new Date().toISOString(),
    hasElevenLabsKey,
    hasOpenAiKey: Boolean(OPENAI_API_KEY),
    defaultAgentId: ELEVENLABS_AGENT_ID || null,
    directTranscribeReady: hasElevenLabsKey,
    youtubeMetadataReady: ytDlp.available,
    youtubeTranscribeReady: hasElevenLabsKey && ytDlp.available,
    imageGenerationReady: Boolean(OPENAI_API_KEY),
    ytDlp: {
      configured: ytDlp.command,
      available: ytDlp.available,
      detail: ytDlp.detail
    }
  };
}

function readUpstreamErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;
  return String(
    payload?.error?.message
    || payload?.detail?.message
    || payload?.message
    || payload?.error
    || fallback
  );
}

async function generateImageWithOpenAI({ prompt, apiKey, model, size }) {
  if (!apiKey) {
    const error = new Error('API key ausente para geração de imagem.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    const error = new Error('Prompt vazio para geração de imagem.');
    error.statusCode = 400;
    throw error;
  }

  const body = {
    model: String(model || 'gpt-image-1'),
    prompt: normalizedPrompt,
    size: String(size || '1024x1024'),
    n: 1
  };

  let upstream;
  try {
    upstream = await fetch(OPENAI_IMAGES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (_error) {
    const error = new Error('Falha de rede ao chamar provedor de imagem.');
    error.statusCode = 502;
    throw error;
  }

  const raw = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_error) {
    payload = { raw };
  }

  if (!upstream.ok) {
    const error = new Error(readUpstreamErrorMessage(payload, 'Erro ao gerar imagem no provedor.'));
    error.statusCode = upstream.status;
    error.upstream = payload;
    throw error;
  }

  const first = Array.isArray(payload?.data) ? payload.data[0] : null;
  const b64 = typeof first?.b64_json === 'string' ? first.b64_json : '';
  const url = typeof first?.url === 'string' ? first.url : '';

  if (!b64 && !url) {
    const error = new Error('Provedor não retornou imagem.');
    error.statusCode = 502;
    throw error;
  }

  return {
    provider: 'openai',
    model: body.model,
    size: body.size,
    imageDataUrl: b64 ? `data:image/png;base64,${b64}` : null,
    imageUrl: url || null
  };
}

async function fetchYoutubeMetadata(youtubeUrl) {
  if (!isYoutubeUrl(youtubeUrl)) {
    const error = new Error('youtubeUrl inválida.');
    error.statusCode = 400;
    throw error;
  }

  const ytDlpHealth = await getYtDlpHealth(false);
  if (!ytDlpHealth.available) {
    const error = new Error(`yt-dlp indisponível (${ytDlpHealth.command}).`);
    error.statusCode = 503;
    throw error;
  }

  let output;
  try {
    const result = await runYtDlp(
      ['--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json', youtubeUrl],
      { timeoutMs: 120000 }
    );
    output = String(result.stdout || '').trim();
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const detail = stderr ? stderr.split('\n').slice(-2).join(' | ') : '';
    const wrapped = new Error(detail || error.message || 'Falha ao ler metadados do YouTube.');
    wrapped.statusCode = 502;
    throw wrapped;
  }

  let payload;
  try {
    payload = JSON.parse(output);
  } catch (_error) {
    const error = new Error('yt-dlp retornou metadados inválidos.');
    error.statusCode = 502;
    throw error;
  }

  const duration = parseDurationToSeconds(payload.duration ?? payload.duration_string);
  if (!Number.isFinite(duration) || duration <= 0) {
    const error = new Error('Não foi possível determinar a duração do vídeo.');
    error.statusCode = 422;
    throw error;
  }

  return {
    ok: true,
    videoId: String(payload.id || '').trim() || null,
    title: String(payload.title || '').trim() || null,
    duration,
    durationString: String(payload.duration_string || '').trim() || null,
    uploader: String(payload.uploader || '').trim() || null,
    thumbnail: String(payload.thumbnail || '').trim() || null,
    webpageUrl: String(payload.webpage_url || youtubeUrl).trim(),
    extractor: String(payload.extractor_key || payload.extractor || 'youtube')
  };
}

async function downloadYoutubeAudio(youtubeUrl) {
  if (!isYoutubeUrl(youtubeUrl)) {
    throw new Error('youtubeUrl inválida para download automático.');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'jv-yt-'));
  const outTemplate = join(tempDir, 'audio.%(ext)s');

  try {
    await runYtDlp(
      [
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--socket-timeout',
        '20',
        '--newline',
        '-f',
        'bestaudio[abr<=128]/bestaudio[ext=m4a]/bestaudio/best',
        '-o',
        outTemplate,
        youtubeUrl
      ],
      { timeoutMs: 240000, cwd: tempDir }
    );

    const files = (await readdir(tempDir))
      .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'))
      .map((name) => ({ name, abs: join(tempDir, name) }));

    if (!files.length) {
      throw new Error('yt-dlp não gerou arquivo de áudio.');
    }

    let chosen = files[0];
    let chosenStat = await stat(chosen.abs);
    for (const file of files.slice(1)) {
      const fileStat = await stat(file.abs);
      if (fileStat.size > chosenStat.size) {
        chosen = file;
        chosenStat = fileStat;
      }
    }

    if (chosenStat.size > 140 * 1024 * 1024) {
      throw new Error(
        `Áudio muito grande para transcrição (${Math.round(chosenStat.size / 1024 / 1024)}MB). ` +
        'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
      );
    }

    const buffer = await readFile(chosen.abs);
    if (!buffer.length) {
      throw new Error('Arquivo de áudio baixado está vazio.');
    }

    return {
      buffer,
      fileName: chosen.name,
      mimeType: inferMimeTypeFromName(chosen.name, 'audio/mp4')
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error('yt-dlp não encontrado. Instale o binário (`brew install yt-dlp`) ou `python3 -m pip install -U yt-dlp`.');
    }
    const stderr = String(error?.stderr || '').trim();
    const summary = stderr ? stderr.split('\n').slice(-2).join(' | ') : '';
    throw new Error(summary || error.message || 'Falha ao baixar áudio do YouTube.');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeBufferWithElevenLabs({
  mediaBuffer,
  fileName,
  mimeType,
  modelId,
  languageCode
}) {
  if (!mediaBuffer || !mediaBuffer.length) {
    throw new Error('Arquivo vazio para transcrição.');
  }
  if (mediaBuffer.length > 140 * 1024 * 1024) {
    throw new Error('Arquivo muito grande. Envie no máximo ~140MB por requisição.');
  }

  const formData = new FormData();
  formData.append('file', new Blob([mediaBuffer], { type: mimeType || 'audio/mp4' }), fileName || `media-${Date.now()}.mp4`);
  formData.append('model_id', modelId || 'scribe_v1');
  formData.append('timestamps_granularity', 'word');
  formData.append('tag_audio_events', 'false');
  formData.append('diarize', 'false');
  if (languageCode) formData.append('language_code', languageCode);

  let upstream;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    upstream = await fetch(ELEVENLABS_ENDPOINT, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      },
      body: formData,
      signal: controller.signal
    });
  } catch (_error) {
    const err = new Error(_error?.name === 'AbortError'
      ? 'Timeout ao chamar ElevenLabs (120s). Tente novamente.'
      : 'Falha de rede ao chamar ElevenLabs.');
    err.statusCode = _error?.name === 'AbortError' ? 504 : 502;
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (_error) {
    payload = { raw: rawText };
  }

  if (!upstream.ok) {
    const err = new Error(payload?.detail?.message || payload?.message || payload?.error || 'Erro na API da ElevenLabs.');
    err.statusCode = upstream.status;
    err.upstream = payload;
    throw err;
  }

  return payload;
}

function getSafePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const cleaned = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const requested = cleaned === '/' ? '' : cleaned;
  const absolute = resolve(join(ROOT, requested));
  if (!absolute.startsWith(ROOT)) return null;
  return absolute;
}

function pickDefaultHtml() {
  const generatedPath = join(ROOT, 'generated-page (1).html');
  const indexPath = join(ROOT, 'index.html');
  if (existsSync(generatedPath)) return generatedPath;
  if (existsSync(indexPath)) return indexPath;
  return null;
}

async function serveStatic(req, res, pathname) {
  const safePath = getSafePath(pathname);
  if (!safePath) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let targetPath = safePath;
  if (pathname === '/' || pathname === '') {
    const defaultPath = pickDefaultHtml();
    if (!defaultPath) {
      res.statusCode = 404;
      res.end('No default HTML file found.');
      return;
    }
    targetPath = defaultPath;
  }

  let fileInfo;
  try {
    fileInfo = await stat(targetPath);
  } catch (_error) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  if (fileInfo.isDirectory()) {
    const indexPath = join(targetPath, 'index.html');
    try {
      await stat(indexPath);
      targetPath = indexPath;
    } catch (_error) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
  }

  const ext = extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  createReadStream(targetPath).pipe(res);
}

async function handleTranscribe(req, res) {
  if (!ELEVENLABS_API_KEY) {
    sendJson(res, 500, {
      error: 'ELEVENLABS_API_KEY não definida. Exporte a variável antes de iniciar o servidor.'
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const base64Data = String(body.base64Data || '');
  const youtubeUrl = String(body.youtubeUrl || '').trim();
  const requestedFileName = String(body.fileName || `media-${Date.now()}.mp4`);
  const requestedMimeType = String(body.mimeType || 'video/mp4');
  const modelId = String(body.modelId || 'scribe_v1');
  const languageCode = body.languageCode ? String(body.languageCode) : '';

  if (!base64Data && !youtubeUrl) {
    sendJson(res, 400, { error: 'Envie base64Data ou youtubeUrl para transcrição.' });
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[transcribe] request start source=${youtubeUrl ? 'youtube' : 'upload'} model=${modelId}`);

  let mediaBuffer;
  let fileName = requestedFileName;
  let mimeType = requestedMimeType;
  try {
    if (youtubeUrl) {
      const downloaded = await downloadYoutubeAudio(youtubeUrl);
      mediaBuffer = downloaded.buffer;
      fileName = downloaded.fileName;
      mimeType = downloaded.mimeType;
    } else {
      mediaBuffer = Buffer.from(base64Data, 'base64');
      if (!mediaBuffer.length) throw new Error('Arquivo base64 inválido ou vazio.');
    }
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Falha ao preparar mídia para transcrição.' });
    return;
  }

  try {
    const payload = await transcribeBufferWithElevenLabs({
      mediaBuffer,
      fileName,
      mimeType,
      modelId,
      languageCode
    });
    // eslint-disable-next-line no-console
    console.log('[transcribe] request success');
    sendJson(res, 200, payload);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[transcribe] request failed:', error?.message || error);
    const rawMessage = String(error?.message || 'Erro na API da ElevenLabs.');
    const paymentIssue = /failed or incomplete payment|invoice|payment/i.test(rawMessage);
    sendJson(res, paymentIssue ? 402 : (error.statusCode || 502), {
      error: paymentIssue
        ? 'ElevenLabs bloqueou a transcrição por pagamento pendente na conta. Regularize a fatura e tente novamente.'
        : rawMessage,
      ...(error.upstream ? { upstream: error.upstream } : {})
    });
  }
}

async function handleYoutubeMetadata(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 256 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const youtubeUrl = String(body.youtubeUrl || '').trim();
  if (!youtubeUrl) {
    sendJson(res, 400, { error: 'youtubeUrl é obrigatória.' });
    return;
  }

  try {
    const metadata = await fetchYoutubeMetadata(youtubeUrl);
    sendJson(res, 200, metadata);
  } catch (error) {
    sendJson(res, error.statusCode || 502, { error: error.message || 'Falha ao buscar metadados do YouTube.' });
  }
}

async function handleAgentSignedUrl(req, res, requestUrl) {
  const requestedAgentId = String(requestUrl.searchParams.get('agentId') || ELEVENLABS_AGENT_ID || '').trim();
  if (!requestedAgentId) {
    sendJson(res, 400, { error: 'agentId ausente.' });
    return;
  }

  if (!ELEVENLABS_API_KEY) {
    sendJson(res, 500, {
      error: 'ELEVENLABS_API_KEY não definida para gerar signed URL do agent.'
    });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${ELEVENLABS_SIGNED_URL_ENDPOINT}?agent_id=${encodeURIComponent(requestedAgentId)}`, {
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });
  } catch (_error) {
    sendJson(res, 502, { error: 'Falha de rede ao buscar signed URL do agent.' });
    return;
  }

  const raw = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_error) {
    payload = { raw };
  }

  if (!upstream.ok) {
    sendJson(res, upstream.status, {
      error: payload?.detail?.message || payload?.message || payload?.error || 'Erro ao gerar signed URL.',
      upstream: payload
    });
    return;
  }

  if (!payload?.signed_url) {
    sendJson(res, 502, { error: 'Resposta sem signed_url.' });
    return;
  }

  sendJson(res, 200, {
    signed_url: payload.signed_url,
    agentId: requestedAgentId
  });
}

async function handleComplementImage(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const provider = String(body.provider || 'openai').trim().toLowerCase();
  const prompt = String(body.prompt || '').trim();
  const model = String(body.model || 'gpt-image-1').trim();
  const size = String(body.size || '1024x1024').trim();
  const requestKey = String(body.apiKey || '').trim();

  if (!prompt) {
    sendJson(res, 400, { error: 'prompt é obrigatório.' });
    return;
  }
  if (provider !== 'openai') {
    sendJson(res, 400, { error: 'provider não suportado. Use: openai' });
    return;
  }

  const apiKey = requestKey || OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(res, 400, { error: 'API key ausente. Salve sua key na aba Complementar Vídeo ou configure OPENAI_API_KEY.' });
    return;
  }

  try {
    const result = await generateImageWithOpenAI({ prompt, apiKey, model, size });
    sendJson(res, 200, {
      ok: true,
      prompt,
      ...result
    });
  } catch (error) {
    sendJson(res, error.statusCode || 502, {
      error: error.message || 'Falha ao gerar imagem.',
      ...(error.upstream ? { upstream: error.upstream } : {})
    });
  }
}

async function handleHealth(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const payload = await buildHealthPayload();
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 200, {
      ok: true,
      service: 'jv-video-studio',
      now: new Date().toISOString(),
      hasElevenLabsKey: Boolean(ELEVENLABS_API_KEY),
      hasOpenAiKey: Boolean(OPENAI_API_KEY),
      directTranscribeReady: Boolean(ELEVENLABS_API_KEY),
      youtubeMetadataReady: false,
      youtubeTranscribeReady: false,
      imageGenerationReady: Boolean(OPENAI_API_KEY),
      ytDlp: {
        configured: YT_DLP_BIN,
        available: false,
        detail: error?.message || 'Unable to probe yt-dlp.'
      }
    });
  }
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = requestUrl;

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (pathname === '/health' || pathname === '/api/health') {
    await handleHealth(req, res);
    return;
  }

  if (pathname === '/api/youtube/metadata') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleYoutubeMetadata(req, res);
    return;
  }

  if (pathname === '/api/transcribe') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleTranscribe(req, res);
    return;
  }

  if (pathname === '/api/agent/signed-url') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleAgentSignedUrl(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/complement/image') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleComplementImage(req, res);
    return;
  }

  await serveStatic(req, res, pathname);
}

function createRequestListener() {
  return (req, res) => {
    handleRequest(req, res).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[server] unhandled request error:', error?.stack || error?.message || error);
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Erro interno no servidor.' });
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch (_closeError) {
        // noop
      }
    });
  };
}

function startLocalServer() {
  const server = createServer(createRequestListener());

  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[server] unhandledRejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    // eslint-disable-next-line no-console
    console.error('[server] uncaughtException:', error?.stack || error?.message || error);
  });

  server.listen(PORT, HOST, () => {
    const base = `http://localhost:${PORT}`;
    // eslint-disable-next-line no-console
    console.log(`[server] running on ${base}`);
    // eslint-disable-next-line no-console
    console.log(`[server] health: ${base}/health`);
    // eslint-disable-next-line no-console
    console.log(ELEVENLABS_API_KEY
      ? '[server] ELEVENLABS_API_KEY detected: transcription and agent endpoints enabled'
      : '[server] ELEVENLABS_API_KEY missing: set it in .env to enable /api/transcribe and /api/agent/signed-url');
    // eslint-disable-next-line no-console
    console.log(OPENAI_API_KEY
      ? '[server] OPENAI_API_KEY detected: /api/complement/image enabled with env fallback'
      : '[server] OPENAI_API_KEY missing: Complement image generation expects key from UI request');
    // eslint-disable-next-line no-console
    console.log(`[server] YouTube auto-transcribe uses ${YT_DLP_BIN} (configure YT_DLP_PATH if needed)`);
  });

  return server;
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) startLocalServer();

export {
  setCorsHeaders,
  sendJson,
  buildHealthPayload,
  handleHealth,
  handleTranscribe,
  handleYoutubeMetadata,
  handleAgentSignedUrl,
  handleComplementImage,
  handleRequest,
  startLocalServer
};
