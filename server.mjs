import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { arch, cwd, env } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createAutomationEngine } from './lib/automation-engine.mjs';
import { createKeyVault } from './lib/key-vault.mjs';

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
const YOUTUBE_COOKIES = env.YOUTUBE_COOKIES || env.YT_DLP_COOKIES || '';
const YOUTUBE_COOKIES_BASE64 = env.YOUTUBE_COOKIES_BASE64 || '';
const YT_DLP_BIN = env.YT_DLP_PATH || 'yt-dlp';
const YT_DLP_JS_RUNTIMES = String(env.YT_DLP_JS_RUNTIMES || 'node').trim();
const ELEVENLABS_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';
const OPENAI_IMAGES_ENDPOINT = 'https://api.openai.com/v1/images/generations';
const YT_DLP_HEALTH_TTL_MS = 60 * 1000;
const YT_DLP_HEALTH_TIMEOUT_MS = Number(env.YT_DLP_HEALTH_TIMEOUT_MS || 3500);
const IS_SERVERLESS_RUNTIME = Boolean(env.VERCEL || env.VERCEL_ENV || env.NOW_REGION || env.AWS_REGION);
const MAX_TRANSCRIBE_MEDIA_BYTES = 140 * 1024 * 1024;
const YOUTUBE_INFO_ENDPOINT = 'https://www.youtube.com/get_video_info';
const YOUTUBE_WATCH_ENDPOINT = 'https://www.youtube.com/watch';
const YOUTUBE_FETCH_USER_AGENT = env.YOUTUBE_FETCH_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const FFMPEG_BIN = env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = env.FFPROBE_PATH || 'ffprobe';
const FFMPEG_HEALTH_TIMEOUT_MS = Number(env.FFMPEG_HEALTH_TIMEOUT_MS || 3500);
const DATA_ROOT = IS_SERVERLESS_RUNTIME ? join(tmpdir(), 'jv-video-studio') : join(ROOT, 'data');
const MAX_REMOTE_SOURCE_BYTES = Number(env.MAX_REMOTE_SOURCE_BYTES || 600 * 1024 * 1024);
const DEFAULT_MAX_INGEST_MEDIA_BYTES = IS_SERVERLESS_RUNTIME ? (180 * 1024 * 1024) : (1024 * 1024 * 1024);
const DEFAULT_MAX_INGEST_DURATION_SECONDS = IS_SERVERLESS_RUNTIME ? (20 * 60) : (4 * 60 * 60);
const MAX_INGEST_MEDIA_BYTES = Number(env.MAX_INGEST_MEDIA_BYTES || DEFAULT_MAX_INGEST_MEDIA_BYTES);
const MAX_INGEST_DURATION_SECONDS = Number(env.MAX_INGEST_DURATION_SECONDS || DEFAULT_MAX_INGEST_DURATION_SECONDS);
const RENDER_SEGMENT_MIN_SEC = 0.04;
const SERVERLESS_YT_DLP_PATH = env.YT_DLP_SERVERLESS_PATH || join(tmpdir(), 'yt-dlp');
const BUNDLED_SERVERLESS_YT_DLP_PATH = env.YT_DLP_BUNDLED_PATH || join(ROOT, 'bin', 'yt-dlp_linux');

const keyVault = createKeyVault({ dataRoot: DATA_ROOT, envVars: env });
const automationEngine = createAutomationEngine({ dataRoot: DATA_ROOT });

let ytDlpHealthState = {
  checkedAt: 0,
  available: false,
  detail: 'not checked',
  command: YT_DLP_BIN
};
let ytDlpHealthPromise = null;
let ytDlpRuntimeBinaryPromise = null;
let ffmpegHealthState = {
  checkedAt: 0,
  available: false,
  detail: 'not checked',
  command: FFMPEG_BIN
};
let ffmpegHealthPromise = null;
let ytdlCoreState = {
  checkedAt: 0,
  available: false,
  detail: 'not checked',
  package: '@distube/ytdl-core'
};
let ytdlCorePromise = null;
let ytdlCoreModulePromise = null;
let youtubeiModulePromise = null;

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

function extractYoutubeVideoId(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let candidate = '';
    if (host === 'youtu.be') {
      candidate = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (parsed.pathname === '/watch') {
        candidate = parsed.searchParams.get('v') || '';
      } else {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') {
          candidate = parts[1] || '';
        }
      }
    }
    candidate = String(candidate || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(candidate)) return '';
    return candidate;
  } catch (_error) {
    return '';
  }
}

function buildYoutubeVideoIdCandidates(videoId) {
  const original = String(videoId || '').trim();
  if (!original) return [];

  const seen = new Set();
  const candidates = [];
  const push = (value) => {
    const candidate = String(value || '').trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  push(original);
  if (/[Il]/.test(original)) {
    push(original.replace(/I/g, 'l'));
    push(original.replace(/l/g, 'I'));
  }

  return candidates;
}

function buildYoutubeVideoIdHint(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return '';
  if (/[Il]/.test(id)) {
    return `Dica: IDs do YouTube diferenciam maiúsculas e minúsculas. Revise o ID "${id}" (I maiúsculo e l minúsculo são diferentes).`;
  }
  return '';
}

function decodeBase64Utf8(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch (_error) {
    return '';
  }
}

function appendYtDlpJsRuntimeArgs(args) {
  const raw = String(YT_DLP_JS_RUNTIMES || '').trim();
  if (!raw || /^auto$/i.test(raw) || /^default$/i.test(raw)) return args;

  const runtimes = raw
    .split(/[,\s]+/)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!runtimes.length) return args;

  args.push('--no-js-runtimes');
  runtimes.forEach((runtime) => {
    args.push('--js-runtimes', runtime);
  });
  return args;
}

/**
 * Sanitize cookie names/values so they are safe for yt-dlp's Netscape cookie
 * file format and HTTP headers:
 *  - Remove chars outside latin-1 (>0xFF) to avoid UnicodeEncodeError.
 *  - Remove ASCII control chars (0x00-0x1F, 0x7F) that corrupt tab-delimited
 *    Netscape lines — especially \x05 (ENQ) found in some SAPISID cookie values
 *    which causes yt-dlp to emit "skipping cookie file entry due to invalid length".
 *  - Keep printable ASCII (0x20-0x7E) and 8-bit chars (0x80-0xFF).
 */
function sanitizeCookieValue(value) {
  // eslint-disable-next-line no-control-regex
  return String(value || '').replace(/[\x00-\x1f\x7f]|[^\x00-\xff]/g, '');
}

function cookieHeaderToNetscape(rawCookieHeader, domain = '.youtube.com') {
  const header = String(rawCookieHeader || '').trim();
  if (!header) return '';
  const pairs = header.split(';').map((part) => part.trim()).filter(Boolean);
  if (!pairs.length) return '';
  const lines = ['# Netscape HTTP Cookie File'];
  pairs.forEach((pair) => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) return;
    const name = sanitizeCookieValue(pair.slice(0, eqIndex).trim());
    const value = sanitizeCookieValue(pair.slice(eqIndex + 1).trim());
    if (!name) return;
    lines.push(`${domain}\tTRUE\t/\tTRUE\t2147483647\t${name}\t${value}`);
  });
  return `${lines.join('\n')}\n`;
}

function cookieJsonArrayToNetscape(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawJson || '').trim());
  } catch (_error) {
    return '';
  }
  if (!Array.isArray(parsed) || !parsed.length) return '';

  const lines = ['# Netscape HTTP Cookie File'];
  parsed.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const domain = sanitizeCookieValue(String(entry.domain || '.youtube.com').trim() || '.youtube.com');
    const path = sanitizeCookieValue(String(entry.path || '/').trim() || '/');
    const name = sanitizeCookieValue(String(entry.name || '').trim());
    const value = sanitizeCookieValue(String(entry.value || '').trim());
    const secure = entry.secure ? 'TRUE' : 'FALSE';
    const expires = Number(entry.expirationDate || entry.expires || 2147483647);
    if (!name) return;
    lines.push(`${domain}\tTRUE\t${path}\t${secure}\t${Number.isFinite(expires) ? Math.max(0, Math.floor(expires)) : 2147483647}\t${name}\t${value}`);
  });

  return lines.length > 1 ? `${lines.join('\n')}\n` : '';
}

/**
 * Sanitiza um arquivo Netscape já montado: percorre cada linha e limpa
 * os campos de nome/valor para remover chars fora do range latin-1.
 */
function sanitizeNetscapeFile(netscapeContent) {
  return netscapeContent
    .split('\n')
    .map((line) => {
      if (!line || line.startsWith('#')) return line;
      const parts = line.split('\t');
      // Netscape format: domain  includeSubdomains  path  secure  expires  name  value
      if (parts.length < 6) return sanitizeCookieValue(line);
      // Sanitize name (index 5) and value (index 6)
      parts[5] = sanitizeCookieValue(parts[5] || '');
      if (parts.length > 6) parts[6] = sanitizeCookieValue(parts[6] || '');
      return parts.join('\t');
    })
    .join('\n');
}

function normalizeYoutubeCookiesToNetscape(rawCookies) {
  const source = String(rawCookies || '').trim();
  if (!source) return '';
  if (source.includes('\t') && source.includes('\n')) {
    const base = source.startsWith('# Netscape HTTP Cookie File') ? source : `# Netscape HTTP Cookie File\n${source}`;
    return sanitizeNetscapeFile(base);
  }

  const jsonConverted = cookieJsonArrayToNetscape(source);
  if (jsonConverted) return sanitizeNetscapeFile(jsonConverted);
  return sanitizeNetscapeFile(cookieHeaderToNetscape(source));
}

async function resolveYoutubeCookiesRaw(overrideCookies = '') {
  const directOverride = String(overrideCookies || '').trim();
  if (directOverride) return directOverride;

  const envDirect = String(YOUTUBE_COOKIES || '').trim();
  if (envDirect) return envDirect;

  const envDecoded = decodeBase64Utf8(YOUTUBE_COOKIES_BASE64);
  if (envDecoded) return envDecoded;

  const vaultCookie = await keyVault.resolveProviderKeyValue('youtube').catch(() => '');
  return String(vaultCookie || '').trim();
}

async function buildYoutubeCookiesFile(tempDir, overrideCookies = '') {
  const rawCookies = await resolveYoutubeCookiesRaw(overrideCookies);
  if (!rawCookies) return '';

  const normalized = normalizeYoutubeCookiesToNetscape(rawCookies);
  if (!normalized) return '';

  const cookiePath = join(tempDir, 'youtube-cookies.txt');
  await writeFile(cookiePath, normalized, 'utf8');
  return cookiePath;
}

function formatDurationStringFromSeconds(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function extractJsonObjectAfterMarker(raw, marker) {
  const source = String(raw || '');
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = source.indexOf('{', markerIndex + marker.length);
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return '';
}

async function fetchYoutubePlayerResponse(videoId) {
  const commonHeaders = {
    'User-Agent': YOUTUBE_FETCH_USER_AGENT,
    Accept: '*/*',
    Referer: 'https://www.youtube.com/'
  };

  try {
    const infoUrl = `${YOUTUBE_INFO_ENDPOINT}?video_id=${encodeURIComponent(videoId)}&el=detailpage&hl=en`;
    const infoResponse = await fetch(infoUrl, {
      method: 'GET',
      headers: commonHeaders
    });
    if (infoResponse.ok) {
      const infoText = await infoResponse.text();
      const infoParams = new URLSearchParams(infoText);
      const playerResponseRaw = infoParams.get('player_response');
      if (playerResponseRaw) {
        const payload = JSON.parse(playerResponseRaw);
        if (payload && typeof payload === 'object') return payload;
      }
    }
  } catch (_error) {
    // fallback below
  }

  const watchUrl = `${YOUTUBE_WATCH_ENDPOINT}?v=${encodeURIComponent(videoId)}&hl=en`;
  const watchResponse = await fetch(watchUrl, {
    method: 'GET',
    headers: commonHeaders
  });
  if (!watchResponse.ok) {
    throw new Error(`YouTube watch request falhou (HTTP ${watchResponse.status}).`);
  }
  const watchHtml = await watchResponse.text();
  const rawPlayerJson = extractJsonObjectAfterMarker(watchHtml, 'ytInitialPlayerResponse =');
  if (!rawPlayerJson) {
    throw new Error('Não foi possível extrair player response do YouTube.');
  }

  try {
    return JSON.parse(rawPlayerJson);
  } catch (_error) {
    throw new Error('YouTube retornou player response inválido.');
  }
}

function resolveYoutubeStreamUrl(format) {
  if (format && typeof format.url === 'string' && format.url.trim()) {
    return format.url.trim();
  }
  const cipher = String(format?.signatureCipher || format?.cipher || '').trim();
  if (!cipher) return '';
  const params = new URLSearchParams(cipher);
  const rawUrl = params.get('url');
  if (!rawUrl) return '';

  // Signature decipher is intentionally not implemented here.
  if (params.get('s')) return '';

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return '';
  }

  const sig = params.get('sig') || params.get('signature');
  if (sig) {
    parsed.searchParams.set(params.get('sp') || 'signature', sig);
  }

  return parsed.toString();
}

function pickYoutubeAudioFormat(playerResponse) {
  const streamData = playerResponse?.streamingData || {};
  const candidates = [...(Array.isArray(streamData.adaptiveFormats) ? streamData.adaptiveFormats : []), ...(Array.isArray(streamData.formats) ? streamData.formats : [])]
    .filter((format) => {
      const mime = String(format?.mimeType || '').toLowerCase();
      const hasAudio = mime.includes('audio/') || Boolean(format?.audioQuality);
      return hasAudio;
    })
    .map((format) => {
      const url = resolveYoutubeStreamUrl(format);
      if (!url) return null;
      const mime = String(format?.mimeType || '').split(';')[0].trim().toLowerCase();
      const hasVideo = mime.includes('video/') || Boolean(format?.qualityLabel);
      const bitrate = Number(format?.bitrate || 0);
      const contentLength = Number(format?.contentLength || 0);
      const mp4Boost = mime.includes('mp4') ? 50_000_000 : 0;
      const bitrateBias = bitrate > 0 && bitrate <= 192000 ? 10_000_000 : 0;
      const audioOnlyBoost = hasVideo ? 0 : 15_000_000;
      const muxedPenalty = hasVideo ? -5_000_000 : 0;
      const score = mp4Boost + bitrateBias + audioOnlyBoost + muxedPenalty + bitrate;
      return {
        url,
        mimeType: mime || 'audio/mp4',
        hasVideo,
        bitrate,
        contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function buildYoutubeMetadataFromPlayerResponse(playerResponse, youtubeUrl, fallbackVideoId = '') {
  const details = playerResponse?.videoDetails || {};
  const micro = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const videoId = String(details.videoId || fallbackVideoId || '').trim();
  const duration = parseDurationToSeconds(details.lengthSeconds || micro.lengthSeconds || micro.lengthSecondsText);
  if (!Number.isFinite(duration) || duration <= 0) {
    const error = new Error('Não foi possível determinar a duração do vídeo.');
    error.statusCode = 422;
    throw error;
  }

  let thumbnail = '';
  if (Array.isArray(details.thumbnail?.thumbnails) && details.thumbnail.thumbnails.length) {
    thumbnail = String(details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1]?.url || '').trim();
  } else if (Array.isArray(micro.thumbnail?.thumbnails) && micro.thumbnail.thumbnails.length) {
    thumbnail = String(micro.thumbnail.thumbnails[micro.thumbnail.thumbnails.length - 1]?.url || '').trim();
  }

  return {
    ok: true,
    videoId: videoId || null,
    title: String(details.title || micro.title?.simpleText || '').trim() || null,
    duration,
    durationString: formatDurationStringFromSeconds(duration),
    uploader: String(details.author || micro.ownerChannelName || '').trim() || null,
    thumbnail: thumbnail || null,
    webpageUrl: String(micro.urlCanonical || micro.ownerProfileUrl || youtubeUrl).trim(),
    extractor: 'YouTubeHTTP'
  };
}

async function fetchYoutubeMetadataViaHttp(youtubeUrl) {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    const error = new Error('Não foi possível extrair o videoId da URL do YouTube.');
    error.statusCode = 400;
    throw error;
  }
  const playerResponse = await fetchYoutubePlayerResponse(videoId);
  return buildYoutubeMetadataFromPlayerResponse(playerResponse, youtubeUrl, videoId);
}

async function downloadYoutubeAudioViaHttp(youtubeUrl) {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    throw new Error('Não foi possível extrair o videoId da URL do YouTube.');
  }

  const playerResponse = await fetchYoutubePlayerResponse(videoId);
  const selected = pickYoutubeAudioFormat(playerResponse);
  if (!selected?.url) {
    throw new Error('Não foi possível obter stream de áudio direto deste vídeo no ambiente atual.');
  }

  const response = await fetch(selected.url, {
    method: 'GET',
    headers: {
      'User-Agent': YOUTUBE_FETCH_USER_AGENT,
      Referer: 'https://www.youtube.com/'
    }
  });
  if (!response.ok) {
    throw new Error(`Falha ao baixar stream de áudio do YouTube (HTTP ${response.status}).`);
  }

  const declaredLength = Number(response.headers.get('content-length') || selected.contentLength || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSCRIBE_MEDIA_BYTES) {
    throw new Error(
      `Áudio muito grande para transcrição (${Math.round(declaredLength / 1024 / 1024)}MB). ` +
      'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer.length) {
    throw new Error('Stream de áudio do YouTube retornou vazio.');
  }
  if (buffer.length > MAX_TRANSCRIBE_MEDIA_BYTES) {
    throw new Error(
      `Áudio muito grande para transcrição (${Math.round(buffer.length / 1024 / 1024)}MB). ` +
      'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
    );
  }

  const mimeType = selected.mimeType || inferMimeTypeFromName(`audio-${videoId}.m4a`, 'audio/mp4');
  const extension = mimeType.includes('video/') ? 'mp4'
    : mimeType.includes('webm') ? 'webm'
      : mimeType.includes('mpeg') ? 'mp3' : 'm4a';

  return {
    buffer,
    fileName: `youtube-${videoId}.${extension}`,
    mimeType
  };
}

function normalizeMimeType(rawMimeType, fallback = 'audio/mp4') {
  const cleaned = String(rawMimeType || '').split(';')[0].trim().toLowerCase();
  return cleaned || fallback;
}

async function downloadYoutubeAudioViaYoutubei(youtubeUrl) {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    throw new Error('Não foi possível extrair o videoId da URL do YouTube.');
  }

  const Innertube = await getYoutubeiModule();
  const youtube = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
    fail_fast: false
  });

  const clients = ['IOS', 'ANDROID', 'WEB', 'TV'];
  const errors = [];

  for (const client of clients) {
    try {
      const format = await youtube.getStreamingData(videoId, {
        client,
        type: 'audio',
        quality: 'best',
        format: 'any'
      });

      const streamUrl = String(format?.url || '').trim();
      if (!streamUrl) {
        throw new Error('youtubei.js retornou formato sem URL de áudio.');
      }

      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          'User-Agent': YOUTUBE_FETCH_USER_AGENT,
          Referer: 'https://www.youtube.com/'
        }
      });
      if (!response.ok) {
        throw new Error(`Falha ao baixar áudio via youtubei.js (HTTP ${response.status}).`);
      }

      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSCRIBE_MEDIA_BYTES) {
        throw new Error(
          `Áudio muito grande para transcrição (${Math.round(declaredLength / 1024 / 1024)}MB). ` +
          'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (!buffer.length) {
        throw new Error('Stream de áudio via youtubei.js retornou vazio.');
      }
      if (buffer.length > MAX_TRANSCRIBE_MEDIA_BYTES) {
        throw new Error(
          `Áudio muito grande para transcrição (${Math.round(buffer.length / 1024 / 1024)}MB). ` +
          'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
        );
      }

      const formatMime = format?.mime_type || format?.mimeType;
      const mimeType = normalizeMimeType(formatMime || response.headers.get('content-type') || '', 'audio/mp4');
      const extension = mimeType.includes('webm') ? 'webm'
        : mimeType.includes('mpeg') ? 'mp3'
          : mimeType.includes('ogg') ? 'ogg' : 'm4a';

      return {
        buffer,
        fileName: `youtube-${videoId}.${extension}`,
        mimeType
      };
    } catch (error) {
      errors.push(`${client}: ${error?.message || String(error)}`);
    }
  }

  throw new Error(
    `youtubei.js não conseguiu baixar áudio do YouTube.${errors.length ? ` Detalhes: ${errors.join(' | ')}` : ''}`.trim()
  );
}

async function downloadYoutubeVideoViaYoutubei(youtubeUrl) {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    throw new Error('Não foi possível extrair o videoId da URL do YouTube.');
  }

  const Innertube = await getYoutubeiModule();
  const youtube = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
    fail_fast: false
  });

  const clients = ['ANDROID', 'IOS', 'WEB', 'TV'];
  const errors = [];

  for (const client of clients) {
    try {
      const format = await youtube.getStreamingData(videoId, {
        client,
        type: 'video+audio',
        quality: 'best',
        format: 'mp4'
      });

      const streamUrl = String(format?.url || '').trim();
      if (!streamUrl) {
        throw new Error('youtubei.js retornou formato de vídeo sem URL.');
      }

      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          'User-Agent': YOUTUBE_FETCH_USER_AGENT,
          Referer: 'https://www.youtube.com/'
        }
      });
      if (!response.ok) {
        throw new Error(`Falha ao baixar vídeo via youtubei.js (HTTP ${response.status}).`);
      }

      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_INGEST_MEDIA_BYTES) {
        throw new Error(
          `Vídeo muito grande para ingestão (${Math.round(declaredLength / 1024 / 1024)}MB). ` +
          `Limite atual: ${Math.round(MAX_INGEST_MEDIA_BYTES / 1024 / 1024)}MB.`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (!buffer.length) {
        throw new Error('Stream de vídeo via youtubei.js retornou vazio.');
      }
      if (buffer.length > MAX_INGEST_MEDIA_BYTES) {
        throw new Error(
          `Vídeo muito grande para ingestão (${Math.round(buffer.length / 1024 / 1024)}MB). ` +
          `Limite atual: ${Math.round(MAX_INGEST_MEDIA_BYTES / 1024 / 1024)}MB.`
        );
      }

      const formatMime = format?.mime_type || format?.mimeType;
      const mimeType = normalizeMimeType(formatMime || response.headers.get('content-type') || '', 'video/mp4');
      const extension = mimeType.includes('webm') ? 'webm'
        : mimeType.includes('quicktime') ? 'mov' : 'mp4';

      return {
        buffer,
        fileName: `youtube-${videoId}.${extension}`,
        mimeType,
        sizeBytes: buffer.length
      };
    } catch (error) {
      errors.push(`${client}: ${error?.message || String(error)}`);
    }
  }

  throw new Error(
    `youtubei.js não conseguiu baixar vídeo do YouTube.${errors.length ? ` Detalhes: ${errors.join(' | ')}` : ''}`.trim()
  );
}

async function getYtdlCoreModule() {
  if (ytdlCoreModulePromise) return ytdlCoreModulePromise;
  ytdlCoreModulePromise = import('@distube/ytdl-core')
    .then((module) => module?.default || module)
    .catch((error) => {
      ytdlCoreModulePromise = null;
      throw error;
    });
  return ytdlCoreModulePromise;
}

async function getYoutubeiModule() {
  if (youtubeiModulePromise) return youtubeiModulePromise;
  youtubeiModulePromise = import('youtubei.js')
    .then((module) => module?.Innertube || module?.default || module)
    .then((innertubeCtor) => {
      if (typeof innertubeCtor !== 'function' || typeof innertubeCtor.create !== 'function') {
        throw new Error('youtubei.js carregado, mas API Innertube.create não foi encontrada.');
      }
      return innertubeCtor;
    })
    .catch((error) => {
      youtubeiModulePromise = null;
      throw error;
    });
  return youtubeiModulePromise;
}

async function getYtdlCoreHealth(force = false) {
  const now = Date.now();
  if (!force && ytdlCoreState.checkedAt && now - ytdlCoreState.checkedAt < YT_DLP_HEALTH_TTL_MS) {
    return ytdlCoreState;
  }
  if (ytdlCorePromise && !force) return ytdlCorePromise;

  ytdlCorePromise = (async () => {
    try {
      const ytdl = await getYtdlCoreModule();
      const looksValid = typeof ytdl === 'function' && typeof ytdl.getBasicInfo === 'function';
      ytdlCoreState = {
        checkedAt: Date.now(),
        available: looksValid,
        detail: looksValid ? 'module loaded' : 'module loaded but API not recognized',
        package: '@distube/ytdl-core'
      };
    } catch (error) {
      ytdlCoreState = {
        checkedAt: Date.now(),
        available: false,
        detail: error?.code === 'ERR_MODULE_NOT_FOUND' ? 'module not installed' : (error?.message || 'module unavailable'),
        package: '@distube/ytdl-core'
      };
    } finally {
      ytdlCorePromise = null;
    }
    return ytdlCoreState;
  })();

  return ytdlCorePromise;
}

function pickYtdlAudioFormat(ytdl, info) {
  const formats = ytdl.filterFormats(info?.formats || [], 'audioonly');
  if (!Array.isArray(formats) || !formats.length) return null;

  const ranked = formats
    .map((format) => {
      const mimeType = String(format?.mimeType || '').split(';')[0].trim().toLowerCase();
      const audioBitrate = Number(format?.audioBitrate || format?.bitrate || 0);
      const container = String(format?.container || '').trim().toLowerCase();
      const extension = String(format?.audioExtension || format?.extension || container || '').trim().toLowerCase();
      const declaredLength = Number(format?.contentLength || format?.clen || 0);
      const mp4Boost = mimeType.includes('mp4') || extension === 'm4a' ? 40_000_000 : 0;
      const opusBoost = mimeType.includes('opus') ? 10_000_000 : 0;
      return {
        format,
        mimeType: mimeType || inferMimeTypeFromName(`audio.${extension || 'm4a'}`, 'audio/mp4'),
        extension: extension || (mimeType.includes('webm') ? 'webm' : 'm4a'),
        declaredLength: Number.isFinite(declaredLength) ? declaredLength : 0,
        score: mp4Boost + opusBoost + audioBitrate
      };
    })
    .sort((a, b) => b.score - a.score);

  return ranked[0] || null;
}

async function fetchYoutubeMetadataWithYtdlCore(youtubeUrl) {
  const ytdl = await getYtdlCoreModule();
  const info = await ytdl.getBasicInfo(youtubeUrl, {
    requestOptions: {
      headers: {
        'User-Agent': YOUTUBE_FETCH_USER_AGENT
      }
    }
  });

  const details = info?.videoDetails || {};
  const duration = parseDurationToSeconds(details.lengthSeconds || details.length_seconds || details.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const error = new Error('Não foi possível determinar a duração do vídeo.');
    error.statusCode = 422;
    throw error;
  }

  const thumbnails = Array.isArray(details.thumbnails) ? details.thumbnails : [];
  const thumbnail = thumbnails.length ? String(thumbnails[thumbnails.length - 1]?.url || '').trim() : '';

  return {
    ok: true,
    videoId: String(details.videoId || extractYoutubeVideoId(youtubeUrl) || '').trim() || null,
    title: String(details.title || '').trim() || null,
    duration,
    durationString: formatDurationStringFromSeconds(duration),
    uploader: String(details.author?.name || details.ownerChannelName || details.channelId || '').trim() || null,
    thumbnail: thumbnail || null,
    webpageUrl: String(details.video_url || youtubeUrl).trim(),
    extractor: 'YouTubeYtdlCore'
  };
}

async function downloadYoutubeAudioWithYtdlCore(youtubeUrl) {
  const ytdl = await getYtdlCoreModule();
  const info = await ytdl.getInfo(youtubeUrl, {
    requestOptions: {
      headers: {
        'User-Agent': YOUTUBE_FETCH_USER_AGENT
      }
    }
  });
  const selected = pickYtdlAudioFormat(ytdl, info);
  if (!selected?.format) {
    throw new Error('Não foi possível selecionar formato de áudio via ytdl-core.');
  }

  if (selected.declaredLength > MAX_TRANSCRIBE_MEDIA_BYTES) {
    throw new Error(
      `Áudio muito grande para transcrição (${Math.round(selected.declaredLength / 1024 / 1024)}MB). ` +
      'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
    );
  }

  const stream = ytdl.downloadFromInfo(info, {
    quality: selected.format.itag,
    filter: 'audioonly',
    highWaterMark: 1 << 25,
    requestOptions: {
      headers: {
        'User-Agent': YOUTUBE_FETCH_USER_AGENT
      }
    }
  });

  const timeoutMs = 180000;
  const timeout = setTimeout(() => {
    try {
      stream.destroy(new Error('Timeout ao baixar áudio via ytdl-core.'));
    } catch (_error) {
      // noop
    }
  }, timeoutMs);

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_TRANSCRIBE_MEDIA_BYTES) {
        throw new Error(
          `Áudio muito grande para transcrição (${Math.round(total / 1024 / 1024)}MB). ` +
          'Use um trecho menor do vídeo para manter abaixo de ~140MB.'
        );
      }
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!chunks.length) {
    throw new Error('Stream de áudio via ytdl-core retornou vazio.');
  }

  const buffer = Buffer.concat(chunks);
  const videoId = String(info?.videoDetails?.videoId || extractYoutubeVideoId(youtubeUrl) || '').trim() || `video-${Date.now()}`;
  return {
    buffer,
    fileName: `youtube-${videoId}.${selected.extension || 'm4a'}`,
    mimeType: selected.mimeType || 'audio/mp4'
  };
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

async function ensureServerlessYtDlpBinary() {
  if (!IS_SERVERLESS_RUNTIME) return '';
  if (existsSync(BUNDLED_SERVERLESS_YT_DLP_PATH)) {
    try {
      await runCommand(BUNDLED_SERVERLESS_YT_DLP_PATH, ['--version'], { timeoutMs: YT_DLP_HEALTH_TIMEOUT_MS });
      return BUNDLED_SERVERLESS_YT_DLP_PATH;
    } catch (_error) {
      // fallback to /tmp bootstrap below
    }
  }
  if (existsSync(SERVERLESS_YT_DLP_PATH)) {
    try {
      await runCommand(SERVERLESS_YT_DLP_PATH, ['--version'], { timeoutMs: YT_DLP_HEALTH_TIMEOUT_MS });
      return SERVERLESS_YT_DLP_PATH;
    } catch (_error) {
      await rm(SERVERLESS_YT_DLP_PATH, { force: true }).catch(() => { });
    }
  }
  if (ytDlpRuntimeBinaryPromise) return ytDlpRuntimeBinaryPromise;

  ytDlpRuntimeBinaryPromise = (async () => {
    let assetName = 'yt-dlp_linux';
    if (process.platform === 'linux' && arch === 'arm64') assetName = 'yt-dlp_linux_aarch64';
    else if (process.platform === 'darwin') assetName = 'yt-dlp_macos';
    else if (process.platform === 'win32') assetName = 'yt-dlp.exe';

    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'voidclip-ytdl-bootstrap/1.0' },
      redirect: 'follow'
    });
    if (!response.ok) {
      throw new Error(`Falha ao baixar binário yt-dlp (${response.status}).`);
    }

    const binary = Buffer.from(await response.arrayBuffer());
    if (!binary.length) {
      throw new Error('Download do binário yt-dlp retornou vazio.');
    }

    await writeFile(SERVERLESS_YT_DLP_PATH, binary);
    await chmod(SERVERLESS_YT_DLP_PATH, 0o755).catch(() => { });
    if (!existsSync(SERVERLESS_YT_DLP_PATH)) {
      throw new Error('Download do binário yt-dlp falhou no runtime serverless.');
    }
    await runCommand(SERVERLESS_YT_DLP_PATH, ['--version'], { timeoutMs: YT_DLP_HEALTH_TIMEOUT_MS });
    return SERVERLESS_YT_DLP_PATH;
  })().finally(() => {
    ytDlpRuntimeBinaryPromise = null;
  });

  return ytDlpRuntimeBinaryPromise;
}

async function runYtDlp(args, options = {}) {
  const attempts = [];
  const pushAttempt = (command, nextArgs = args, bootstrapError = null) => {
    if (!command) return;
    if (attempts.some((entry) => entry.command === command)) return;
    attempts.push({ command, args: nextArgs, bootstrapError });
  };

  if (IS_SERVERLESS_RUNTIME) {
    try {
      const runtimeBinary = await ensureServerlessYtDlpBinary();
      pushAttempt(runtimeBinary);
    } catch (error) {
      pushAttempt('yt-dlp(serverless-bootstrap)', args, error);
    }
  }
  if (YT_DLP_BIN && YT_DLP_BIN !== 'yt-dlp') pushAttempt(YT_DLP_BIN);
  pushAttempt('yt-dlp');
  pushAttempt('python3', ['-m', 'yt_dlp', ...args]);
  pushAttempt('python', ['-m', 'yt_dlp', ...args]);

  let lastError = null;
  for (const attempt of attempts) {
    if (attempt.bootstrapError) {
      lastError = attempt.bootstrapError;
      continue;
    }
    try {
      const result = await runCommand(attempt.command, attempt.args, options);
      return { ...result, command: attempt.command };
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

async function runFfmpeg(args, options = {}) {
  try {
    return await runCommand(FFMPEG_BIN, args, options);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const wrapped = new Error(`ffmpeg não encontrado (${FFMPEG_BIN}).`);
      wrapped.code = 'ENOENT';
      throw wrapped;
    }
    throw error;
  }
}

async function runFfprobe(args, options = {}) {
  try {
    return await runCommand(FFPROBE_BIN, args, options);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const wrapped = new Error(`ffprobe não encontrado (${FFPROBE_BIN}).`);
      wrapped.code = 'ENOENT';
      throw wrapped;
    }
    throw error;
  }
}

async function getFfmpegHealth(force = false) {
  const now = Date.now();
  if (!force && ffmpegHealthState.checkedAt && now - ffmpegHealthState.checkedAt < YT_DLP_HEALTH_TTL_MS) {
    return ffmpegHealthState;
  }
  if (ffmpegHealthPromise && !force) return ffmpegHealthPromise;

  ffmpegHealthPromise = (async () => {
    try {
      const result = await runFfmpeg(['-version'], { timeoutMs: FFMPEG_HEALTH_TIMEOUT_MS });
      const versionLine = String(result.stdout || result.stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^ffmpeg version/i.test(line)) || 'ffmpeg version unknown';
      ffmpegHealthState = {
        checkedAt: Date.now(),
        available: true,
        detail: versionLine,
        command: FFMPEG_BIN
      };
    } catch (error) {
      ffmpegHealthState = {
        checkedAt: Date.now(),
        available: false,
        detail: error?.message || 'ffmpeg unavailable',
        command: FFMPEG_BIN
      };
    } finally {
      ffmpegHealthPromise = null;
    }
    return ffmpegHealthState;
  })();

  return ffmpegHealthPromise;
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function sanitizePathSegment(value, fallback = 'asset') {
  const cleaned = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

function absoluteToPublicAssetUri(absPath) {
  const normalized = resolve(absPath);
  if (!normalized.startsWith(ROOT)) return null;
  return `/${normalized.slice(ROOT.length + 1).replace(/\\/g, '/')}`;
}

function parseDataUrl(rawValue) {
  const value = String(rawValue || '').trim();
  const match = value.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64')
  };
}

async function saveImageFromInputToFile({ input, filePath }) {
  const dataUrl = parseDataUrl(input);
  if (dataUrl && dataUrl.buffer.length) {
    await writeFile(filePath, dataUrl.buffer);
    return { filePath, mimeType: dataUrl.mimeType };
  }

  const asUrl = String(input || '').trim();
  if (/^https?:\/\//i.test(asUrl)) {
    const response = await fetch(asUrl);
    if (!response.ok) {
      throw new Error(`Falha ao baixar imagem (${response.status}).`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw new Error('Imagem remota vazia.');
    await writeFile(filePath, buffer);
    return { filePath, mimeType: String(response.headers.get('content-type') || '') };
  }

  const localPath = resolve(String(input || '').trim());
  const localStat = await stat(localPath).catch(() => null);
  if (!localStat || !localStat.isFile()) {
    throw new Error('Imagem de patch inválida. Use dataURL, URL pública ou caminho local válido.');
  }
  const localBuffer = await readFile(localPath);
  await writeFile(filePath, localBuffer);
  return { filePath, mimeType: inferMimeTypeFromName(localPath, 'image/png') };
}

function normalizeRegion(regionInput) {
  const region = regionInput && typeof regionInput === 'object' ? regionInput : {};
  const x = clampNumber(region.x ?? 0.2, 0, 1);
  const y = clampNumber(region.y ?? 0.2, 0, 1);
  const width = clampNumber(region.width ?? 0.4, 0.02, 1);
  const height = clampNumber(region.height ?? 0.4, 0.02, 1);
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y)
  };
}

function normalizeSourceReference({ sourcePath, sourceUrl }) {
  const localPathRaw = String(sourcePath || '').trim();
  if (localPathRaw) {
    const resolvedPath = resolve(localPathRaw);
    if (!resolvedPath.startsWith(ROOT) && !resolvedPath.startsWith(tmpdir())) {
      const error = new Error('sourcePath fora das áreas permitidas.');
      error.statusCode = 400;
      throw error;
    }
    return { sourceRef: resolvedPath, sourceKind: 'path' };
  }

  const remoteUrl = String(sourceUrl || '').trim();
  if (/^https?:\/\//i.test(remoteUrl)) {
    return { sourceRef: remoteUrl, sourceKind: 'url' };
  }

  const error = new Error('Forneça sourcePath ou sourceUrl para operação de vídeo.');
  error.statusCode = 400;
  throw error;
}

async function probeVideoInfo(sourceRef) {
  const probe = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json',
    sourceRef
  ], { timeoutMs: 20000 });

  let payload;
  try {
    payload = JSON.parse(String(probe.stdout || '{}'));
  } catch (_error) {
    payload = {};
  }

  const stream = Array.isArray(payload.streams) ? payload.streams[0] : {};
  const width = clampNumber(stream?.width || 1080, 16, 8192);
  const height = clampNumber(stream?.height || 1920, 16, 8192);
  const duration = Number(payload?.format?.duration || 0);

  const frameRateRaw = String(stream?.avg_frame_rate || stream?.r_frame_rate || '30/1');
  let fps = 30;
  if (/^\d+\/\d+$/.test(frameRateRaw)) {
    const [a, b] = frameRateRaw.split('/').map((p) => Number(p));
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) fps = a / b;
  } else {
    const direct = Number(frameRateRaw);
    if (Number.isFinite(direct) && direct > 0) fps = direct;
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    fps: clampNumber(fps, 12, 120)
  };
}

function isAllowedFilesystemPath(absPath) {
  const normalized = resolve(absPath);
  return normalized.startsWith(ROOT) || normalized.startsWith(tmpdir());
}

function publicAssetUriToAbsolutePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('/')) {
    const candidate = resolve(ROOT, `.${raw}`);
    return isAllowedFilesystemPath(candidate) ? candidate : null;
  }
  if (raw.startsWith(ROOT) || raw.startsWith(tmpdir())) {
    const candidate = resolve(raw);
    return isAllowedFilesystemPath(candidate) ? candidate : null;
  }
  return null;
}

function extFromUrl(url, fallback = '.mp4') {
  try {
    const parsed = new URL(url);
    const ext = extname(parsed.pathname || '').toLowerCase();
    if (ext && ext.length <= 8) return ext;
  } catch (_error) {
    // noop
  }
  return fallback;
}

async function downloadHttpMediaToFile(sourceUrl, targetPath) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    const error = new Error(`Falha ao baixar mídia remota (HTTP ${response.status}).`);
    error.statusCode = 502;
    throw error;
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_SOURCE_BYTES) {
    const error = new Error(
      `Arquivo remoto excede limite de ${Math.round(MAX_REMOTE_SOURCE_BYTES / 1024 / 1024)}MB.`
    );
    error.statusCode = 413;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    const error = new Error('Arquivo remoto vazio.');
    error.statusCode = 422;
    throw error;
  }
  if (buffer.length > MAX_REMOTE_SOURCE_BYTES) {
    const error = new Error(
      `Arquivo remoto excede limite de ${Math.round(MAX_REMOTE_SOURCE_BYTES / 1024 / 1024)}MB após download.`
    );
    error.statusCode = 413;
    throw error;
  }
  await writeFile(targetPath, buffer);
  return targetPath;
}

async function downloadHttpMediaToBuffer(sourceUrl, maxBytes = MAX_TRANSCRIBE_MEDIA_BYTES) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    const error = new Error(`Falha ao baixar mídia remota (HTTP ${response.status}).`);
    error.statusCode = 502;
    throw error;
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error(
      `Arquivo remoto excede limite de ${Math.round(maxBytes / 1024 / 1024)}MB.`
    );
    error.statusCode = 413;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    const error = new Error('Arquivo remoto vazio.');
    error.statusCode = 422;
    throw error;
  }
  if (buffer.length > maxBytes) {
    const error = new Error(
      `Arquivo remoto excede limite de ${Math.round(maxBytes / 1024 / 1024)}MB após download.`
    );
    error.statusCode = 413;
    throw error;
  }

  const fileNameFromUrl = String(new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || `media-${Date.now()}.mp4`).trim();
  return {
    buffer,
    fileName: fileNameFromUrl,
    mimeType: String(response.headers.get('content-type') || inferMimeTypeFromName(fileNameFromUrl, 'video/mp4')).split(';')[0].trim() || 'video/mp4'
  };
}

async function downloadYoutubeVideoForEditing(youtubeUrl, tempDir) {
  if (IS_SERVERLESS_RUNTIME) {
    const error = new Error('Edição com YouTube direto indisponível em serverless. Faça upload de arquivo.');
    error.statusCode = 503;
    throw error;
  }
  const ytDlp = await getYtDlpHealth(false);
  if (!ytDlp.available) {
    const error = new Error(`yt-dlp indisponível (${ytDlp.command}).`);
    error.statusCode = 503;
    throw error;
  }

  const outTemplate = join(tempDir, 'source.%(ext)s');
  try {
    const args = appendYtDlpJsRuntimeArgs([
      '--no-playlist',
      '--no-progress',
      '--no-warnings',
      '--socket-timeout',
      '20',
      '--newline',
      '-f',
      'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/best[height<=1080]/best',
      '--merge-output-format',
      'mp4',
      '-o',
      outTemplate,
      youtubeUrl
    ]);
    await runYtDlp(args, { timeoutMs: 8 * 60 * 1000, cwd: tempDir });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const detail = stderr ? stderr.split('\n').slice(-2).join(' | ') : '';
    const wrapped = new Error(detail || error?.message || 'Falha ao baixar vídeo do YouTube.');
    wrapped.statusCode = 502;
    throw wrapped;
  }

  const files = (await readdir(tempDir))
    .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'))
    .map((name) => ({ name, abs: join(tempDir, name) }));

  if (!files.length) {
    const error = new Error('yt-dlp não gerou arquivo de vídeo para edição.');
    error.statusCode = 502;
    throw error;
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
  if (chosenStat.size > MAX_REMOTE_SOURCE_BYTES) {
    const error = new Error(
      `Vídeo excede limite de ${Math.round(MAX_REMOTE_SOURCE_BYTES / 1024 / 1024)}MB para edição local.`
    );
    error.statusCode = 413;
    throw error;
  }
  return chosen.abs;
}

async function resolveLocalVideoSource({ sourcePath, sourceUrl, youtubeUrl, tempDir }) {
  const localPathRaw = String(sourcePath || '').trim();
  if (localPathRaw) {
    const resolvedPath = resolve(localPathRaw);
    if (!isAllowedFilesystemPath(resolvedPath)) {
      const error = new Error('sourcePath fora das áreas permitidas (workspace/tmp).');
      error.statusCode = 400;
      throw error;
    }
    const fileStat = await stat(resolvedPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      const error = new Error('sourcePath inválido: arquivo não encontrado.');
      error.statusCode = 400;
      throw error;
    }
    return { sourceLocalPath: resolvedPath, sourceKind: 'path', sourceRef: resolvedPath };
  }

  const remoteUrl = String(youtubeUrl || sourceUrl || '').trim();
  if (!remoteUrl) {
    const error = new Error('Forneça sourcePath ou sourceUrl para execução.');
    error.statusCode = 400;
    throw error;
  }
  if (!/^https?:\/\//i.test(remoteUrl)) {
    const error = new Error('sourceUrl inválida. Use URL http/https.');
    error.statusCode = 400;
    throw error;
  }

  if (isYoutubeUrl(remoteUrl)) {
    const downloaded = await downloadYoutubeVideoForEditing(remoteUrl, tempDir);
    return { sourceLocalPath: downloaded, sourceKind: 'youtube', sourceRef: remoteUrl };
  }

  const targetPath = join(tempDir, `source-${Date.now()}${extFromUrl(remoteUrl, '.mp4')}`);
  await downloadHttpMediaToFile(remoteUrl, targetPath);
  return { sourceLocalPath: targetPath, sourceKind: 'url', sourceRef: remoteUrl };
}

function normalizeProviderForVault(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'google' || normalized === 'nano_banana') return 'google_nano_banana';
  return normalized || 'google_nano_banana';
}

async function resolvePatchImagePathFromReference(reference, tempDir, index = 0) {
  const ref = String(reference || '').trim();
  if (!ref) return '';
  const localFromPublic = publicAssetUriToAbsolutePath(ref);
  if (localFromPublic) {
    const fileStat = await stat(localFromPublic).catch(() => null);
    if (fileStat?.isFile()) return localFromPublic;
  }
  const targetPath = join(tempDir, `patch-input-${index + 1}.png`);
  await saveImageFromInputToFile({ input: ref, filePath: targetPath });
  return targetPath;
}

function getPatchTimestampSec(patch) {
  const direct = Number(patch?.frame?.timestampSec);
  if (Number.isFinite(direct)) return direct;
  const fallback = Number(patch?.timestampSec);
  return Number.isFinite(fallback) ? fallback : Number.NaN;
}

function buildConcatListLine(absPath) {
  const escaped = String(absPath).replace(/'/g, "'\\''");
  return `file '${escaped}'`;
}

async function executeFramePatchRuntime(payload) {
  const ffmpeg = await getFfmpegHealth(false);
  if (!ffmpeg.available) {
    const error = new Error(`ffmpeg indisponível (${ffmpeg.command}).`);
    error.statusCode = 503;
    throw error;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'jv-frame-patch-'));
  const patchId = sanitizePathSegment(payload.patchId || randomUUID());
  const assetsDir = join(DATA_ROOT, 'automation', 'assets', patchId);
  await ensureDirectory(assetsDir);

  try {
    const source = await resolveLocalVideoSource({
      sourcePath: payload.sourcePath,
      sourceUrl: payload.sourceUrl,
      youtubeUrl: payload.youtubeUrl,
      tempDir
    });

    const videoInfo = await probeVideoInfo(source.sourceLocalPath);
    const provider = normalizeProviderForVault(payload.provider || 'google_nano_banana');
    const model = String(payload.model || (provider === 'openai' ? 'gpt-image-1' : 'gemini-3-pro-image-preview')).trim();
    const instruction = String(payload.instruction || payload.prompt || '').trim();
    const timestampMax = videoInfo.duration > 0 ? videoInfo.duration : (60 * 60 * 3);
    const timestampSec = clampNumber(payload.timestampSec ?? payload.frameTimestampSec ?? 0, 0, timestampMax);
    const region = normalizeRegion(payload.region);

    const regionPx = {
      x: Math.max(0, Math.floor(region.x * videoInfo.width)),
      y: Math.max(0, Math.floor(region.y * videoInfo.height)),
      width: Math.max(2, Math.round(region.width * videoInfo.width)),
      height: Math.max(2, Math.round(region.height * videoInfo.height))
    };
    regionPx.width = Math.min(regionPx.width, Math.max(2, videoInfo.width - regionPx.x));
    regionPx.height = Math.min(regionPx.height, Math.max(2, videoInfo.height - regionPx.y));

    const frameOriginalPath = join(assetsDir, 'frame-original.png');
    const frameEditedPath = join(assetsDir, 'frame-edited.png');
    const frameDiffPath = join(assetsDir, 'frame-diff.png');
    const patchInputPath = join(tempDir, 'patch-input.png');
    const patchResizedPath = join(tempDir, 'patch-resized.png');

    await runFfmpeg([
      '-y',
      '-ss', timestampSec.toFixed(3),
      '-i', source.sourceLocalPath,
      '-frames:v', '1',
      frameOriginalPath
    ], { timeoutMs: 180000 });

    let patchImageRef = String(payload.patchImage || payload.imageInput || payload.frameEditedImage || '').trim();
    let generatedImage = null;
    let providerApiKey = String(payload.apiKey || '').trim();
    if (!providerApiKey) {
      providerApiKey = await keyVault.resolveProviderKeyValue(provider).catch(() => '');
    }

    if (!patchImageRef) {
      if (!instruction) {
        const error = new Error('Informe patchImage ou instruction para gerar imagem de patch.');
        error.statusCode = 400;
        throw error;
      }

      if (provider === 'google_nano_banana') {
        await keyVault.assertWithinRateLimit({ provider: 'google_nano_banana', tokensPerWindow: 1, defaultLimit: 60 });
        generatedImage = await generateImageWithGoogleNanoBanana({
          prompt: instruction,
          apiKey: providerApiKey,
          model
        });
        await keyVault.recordProviderUsage({
          provider: 'google_nano_banana',
          requestCount: 1,
          estimatedCostUsd: Number(payload.estimatedCostUsd ?? 0.02)
        });
      } else if (provider === 'openai') {
        await keyVault.assertWithinRateLimit({ provider: 'openai', tokensPerWindow: 1, defaultLimit: 60 });
        generatedImage = await generateImageWithOpenAI({
          prompt: instruction,
          apiKey: providerApiKey || OPENAI_API_KEY,
          model,
          size: String(payload.size || '1024x1024')
        });
        await keyVault.recordProviderUsage({
          provider: 'openai',
          requestCount: 1,
          estimatedCostUsd: Number(payload.estimatedCostUsd ?? 0.04)
        });
      } else {
        const error = new Error(`Provider ${provider} ainda não gera imagem direta. Envie patchImage.`);
        error.statusCode = 400;
        throw error;
      }

      patchImageRef = String(generatedImage?.imageDataUrl || generatedImage?.imageUrl || '').trim();
      if (!patchImageRef) {
        const error = new Error('Provider não retornou imagem de patch.');
        error.statusCode = 502;
        throw error;
      }
    }

    await saveImageFromInputToFile({ input: patchImageRef, filePath: patchInputPath });

    await runFfmpeg([
      '-y',
      '-i', patchInputPath,
      '-vf',
      `scale=${regionPx.width}:${regionPx.height}:force_original_aspect_ratio=decrease,pad=${regionPx.width}:${regionPx.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      '-frames:v', '1',
      patchResizedPath
    ], { timeoutMs: 180000 });

    await runFfmpeg([
      '-y',
      '-i', frameOriginalPath,
      '-i', patchResizedPath,
      '-filter_complex', `[0:v][1:v]overlay=${regionPx.x}:${regionPx.y}:format=auto`,
      '-frames:v', '1',
      frameEditedPath
    ], { timeoutMs: 180000 });

    await runFfmpeg([
      '-y',
      '-i', frameOriginalPath,
      '-i', frameEditedPath,
      '-filter_complex', '[0:v][1:v]blend=all_mode=difference,eq=contrast=2.3:brightness=0.06',
      '-frames:v', '1',
      frameDiffPath
    ], { timeoutMs: 180000 });

    const patch = await automationEngine.createFramePatch({
      patchId,
      videoId: String(payload.videoId || payload.sourceId || source.sourceRef || 'session-video'),
      timestampSec,
      fps: videoInfo.fps,
      region,
      instruction,
      provider,
      model,
      motionMethod: payload.motionMethod || 'optical_flow_reprojection',
      propagationWindowSec: payload.propagationWindowSec ?? payload.radiusSec ?? 0.6,
      status: 'executed',
      frameOriginalUri: absoluteToPublicAssetUri(frameOriginalPath) || frameOriginalPath,
      frameEditedUri: absoluteToPublicAssetUri(frameEditedPath) || frameEditedPath,
      diffVisualUri: absoluteToPublicAssetUri(frameDiffPath) || frameDiffPath,
      notes: 'Patch executado com ffmpeg e salvo como AI Patch Layer.'
    });

    const motion = payload.autoMotion === false
      ? null
      : await automationEngine.createMotionReconstruction({
        timestampSec: patch.frame.timestampSec,
        method: patch.propagation.method,
        radiusSec: patch.propagation.windowSec
      }).catch(() => null);

    return {
      patch,
      motion,
      source: {
        kind: source.sourceKind,
        ref: source.sourceRef
      },
      video: videoInfo,
      generatedImage: generatedImage ? {
        provider: generatedImage.provider,
        model: generatedImage.model
      } : null
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function executeIncrementalRenderRuntime(payload) {
  const ffmpeg = await getFfmpegHealth(false);
  if (!ffmpeg.available) {
    const error = new Error(`ffmpeg indisponível (${ffmpeg.command}).`);
    error.statusCode = 503;
    throw error;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'jv-render-'));
  const renderJobId = sanitizePathSegment(payload.renderJobId || randomUUID());
  const outputDir = join(DATA_ROOT, 'automation', 'renders', renderJobId);
  await ensureDirectory(outputDir);

  try {
    const source = await resolveLocalVideoSource({
      sourcePath: payload.sourcePath,
      sourceUrl: payload.sourceUrl,
      youtubeUrl: payload.youtubeUrl,
      tempDir
    });
    const videoInfo = await probeVideoInfo(source.sourceLocalPath);

    let renderPlan = payload.renderPlan && typeof payload.renderPlan === 'object'
      ? payload.renderPlan
      : null;

    let patchLayers = Array.isArray(payload.patchLayers) ? payload.patchLayers : [];
    if (!patchLayers.length) {
      const snapshot = await automationEngine.getStateSnapshot().catch(() => null);
      if (snapshot && Array.isArray(snapshot.patchLayers)) {
        patchLayers = snapshot.patchLayers.slice(0, 80);
      }
    }

    if (!renderPlan || !Array.isArray(renderPlan.segments)) {
      renderPlan = await automationEngine.createIncrementalRender({
        ...payload,
        durationSec: payload.durationSec || payload.videoDurationSec || videoInfo.duration || 60,
        fps: payload.fps || videoInfo.fps || 30,
        patchLayers
      });
    }

    const segments = Array.isArray(renderPlan.segments)
      ? [...renderPlan.segments].sort((a, b) => Number(a.start || 0) - Number(b.start || 0))
      : [];
    if (!segments.length) {
      const error = new Error('Render plan sem segmentos.');
      error.statusCode = 400;
      throw error;
    }

    const processedSegments = [];
    const fpsRounded = Math.max(12, Math.min(120, Math.round(Number(renderPlan.fps || videoInfo.fps || 30))));
    const audioBitrate = String(payload.audioBitrate || '128k');
    const preset = String(payload.preset || 'veryfast');
    const crf = String(Math.round(clampNumber(payload.crf ?? 20, 16, 35)));

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const start = Math.max(0, Number(segment.start || 0));
      const end = Math.max(start, Number(segment.end || 0));
      const duration = end - start;
      if (!Number.isFinite(duration) || duration < RENDER_SEGMENT_MIN_SEC) continue;

      const segmentPath = join(outputDir, `segment-${String(i + 1).padStart(4, '0')}.mp4`);
      const relevantPatches = patchLayers.filter((patch) => {
        const ts = getPatchTimestampSec(patch);
        if (!Number.isFinite(ts)) return false;
        if (ts < start - (1 / fpsRounded) || ts > end + (1 / fpsRounded)) return false;
        const status = String(patch?.status || '').trim().toLowerCase();
        const assetRef = patch?.assets?.frameEditedUri || patch?.assets?.frameEditedPath || '';
        return status === 'executed' && Boolean(assetRef);
      });

      let modeUsed = String(segment.mode || 'reencode').toLowerCase();
      if (modeUsed === 'copy' && !relevantPatches.length) {
        try {
          await runFfmpeg([
            '-y',
            '-ss', start.toFixed(3),
            '-i', source.sourceLocalPath,
            '-t', duration.toFixed(3),
            '-map', '0:v:0',
            '-map', '0:a?',
            '-c', 'copy',
            '-movflags', '+faststart',
            segmentPath
          ], { timeoutMs: 4 * 60 * 1000 });
        } catch (_error) {
          modeUsed = 'reencode';
        }
      } else {
        modeUsed = 'reencode';
      }

      if (modeUsed === 'reencode') {
        const args = [
          '-y',
          '-ss', start.toFixed(3),
          '-i', source.sourceLocalPath,
          '-t', duration.toFixed(3)
        ];

        const filterParts = [];
        let currentVideoLabel = '[0:v]';
        let overlayInputCount = 0;

        for (let p = 0; p < relevantPatches.length; p += 1) {
          const patch = relevantPatches[p];
          const ts = getPatchTimestampSec(patch);
          if (!Number.isFinite(ts)) continue;
          const assetRef = patch?.assets?.frameEditedUri || patch?.assets?.frameEditedPath || '';
          const assetPath = await resolvePatchImagePathFromReference(assetRef, tempDir, p).catch(() => '');
          if (!assetPath) continue;

          overlayInputCount += 1;
          const inputIndex = overlayInputCount;
          args.push('-loop', '1', '-i', assetPath);

          const patchLabel = `[p${inputIndex}]`;
          const outputLabel = `[v${inputIndex}]`;
          filterParts.push(`[${inputIndex}:v]scale=${videoInfo.width}:${videoInfo.height},format=rgba${patchLabel}`);

          const relativeStart = Math.max(0, ts - start);
          const relativeEnd = Math.min(duration, relativeStart + (1 / fpsRounded));
          filterParts.push(`${currentVideoLabel}${patchLabel}overlay=0:0:enable='between(t,${relativeStart.toFixed(3)},${relativeEnd.toFixed(3)})'${outputLabel}`);
          currentVideoLabel = outputLabel;
        }

        if (filterParts.length) {
          args.push('-filter_complex', filterParts.join(';'), '-map', currentVideoLabel);
        } else {
          args.push('-map', '0:v:0');
        }
        args.push(
          '-map', '0:a?',
          '-c:v', 'libx264',
          '-preset', preset,
          '-crf', crf,
          '-pix_fmt', 'yuv420p',
          '-r', String(fpsRounded),
          '-c:a', 'aac',
          '-b:a', audioBitrate,
          '-movflags', '+faststart',
          segmentPath
        );
        await runFfmpeg(args, { timeoutMs: 6 * 60 * 1000 });
      }

      processedSegments.push({
        index: processedSegments.length + 1,
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        duration: Number(duration.toFixed(3)),
        mode: modeUsed,
        patchCount: relevantPatches.length,
        filePath: segmentPath,
        fileUri: absoluteToPublicAssetUri(segmentPath) || segmentPath
      });
    }

    if (!processedSegments.length) {
      const error = new Error('Nenhum segmento válido gerado no render incremental.');
      error.statusCode = 422;
      throw error;
    }

    const concatListPath = join(outputDir, 'concat.txt');
    const concatList = processedSegments.map((item) => buildConcatListLine(item.filePath)).join('\n');
    await writeFile(concatListPath, `${concatList}\n`, 'utf8');

    const outputPath = join(outputDir, 'output.mp4');
    try {
      await runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath
      ], { timeoutMs: 6 * 60 * 1000 });
    } catch (_copyError) {
      await runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListPath,
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', crf,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', audioBitrate,
        '-movflags', '+faststart',
        outputPath
      ], { timeoutMs: 8 * 60 * 1000 });
    }

    return {
      renderJobId,
      source: {
        kind: source.sourceKind,
        ref: source.sourceRef
      },
      renderPlan,
      output: {
        path: outputPath,
        uri: absoluteToPublicAssetUri(outputPath) || outputPath
      },
      segments: processedSegments,
      stats: {
        totalSegments: processedSegments.length,
        reencodedSegments: processedSegments.filter((item) => item.mode === 'reencode').length,
        copiedSegments: processedSegments.filter((item) => item.mode === 'copy').length
      }
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function getYtDlpHealth(force = false) {
  const now = Date.now();
  if (!force && ytDlpHealthState.checkedAt && now - ytDlpHealthState.checkedAt < YT_DLP_HEALTH_TTL_MS) {
    return ytDlpHealthState;
  }
  if (ytDlpHealthPromise && !force) return ytDlpHealthPromise;

  ytDlpHealthPromise = (async () => {
    try {
      const result = await runYtDlp(['--version'], { timeoutMs: YT_DLP_HEALTH_TIMEOUT_MS });
      const versionLine = String(result.stdout || result.stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || 'version unknown';
      const command = String(result.command || YT_DLP_BIN || 'yt-dlp');
      ytDlpHealthState = {
        checkedAt: Date.now(),
        available: true,
        detail: versionLine,
        command
      };
    } catch (error) {
      ytDlpHealthState = {
        checkedAt: Date.now(),
        available: false,
        detail: error?.message || 'yt-dlp unavailable',
        command: YT_DLP_BIN || 'yt-dlp'
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
  const ytdlCore = await getYtdlCoreHealth(false);
  const ffmpeg = await getFfmpegHealth(false);
  const vaultElevenLabsKey = await keyVault.resolveProviderKeyValue('elevenlabs').catch(() => '');
  const vaultOpenAiKey = await keyVault.resolveProviderKeyValue('openai').catch(() => '');
  const vaultYoutubeCookies = await keyVault.resolveProviderKeyValue('youtube').catch(() => '');
  const hasElevenLabsKey = Boolean(ELEVENLABS_API_KEY || vaultElevenLabsKey);
  const hasOpenAiKey = Boolean(OPENAI_API_KEY || vaultOpenAiKey);
  const hasYoutubeCookies = Boolean(String(YOUTUBE_COOKIES || '').trim() || decodeBase64Utf8(YOUTUBE_COOKIES_BASE64) || vaultYoutubeCookies);
  const keyVaultStatus = keyVault.getStatus();
  const providerUsage = await keyVault.getUsageSnapshot().catch(() => ({}));
  const youtubeHttpFallbackReady = true;
  const youtubeBinaryOrLibReady = ytDlp.available || ytdlCore.available;
  return {
    ok: true,
    service: 'jv-video-studio',
    runtime: IS_SERVERLESS_RUNTIME ? 'serverless' : 'local-node',
    now: new Date().toISOString(),
    hasElevenLabsKey,
    hasOpenAiKey,
    hasYoutubeCookies,
    defaultAgentId: ELEVENLABS_AGENT_ID || null,
    directTranscribeReady: hasElevenLabsKey,
    youtubeMetadataReady: youtubeBinaryOrLibReady || youtubeHttpFallbackReady,
    youtubeTranscribeReady: hasElevenLabsKey && (youtubeBinaryOrLibReady || youtubeHttpFallbackReady),
    youtubeFallbackReady: youtubeHttpFallbackReady,
    keyVaultReady: keyVaultStatus.ready,
    keyVaultProviders: keyVaultStatus.providers,
    automationReady: true,
    providerUsage,
    imageGenerationReady: hasOpenAiKey,
    videoEditReady: ffmpeg.available,
    ffmpeg: {
      configured: ffmpeg.command,
      available: ffmpeg.available,
      detail: ffmpeg.detail
    },
    ytDlp: {
      configured: ytDlp.command,
      available: ytDlp.available,
      detail: ytDlp.detail
    },
    ytdlCore: {
      package: ytdlCore.package,
      available: ytdlCore.available,
      detail: ytdlCore.detail
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

async function generateImageWithGoogleNanoBanana({ prompt, apiKey, model }) {
  if (!apiKey) {
    const error = new Error('API key Google ausente para geração de imagem.');
    error.statusCode = 400;
    throw error;
  }
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    const error = new Error('Prompt vazio para geração de imagem Google.');
    error.statusCode = 400;
    throw error;
  }

  const selectedModel = String(model || env.GOOGLE_NANO_BANANA_MODEL || 'gemini-2.5-flash-image-preview').trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const requestBodies = [
    {
      contents: [{ role: 'user', parts: [{ text: normalizedPrompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE']
      }
    },
    {
      contents: [{ role: 'user', parts: [{ text: normalizedPrompt }] }],
      generation_config: {
        response_modalities: ['TEXT', 'IMAGE']
      }
    }
  ];

  let lastError = null;
  for (const body of requestBodies) {
    let upstream;
    try {
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (_error) {
      lastError = new Error('Falha de rede ao chamar Google image generation.');
      continue;
    }

    const raw = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      payload = { raw };
    }

    if (!upstream.ok) {
      const err = new Error(readUpstreamErrorMessage(payload, `Erro no provider Google (${upstream.status}).`));
      err.statusCode = upstream.status;
      err.upstream = payload;
      lastError = err;
      continue;
    }

    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    let imageData = '';
    candidates.forEach((candidate) => {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      parts.forEach((part) => {
        if (imageData) return;
        const inlineData = part?.inlineData || part?.inline_data;
        if (inlineData && typeof inlineData.data === 'string' && inlineData.data.trim()) {
          imageData = inlineData.data.trim();
        }
      });
    });

    if (!imageData) {
      lastError = new Error('Google não retornou imagem inlineData.');
      continue;
    }

    return {
      provider: 'google_nano_banana',
      model: selectedModel,
      imageDataUrl: `data:image/png;base64,${imageData}`,
      imageUrl: null
    };
  }

  throw lastError || new Error('Falha ao gerar imagem com Google Nano Banana.');
}

async function fetchYoutubeMetadataWithYtDlp(youtubeUrl, options = {}) {
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

  const tempDir = await mkdtemp(join(tmpdir(), 'jv-yt-meta-'));
  let output;
  try {
    const cookiesPath = await buildYoutubeCookiesFile(tempDir, options.youtubeCookies || '');
    const args = appendYtDlpJsRuntimeArgs(['--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json']);
    if (cookiesPath) args.push('--cookies', cookiesPath);
    args.push(youtubeUrl);
    const result = await runYtDlp(args, { timeoutMs: 120000, cwd: tempDir });
    output = String(result.stdout || '').trim();
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const detail = stderr ? stderr.split('\n').slice(-2).join(' | ') : '';
    const wrapped = new Error(detail || error.message || 'Falha ao ler metadados do YouTube.');
    wrapped.statusCode = 502;
    throw wrapped;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
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

async function fetchYoutubeMetadata(youtubeUrl, options = {}) {
  if (!isYoutubeUrl(youtubeUrl)) {
    const error = new Error('youtubeUrl inválida.');
    error.statusCode = 400;
    throw error;
  }

  const ytDlpHealth = await getYtDlpHealth(false);
  const errors = [];

  if (ytDlpHealth.available) {
    try {
      return await fetchYoutubeMetadataWithYtDlp(youtubeUrl, options);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  } else {
    errors.push(`yt-dlp indisponível (${ytDlpHealth.command}).`);
  }

  const ytdlCoreHealth = await getYtdlCoreHealth(false);
  if (ytdlCoreHealth.available) {
    try {
      return await fetchYoutubeMetadataWithYtdlCore(youtubeUrl);
    } catch (error) {
      errors.push(`ytdl-core: ${error?.message || String(error)}`);
    }
  } else {
    errors.push(`ytdl-core indisponível (${ytdlCoreHealth.detail}).`);
  }

  try {
    return await fetchYoutubeMetadataViaHttp(youtubeUrl);
  } catch (error) {
    const wrapped = new Error(
      `Falha ao ler metadados do YouTube via fallback HTTP.${errors.length ? ` Detalhes: ${errors.join(' | ')}` : ''} ${error?.message || ''}`.trim()
    );
    wrapped.statusCode = error?.statusCode || 502;
    throw wrapped;
  }
}

async function downloadYoutubeAudioWithYtDlp(youtubeUrl, options = {}) {
  if (!isYoutubeUrl(youtubeUrl)) {
    throw new Error('youtubeUrl inválida para download automático.');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'jv-yt-'));
  const attemptErrors = [];
  const strategies = [
    { label: 'default', extractorArgs: '' },
    { label: 'android+ios', extractorArgs: 'youtube:player_client=android,ios' },
    { label: 'tv+ios', extractorArgs: 'youtube:player_client=tv,ios' },
    { label: 'web_embedded+android', extractorArgs: 'youtube:player_client=web_embedded,android' }
  ];

  try {
    const cookiesPath = await buildYoutubeCookiesFile(tempDir, options.youtubeCookies || '');

    for (let i = 0; i < strategies.length; i += 1) {
      const strategy = strategies[i];
      const runDir = join(tempDir, `try-${i + 1}`);
      await mkdir(runDir, { recursive: true });
      const outTemplate = join(runDir, 'audio.%(ext)s');

      const args = [
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--socket-timeout',
        '20',
        '--extractor-retries',
        '2',
        '--fragment-retries',
        '2',
        '--retries',
        '2',
        '--newline',
        '--force-ipv4',
        '-f',
        'bestaudio[abr<=160]/bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '-o',
        outTemplate
      ];
      appendYtDlpJsRuntimeArgs(args);
      if (cookiesPath) {
        args.push('--cookies', cookiesPath);
      }
      if (strategy.extractorArgs) {
        args.push('--extractor-args', strategy.extractorArgs);
      }
      args.push(youtubeUrl);

      try {
        await runYtDlp(args, { timeoutMs: 240000, cwd: runDir });

        const files = (await readdir(runDir))
          .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'))
          .map((name) => ({ name, abs: join(runDir, name) }));

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

        if (chosenStat.size > MAX_TRANSCRIBE_MEDIA_BYTES) {
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
        attemptErrors.push(`${strategy.label}: ${summary || error?.message || error}`);
      }
    }

    throw new Error(
      `Falha ao baixar áudio via yt-dlp.${attemptErrors.length ? ` Detalhes: ${attemptErrors.join(' | ')}` : ''}`.trim()
    );
  } catch (error) {
    throw new Error(error?.message || 'Falha ao baixar áudio do YouTube via yt-dlp.');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function downloadYoutubeVideoWithYtDlp(youtubeUrl, options = {}) {
  if (!isYoutubeUrl(youtubeUrl)) {
    throw new Error('youtubeUrl inválida para ingestão.');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'jv-yt-video-'));
  const attemptErrors = [];
  const strategies = [
    { label: 'default', extractorArgs: '' },
    { label: 'android+ios', extractorArgs: 'youtube:player_client=android,ios' },
    { label: 'tv+ios', extractorArgs: 'youtube:player_client=tv,ios' },
    { label: 'web_embedded+android', extractorArgs: 'youtube:player_client=web_embedded,android' }
  ];

  try {
    const cookiesPath = await buildYoutubeCookiesFile(tempDir, options.youtubeCookies || '');

    for (let i = 0; i < strategies.length; i += 1) {
      const strategy = strategies[i];
      const runDir = join(tempDir, `try-${i + 1}`);
      await mkdir(runDir, { recursive: true });
      const outTemplate = join(runDir, 'video.%(ext)s');

      const args = [
        '--no-playlist',
        '--no-progress',
        '--no-warnings',
        '--socket-timeout',
        '20',
        '--extractor-retries',
        '2',
        '--fragment-retries',
        '2',
        '--retries',
        '2',
        '--newline',
        '--force-ipv4',
        '-f',
        'best[ext=mp4][vcodec!=none][acodec!=none][height<=1080]/best[vcodec!=none][acodec!=none][height<=1080]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best',
        '-o',
        outTemplate
      ];
      appendYtDlpJsRuntimeArgs(args);
      if (cookiesPath) {
        args.push('--cookies', cookiesPath);
      }
      if (strategy.extractorArgs) {
        args.push('--extractor-args', strategy.extractorArgs);
      }
      args.push(youtubeUrl);

      try {
        await runYtDlp(args, { timeoutMs: 300000, cwd: runDir });

        const files = (await readdir(runDir))
          .filter((name) => !name.endsWith('.part') && !name.endsWith('.ytdl'))
          .map((name) => ({ name, abs: join(runDir, name) }));

        if (!files.length) {
          throw new Error('yt-dlp não gerou arquivo de vídeo.');
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

        if (chosenStat.size > MAX_INGEST_MEDIA_BYTES) {
          throw new Error(
            `Vídeo muito grande para ingestão (${Math.round(chosenStat.size / 1024 / 1024)}MB). ` +
            `Limite atual: ${Math.round(MAX_INGEST_MEDIA_BYTES / 1024 / 1024)}MB.`
          );
        }

        const buffer = await readFile(chosen.abs);
        if (!buffer.length) {
          throw new Error('Arquivo de vídeo baixado está vazio.');
        }

        return {
          buffer,
          fileName: chosen.name,
          mimeType: inferMimeTypeFromName(chosen.name, 'video/mp4'),
          sizeBytes: chosenStat.size
        };
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw new Error('yt-dlp não encontrado. Instale o binário (`brew install yt-dlp`) ou `python3 -m pip install -U yt-dlp`.');
        }
        const stderr = String(error?.stderr || '').trim();
        const summary = stderr ? stderr.split('\n').slice(-2).join(' | ') : '';
        attemptErrors.push(`${strategy.label}: ${summary || error?.message || error}`);
      }
    }

    try {
      return await downloadYoutubeVideoViaYoutubei(youtubeUrl);
    } catch (youtubeiError) {
      attemptErrors.push(`youtubei.js: ${youtubeiError?.message || youtubeiError}`);
    }

    throw new Error(
      `Falha ao baixar vídeo via yt-dlp.${attemptErrors.length ? ` Detalhes: ${attemptErrors.join(' | ')}` : ''}`.trim()
    );
  } catch (error) {
    throw new Error(error?.message || 'Falha ao baixar vídeo do YouTube para ingestão.');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => { });
  }
}

async function downloadYoutubeAudio(youtubeUrl, options = {}) {
  if (!isYoutubeUrl(youtubeUrl)) {
    throw new Error('youtubeUrl inválida para download automático.');
  }

  const ytDlpHealth = await getYtDlpHealth(false);
  const errors = [];

  if (ytDlpHealth.available) {
    try {
      return await downloadYoutubeAudioWithYtDlp(youtubeUrl, options);
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  } else {
    errors.push(`yt-dlp indisponível (${ytDlpHealth.command}).`);
  }

  const ytdlCoreHealth = await getYtdlCoreHealth(false);
  if (ytdlCoreHealth.available) {
    try {
      return await downloadYoutubeAudioWithYtdlCore(youtubeUrl);
    } catch (error) {
      errors.push(`ytdl-core: ${error?.message || String(error)}`);
    }
  } else {
    errors.push(`ytdl-core indisponível (${ytdlCoreHealth.detail}).`);
  }

  try {
    return await downloadYoutubeAudioViaYoutubei(youtubeUrl);
  } catch (error) {
    errors.push(`youtubei.js: ${error?.message || String(error)}`);
  }

  try {
    return await downloadYoutubeAudioViaHttp(youtubeUrl);
  } catch (error) {
    throw new Error(
      `Falha ao baixar áudio do YouTube no ambiente atual.${errors.length ? ` Detalhes: ${errors.join(' | ')}` : ''} ${error?.message || ''}`.trim()
    );
  }
}

async function transcribeBufferWithElevenLabs({
  mediaBuffer,
  fileName,
  mimeType,
  modelId,
  languageCode,
  apiKey
}) {
  if (!mediaBuffer || !mediaBuffer.length) {
    throw new Error('Arquivo vazio para transcrição.');
  }
  if (mediaBuffer.length > MAX_TRANSCRIBE_MEDIA_BYTES) {
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
        'xi-api-key': apiKey || ELEVENLABS_API_KEY
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

function chooseCaptionTrack(captionTracks, preferredLanguage = '') {
  const tracks = Array.isArray(captionTracks) ? captionTracks : [];
  if (!tracks.length) return null;

  const preferred = String(preferredLanguage || '').trim().toLowerCase();
  if (preferred) {
    const exact = tracks.find((track) => String(track?.languageCode || '').trim().toLowerCase() === preferred);
    if (exact) return exact;
    const byPrefix = tracks.find((track) => String(track?.languageCode || '').trim().toLowerCase().startsWith(preferred));
    if (byPrefix) return byPrefix;
  }

  const preferredOrder = ['pt-BR', 'pt', 'en', 'es'];
  for (const lang of preferredOrder) {
    const match = tracks.find((track) => String(track?.languageCode || '').toLowerCase().startsWith(lang.toLowerCase()));
    if (match) return match;
  }

  const manual = tracks.find((track) => String(track?.kind || '').toLowerCase() !== 'asr');
  return manual || tracks[0];
}

function normalizeYoutubeiCaptionTrack(track) {
  const baseUrl = String(track?.baseUrl || track?.base_url || '').trim();
  if (!baseUrl) return null;

  const rawName = track?.name;
  const name = typeof rawName?.toString === 'function'
    ? String(rawName.toString()).trim()
    : String(rawName?.text || '').trim();

  return {
    baseUrl,
    languageCode: String(track?.languageCode || track?.language_code || '').trim(),
    kind: String(track?.kind || '').trim(),
    name: name || null
  };
}

async function fetchYoutubeCaptionTracksViaYoutubei(videoId) {
  const Innertube = await getYoutubeiModule();
  const youtube = await Innertube.create({
    retrieve_player: false,
    generate_session_locally: true,
    fail_fast: false
  });

  const clients = ['IOS', 'ANDROID'];
  const errors = [];

  for (const client of clients) {
    try {
      const info = await youtube.getBasicInfo(videoId, { client });
      const tracks = (Array.isArray(info?.captions?.caption_tracks) ? info.captions.caption_tracks : [])
        .map((track) => normalizeYoutubeiCaptionTrack(track))
        .filter(Boolean);

      if (tracks.length) {
        return { tracks, client };
      }

      errors.push(`${client}: sem caption_tracks`);
    } catch (error) {
      const message = String(error?.message || error).replace(/\s+/g, ' ').trim();
      errors.push(`${client}: ${message}`);
    }
  }

  const err = new Error(
    `youtubei.js não retornou caption tracks.${errors.length ? ` Detalhes: ${errors.join(' | ')}` : ''}`.trim()
  );
  err.statusCode = 422;
  throw err;
}

function buildWordsFromCaptionEvents(events) {
  const words = [];
  const segments = [];
  let totalText = '';

  (Array.isArray(events) ? events : []).forEach((event) => {
    const segs = Array.isArray(event?.segs) ? event.segs : [];
    const rawText = segs.map((seg) => String(seg?.utf8 || '')).join('');
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (!text || /^\[[^\]]+\]$/.test(text)) return;

    const startSec = Math.max(0, Number(event?.tStartMs || 0) / 1000);
    const durationSec = Math.max(0.25, Number(event?.dDurationMs || 0) / 1000);
    const tokenList = text.split(/\s+/).filter(Boolean);
    if (!tokenList.length) return;

    const perTokenSec = Math.max(0.08, durationSec / tokenList.length);
    const segmentWords = tokenList.map((token, index) => {
      const tokenStart = startSec + (index * perTokenSec);
      const tokenEnd = Math.min(startSec + durationSec, tokenStart + perTokenSec);
      const entry = {
        word: token,
        text: token,
        start: Number(tokenStart.toFixed(3)),
        end: Number(tokenEnd.toFixed(3))
      };
      words.push(entry);
      return entry;
    });

    const segmentEnd = startSec + durationSec;
    segments.push({
      start: Number(startSec.toFixed(3)),
      end: Number(segmentEnd.toFixed(3)),
      text,
      words: segmentWords
    });

    totalText += `${text} `;
  });

  return {
    text: totalText.trim(),
    words,
    segments
  };
}

function parseYoutubeCaptionsPayload(captionsRaw) {
  let captionsPayload;
  try {
    captionsPayload = JSON.parse(captionsRaw);
  } catch (_error) {
    const cleaned = String(captionsRaw || '').replace(/\s+/g, ' ').trim();
    const withPrefixRemoved = cleaned.replace(/^\)\]\}'\s*/, '');
    try {
      captionsPayload = JSON.parse(withPrefixRemoved);
    } catch (_secondError) {
      const snippet = withPrefixRemoved.slice(0, 220);
      const error = new Error(`YouTube captions retornou payload inválido. sample="${snippet}"`);
      error.statusCode = 502;
      throw error;
    }
  }

  if (!captionsPayload || typeof captionsPayload !== 'object') {
    const error = new Error('YouTube captions retornou payload inválido.');
    error.statusCode = 502;
    throw error;
  }

  return captionsPayload;
}

async function fetchYoutubeCaptionsPayloadFromTrack(track) {
  const captionsUrl = new URL(String(track.baseUrl || ''));
  captionsUrl.searchParams.set('fmt', 'json3');

  const captionsResponse = await fetch(captionsUrl.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': YOUTUBE_FETCH_USER_AGENT,
      Referer: 'https://www.youtube.com/'
    }
  });
  if (!captionsResponse.ok) {
    const error = new Error(`Falha ao baixar captions do YouTube (HTTP ${captionsResponse.status}).`);
    error.statusCode = captionsResponse.status;
    throw error;
  }

  const captionsRaw = await captionsResponse.text();
  return parseYoutubeCaptionsPayload(captionsRaw);
}

async function transcribeFromYoutubeCaptionsWithVideoId(videoId, languageCode = '') {
  const playerResponse = await fetchYoutubePlayerResponse(videoId);
  let captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let captionTrackSource = 'youtube_player_response';
  const trackErrors = [];

  const loadYoutubeiTracks = async () => {
    const youtubeiResult = await fetchYoutubeCaptionTracksViaYoutubei(videoId);
    captionTracks = youtubeiResult.tracks;
    captionTrackSource = `youtubei_${String(youtubeiResult.client || 'fallback').toLowerCase()}`;
  };

  if (!Array.isArray(captionTracks) || !captionTracks.length) {
    trackErrors.push('playerResponse sem captionTracks');
    try {
      await loadYoutubeiTracks();
    } catch (youtubeiError) {
      trackErrors.push(`youtubei.js: ${youtubeiError?.message || youtubeiError}`);
    }
  }

  let selectedTrack = chooseCaptionTrack(captionTracks, languageCode);
  if (!selectedTrack?.baseUrl) {
    if (!String(captionTrackSource).startsWith('youtubei_')) {
      try {
        await loadYoutubeiTracks();
        selectedTrack = chooseCaptionTrack(captionTracks, languageCode);
      } catch (youtubeiError) {
        trackErrors.push(`youtubei.js (retry): ${youtubeiError?.message || youtubeiError}`);
      }
    }
  }

  if (!selectedTrack?.baseUrl) {
    const error = new Error(
      `Este vídeo não possui faixa de captions disponível para fallback.${trackErrors.length ? ` Detalhes: ${trackErrors.join(' | ')}` : ''}`.trim()
    );
    error.statusCode = 422;
    throw error;
  }

  let captionsPayload;
  try {
    captionsPayload = await fetchYoutubeCaptionsPayloadFromTrack(selectedTrack);
  } catch (captionsError) {
    if (String(captionTrackSource).startsWith('youtubei_')) {
      throw captionsError;
    }
    trackErrors.push(`player captions fetch: ${captionsError?.message || captionsError}`);
    try {
      await loadYoutubeiTracks();
      selectedTrack = chooseCaptionTrack(captionTracks, languageCode);
      if (!selectedTrack?.baseUrl) {
        const noTrackErr = new Error('youtubei.js não retornou faixa de captions utilizável.');
        noTrackErr.statusCode = 422;
        throw noTrackErr;
      }
      captionsPayload = await fetchYoutubeCaptionsPayloadFromTrack(selectedTrack);
    } catch (youtubeiRetryError) {
      const error = new Error(
        `Falha ao baixar captions do YouTube.${trackErrors.length ? ` Detalhes: ${trackErrors.join(' | ')}` : ''} ${youtubeiRetryError?.message || youtubeiRetryError}`.trim()
      );
      error.statusCode = youtubeiRetryError?.statusCode || captionsError?.statusCode || 502;
      throw error;
    }
  }

  const { text, words, segments } = buildWordsFromCaptionEvents(captionsPayload?.events);
  if (!words.length) {
    const error = new Error('Captions do YouTube vazias para este vídeo.');
    error.statusCode = 422;
    throw error;
  }

  return {
    text,
    words,
    segments,
    language_code: String(selectedTrack.languageCode || languageCode || ''),
    caption_source: captionTrackSource,
    source: 'youtube_captions_fallback',
    model_id: 'youtube_captions',
    warning: 'Fallback automático: áudio do YouTube indisponível no ambiente atual, usando captions do próprio vídeo.'
  };
}

async function transcribeFromYoutubeCaptionsFallback(youtubeUrl, languageCode = '') {
  const originalVideoId = extractYoutubeVideoId(youtubeUrl);
  if (!originalVideoId) {
    const error = new Error('Não foi possível extrair videoId para fallback de captions.');
    error.statusCode = 400;
    throw error;
  }

  const candidates = buildYoutubeVideoIdCandidates(originalVideoId);
  const failures = [];

  for (const candidate of candidates) {
    try {
      const payload = await transcribeFromYoutubeCaptionsWithVideoId(candidate, languageCode);
      if (candidate !== originalVideoId) {
        payload.warning = `${payload.warning} ID corrigido automaticamente para "${candidate}".`;
        payload.resolved_video_id = candidate;
      }
      return payload;
    } catch (error) {
      failures.push(`[${candidate}] ${error?.message || error}`);
    }
  }

  const hint = buildYoutubeVideoIdHint(originalVideoId);
  const error = new Error(
    `Este vídeo não possui faixa de captions disponível para fallback.${hint ? ` ${hint}` : ''}${failures.length ? ` Detalhes: ${failures.join(' | ')}` : ''}`.trim()
  );
  error.statusCode = 422;
  throw error;
}

function buildSyntheticWordsFromText({ text, durationSec }) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const baseTokens = normalized.split(/\s+/).filter(Boolean);
  if (!baseTokens.length) return [];

  const duration = clampNumber(durationSec || 60, 10, 3 * 60 * 60);
  const targetWords = Math.max(80, Math.min(1200, Math.round(duration / 0.7)));
  const step = duration / targetWords;
  const words = [];
  for (let i = 0; i < targetWords; i += 1) {
    const token = baseTokens[i % baseTokens.length];
    const start = i * step;
    const end = Math.min(duration, start + (step * 0.92));
    words.push({
      word: token,
      text: token,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3))
    });
  }
  return words;
}

async function transcribeFromYoutubeSyntheticFallback(youtubeUrl) {
  const metadata = await fetchYoutubeMetadata(youtubeUrl).catch(() => null);
  const videoId = extractYoutubeVideoId(youtubeUrl) || (metadata?.videoId || '');
  const title = String(metadata?.title || `YouTube video ${videoId}` || 'YouTube video').trim();
  const uploader = String(metadata?.uploader || '').trim();
  const durationSec = Number(metadata?.duration || 60);
  const syntheticText = uploader ? `${title} ${uploader}` : title;
  const words = buildSyntheticWordsFromText({ text: syntheticText, durationSec });
  if (!words.length) {
    const error = new Error('Falha ao gerar fallback sintético para captions.');
    error.statusCode = 502;
    throw error;
  }

  const segments = [];
  for (let i = 0; i < words.length; i += 6) {
    const chunk = words.slice(i, i + 6);
    if (!chunk.length) continue;
    segments.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map((entry) => entry.word).join(' '),
      words: chunk
    });
  }

  return {
    text: words.map((entry) => entry.word).join(' '),
    words,
    segments,
    language_code: 'auto',
    source: 'youtube_synthetic_fallback',
    model_id: 'synthetic_timeline_fallback',
    warning: 'Fallback de emergência: sem acesso ao áudio/captions reais no ambiente atual; legendas temporais sintéticas geradas para manter o fluxo funcional.'
  };
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
  const vaultElevenLabsKey = await keyVault.resolveProviderKeyValue('elevenlabs').catch(() => '');
  const activeElevenLabsKey = ELEVENLABS_API_KEY || vaultElevenLabsKey;

  if (!activeElevenLabsKey) {
    sendJson(res, 500, {
      error: 'ELEVENLABS_API_KEY não definida. Configure no ambiente ou no Key Vault.'
    });
    return;
  }

  const rate = await keyVault.consumeRateLimit('elevenlabs', {
    limitPerMinute: Number(env.ELEVENLABS_RATE_LIMIT_PER_MIN || 25),
    windowMs: 60000
  }).catch(() => ({ ok: true, remaining: 0 }));
  if (!rate.ok) {
    sendJson(res, 429, {
      error: 'Rate limit de transcrição atingido para ElevenLabs.',
      retryAt: new Date(Number(rate.resetAt || Date.now() + 60000)).toISOString()
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
  const sourceUrl = String(body.sourceUrl || '').trim();
  const requestedFileName = String(body.fileName || `media-${Date.now()}.mp4`);
  const requestedMimeType = String(body.mimeType || 'video/mp4');
  const modelId = String(body.modelId || 'scribe_v1');
  const languageCode = body.languageCode ? String(body.languageCode) : '';
  const youtubeCookies = String(body.youtubeCookies || '').trim();
  const youtubeCookiesBase64 = String(body.youtubeCookiesBase64 || '').trim();
  const requestYoutubeCookies = youtubeCookies || decodeBase64Utf8(youtubeCookiesBase64);
  const allowSyntheticFallback = body.allowSyntheticFallback === true || String(body.allowSyntheticFallback || '').trim().toLowerCase() === 'true';
  const resolvedYoutubeCookies = youtubeUrl ? await resolveYoutubeCookiesRaw(requestYoutubeCookies) : '';

  if (!base64Data && !youtubeUrl && !sourceUrl) {
    sendJson(res, 400, { error: 'Envie base64Data, sourceUrl ou youtubeUrl para transcrição.' });
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[transcribe] request start source=${youtubeUrl ? 'youtube' : (sourceUrl ? 'remote_url' : 'upload')} model=${modelId}`);

  let mediaBuffer;
  let fileName = requestedFileName;
  let mimeType = requestedMimeType;
  try {
    if (youtubeUrl) {
      const downloaded = await downloadYoutubeAudio(youtubeUrl, { youtubeCookies: resolvedYoutubeCookies });
      mediaBuffer = downloaded.buffer;
      fileName = downloaded.fileName;
      mimeType = downloaded.mimeType;
    } else if (sourceUrl) {
      if (!/^https?:\/\//i.test(sourceUrl)) {
        const error = new Error('sourceUrl inválida. Use URL http/https.');
        error.statusCode = 400;
        throw error;
      }
      const downloaded = await downloadHttpMediaToBuffer(sourceUrl, MAX_TRANSCRIBE_MEDIA_BYTES);
      mediaBuffer = downloaded.buffer;
      fileName = downloaded.fileName || requestedFileName;
      mimeType = downloaded.mimeType || requestedMimeType;
    } else {
      mediaBuffer = Buffer.from(base64Data, 'base64');
      if (!mediaBuffer.length) throw new Error('Arquivo base64 inválido ou vazio.');
    }
  } catch (error) {
    if (youtubeUrl) {
      try {
        const fallbackPayload = await transcribeFromYoutubeCaptionsFallback(youtubeUrl, languageCode);
        // eslint-disable-next-line no-console
        console.warn('[transcribe] youtube audio unavailable, returning captions fallback:', error?.message || error);
        sendJson(res, 200, fallbackPayload);
        return;
      } catch (fallbackError) {
        if (allowSyntheticFallback) {
          try {
            const syntheticFallback = await transcribeFromYoutubeSyntheticFallback(youtubeUrl);
            // eslint-disable-next-line no-console
            console.warn('[transcribe] fallback to synthetic transcript:', fallbackError?.message || fallbackError);
            sendJson(res, 200, syntheticFallback);
            return;
          } catch (syntheticError) {
            const combined = `${error?.message || 'Falha ao preparar mídia.'} | Fallback captions: ${fallbackError?.message || fallbackError} | Fallback sintético: ${syntheticError?.message || syntheticError}`;
            sendJson(res, syntheticError?.statusCode || fallbackError?.statusCode || error.statusCode || 400, { error: combined });
            return;
          }
        }

        const videoIdHint = buildYoutubeVideoIdHint(extractYoutubeVideoId(youtubeUrl));
        const combined = `${error?.message || 'Falha ao preparar mídia.'} | Fallback captions: ${fallbackError?.message || fallbackError}`;
        const needsCookies = /sign in to confirm you'?re not a bot/i.test(combined);
        const cookiesHint = needsCookies && !resolvedYoutubeCookies
          ? 'Dica: configure YOUTUBE_COOKIES (Netscape cookies.txt ou JSON exportado) para desbloquear vídeos protegidos por bot-check.'
          : '';
        const serverlessHint = needsCookies && IS_SERVERLESS_RUNTIME
          ? 'Ambiente serverless pode continuar bloqueado por IP de datacenter. Use backend local e abra: https://voidclip.vercel.app/?backend=http://127.0.0.1:8787'
          : '';
        const message = [
          'Não foi possível obter áudio/captions reais deste vídeo no ambiente atual.',
          videoIdHint,
          cookiesHint,
          serverlessHint,
          `Detalhes: ${combined}`
        ].filter(Boolean).join(' ');
        sendJson(res, fallbackError?.statusCode || error.statusCode || 422, {
          error: message,
          source: 'youtube_transcription_unavailable'
        });
        return;
      }
    }
    sendJson(res, error.statusCode || 400, { error: error.message || 'Falha ao preparar mídia para transcrição.' });
    return;
  }

  try {
    const payload = await transcribeBufferWithElevenLabs({
      mediaBuffer,
      fileName,
      mimeType,
      modelId,
      languageCode,
      apiKey: activeElevenLabsKey
    });
    // eslint-disable-next-line no-console
    console.log('[transcribe] request success');
    await keyVault.recordProviderUsage('elevenlabs', { costUsd: Number(env.ELEVENLABS_ESTIMATED_COST_PER_TRANSCRIBE || 0) }).catch(() => { });
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
  const youtubeCookies = String(body.youtubeCookies || '').trim();
  const youtubeCookiesBase64 = String(body.youtubeCookiesBase64 || '').trim();
  const requestYoutubeCookies = youtubeCookies || decodeBase64Utf8(youtubeCookiesBase64);
  if (!youtubeUrl) {
    sendJson(res, 400, { error: 'youtubeUrl é obrigatória.' });
    return;
  }

  try {
    const metadata = await fetchYoutubeMetadata(youtubeUrl, { youtubeCookies: requestYoutubeCookies });
    sendJson(res, 200, metadata);
  } catch (error) {
    sendJson(res, error.statusCode || 502, { error: error.message || 'Falha ao buscar metadados do YouTube.' });
  }
}

async function handleYoutubeIngest(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const youtubeUrl = String(body.youtubeUrl || '').trim();
  const youtubeCookies = String(body.youtubeCookies || '').trim();
  const youtubeCookiesBase64 = String(body.youtubeCookiesBase64 || '').trim();
  const requestYoutubeCookies = youtubeCookies || decodeBase64Utf8(youtubeCookiesBase64);
  if (!youtubeUrl) {
    sendJson(res, 400, { error: 'youtubeUrl é obrigatória.' });
    return;
  }
  if (!isYoutubeUrl(youtubeUrl)) {
    sendJson(res, 400, { error: 'youtubeUrl inválida para ingestão.' });
    return;
  }

  const resolvedYoutubeCookies = await resolveYoutubeCookiesRaw(requestYoutubeCookies);
  let metadata = null;
  try {
    metadata = await fetchYoutubeMetadata(youtubeUrl, { youtubeCookies: resolvedYoutubeCookies });
  } catch (_error) {
    metadata = null;
  }
  if (Number.isFinite(Number(metadata?.duration || 0)) && Number(metadata?.duration || 0) > MAX_INGEST_DURATION_SECONDS) {
    sendJson(res, 413, {
      error: `Vídeo muito longo para ingestão automática (${Math.round(Number(metadata?.duration || 0))}s). Limite atual: ${Math.round(MAX_INGEST_DURATION_SECONDS)}s.`,
      duration: Number(metadata?.duration || 0),
      maxDuration: MAX_INGEST_DURATION_SECONDS
    });
    return;
  }

  let downloaded;
  try {
    downloaded = await downloadYoutubeVideoWithYtDlp(youtubeUrl, { youtubeCookies: resolvedYoutubeCookies });
  } catch (error) {
    const details = String(error?.message || 'Falha ao baixar vídeo do YouTube.');
    const videoIdHint = buildYoutubeVideoIdHint(extractYoutubeVideoId(youtubeUrl));
    const needsCookies = /sign in to confirm you'?re not a bot/i.test(details);
    const cookiesHint = needsCookies && !resolvedYoutubeCookies
      ? 'Dica: configure YouTube cookies (Netscape cookies.txt ou JSON exportado) para vídeos com bot-check.'
      : '';
    const serverlessHint = needsCookies && IS_SERVERLESS_RUNTIME
      ? 'Ambiente serverless pode continuar bloqueado por IP de datacenter. Use backend local e abra: https://voidclip.vercel.app/?backend=http://127.0.0.1:8787'
      : '';
    const message = [
      'Não foi possível ingerir este vídeo do YouTube no ambiente atual.',
      videoIdHint,
      cookiesHint,
      serverlessHint,
      `Detalhes: ${details}`
    ].filter(Boolean).join(' ');
    sendJson(res, error?.statusCode || 422, { error: message });
    return;
  }

  const videoId = String(metadata?.videoId || extractYoutubeVideoId(youtubeUrl) || '').trim();
  const title = String(metadata?.title || '').trim();
  const label = title || (videoId ? `YouTube ${videoId}` : 'YouTube ingested video');
  const duration = Number(metadata?.duration || 0);
  const safeHeader = (value) => encodeURIComponent(String(value || '').slice(0, 220));
  const fallbackFile = `youtube-${videoId || createHash('sha1').update(youtubeUrl).digest('hex').slice(0, 10)}.mp4`;
  const fileName = sanitizePathSegment(downloaded.fileName || fallbackFile, fallbackFile);

  setCorsHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', downloaded.mimeType || 'video/mp4');
  res.setHeader('Content-Length', String(Number(downloaded.sizeBytes || downloaded.buffer?.length || 0)));
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Type, Content-Length, Content-Disposition, X-Source-Duration, X-Source-Title, X-Source-Label, X-Source-Video-Id, X-Source-Bytes'
  );
  res.setHeader('X-Source-Video-Id', safeHeader(videoId));
  res.setHeader('X-Source-Title', safeHeader(title));
  res.setHeader('X-Source-Label', safeHeader(label));
  res.setHeader('X-Source-Duration', Number.isFinite(duration) && duration > 0 ? String(duration) : '');
  res.setHeader('X-Source-Bytes', String(downloaded.sizeBytes || downloaded.buffer?.length || 0));
  res.end(downloaded.buffer);
}

async function handleAgentSignedUrl(req, res, requestUrl) {
  const requestedAgentId = String(requestUrl.searchParams.get('agentId') || ELEVENLABS_AGENT_ID || '').trim();
  if (!requestedAgentId) {
    sendJson(res, 400, { error: 'agentId ausente.' });
    return;
  }

  const vaultElevenLabsKey = await keyVault.resolveProviderKeyValue('elevenlabs').catch(() => '');
  const activeElevenLabsKey = ELEVENLABS_API_KEY || vaultElevenLabsKey;

  if (!activeElevenLabsKey) {
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
        'xi-api-key': activeElevenLabsKey
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

  const vaultOpenAiKey = await keyVault.resolveProviderKeyValue('openai').catch(() => '');
  const apiKey = requestKey || OPENAI_API_KEY || vaultOpenAiKey;
  if (!apiKey) {
    sendJson(res, 400, { error: 'API key ausente. Salve sua key na aba Complementar Vídeo ou configure OPENAI_API_KEY.' });
    return;
  }

  const rate = await keyVault.consumeRateLimit('openai', {
    limitPerMinute: Number(env.OPENAI_RATE_LIMIT_PER_MIN || 12),
    windowMs: 60000
  }).catch(() => ({ ok: true, remaining: 0 }));
  if (!rate.ok) {
    sendJson(res, 429, {
      error: 'Rate limit de geração de imagem atingido para OpenAI.',
      retryAt: new Date(Number(rate.resetAt || Date.now() + 60000)).toISOString()
    });
    return;
  }

  try {
    const result = await generateImageWithOpenAI({ prompt, apiKey, model, size });
    await keyVault.recordProviderUsage('openai', { costUsd: Number(env.OPENAI_ESTIMATED_COST_PER_IMAGE || 0) }).catch(() => { });
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

async function handleProviderKeysList(_req, res) {
  try {
    const keys = await keyVault.listProviderKeys();
    const usage = await keyVault.getUsageSnapshot().catch(() => ({}));
    sendJson(res, 200, {
      ok: true,
      status: keyVault.getStatus(),
      keys,
      usage
    });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao listar keys.' });
  }
}

async function handleProviderKeysSave(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const provider = String(body.provider || '').trim();
  const apiKey = String(body.apiKey || '').trim();
  const label = String(body.label || 'default').trim();
  if (!provider || !apiKey) {
    sendJson(res, 400, { error: 'provider e apiKey são obrigatórios.' });
    return;
  }

  try {
    const saved = await keyVault.saveProviderKey({ provider, apiKey, label });
    sendJson(res, 200, { ok: true, key: saved });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao salvar key.' });
  }
}

async function handleProviderKeysRemove(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 256 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const provider = String(body.provider || '').trim();
  const id = String(body.id || '').trim();
  const label = String(body.label || '').trim();
  if (!provider || (!id && !label)) {
    sendJson(res, 400, { error: 'provider e id/label são obrigatórios para remoção.' });
    return;
  }

  try {
    const removed = await keyVault.removeProviderKey({ provider, id, label });
    sendJson(res, 200, { ok: true, ...removed });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao remover key.' });
  }
}

async function handleAutomationIngest(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 2 * 1024 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  try {
    const result = await automationEngine.runIngestAnalysis(body);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao analisar ingestão.' });
  }
}

async function handleAutomationFramePatch(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 1024 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  try {
    const result = await automationEngine.createFramePatch(body);
    sendJson(res, 200, { ok: true, patch: result });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao criar patch de frame.' });
  }
}

async function handleAutomationMotionReconstruct(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 1024 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  try {
    const result = await automationEngine.createMotionReconstruction(body);
    sendJson(res, 200, { ok: true, motion: result });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao gerar plano de motion reconstruction.' });
  }
}

async function handleAutomationIncrementalRender(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 1024 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  try {
    const result = await automationEngine.createIncrementalRender(body);
    sendJson(res, 200, { ok: true, renderPlan: result });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao planejar render incremental.' });
  }
}

async function handleWorkflowTemplates(_req, res) {
  try {
    const templates = await automationEngine.listTemplates();
    sendJson(res, 200, { ok: true, templates });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Falha ao listar templates.' });
  }
}

async function handleWorkflowTemplateApply(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  try {
    const workflow = await automationEngine.applyTemplate(body);
    sendJson(res, 200, { ok: true, workflow });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao aplicar template.' });
  }
}

async function handleAutomationSnapshot(_req, res) {
  try {
    const snapshot = await automationEngine.getStateSnapshot();
    sendJson(res, 200, { ok: true, snapshot });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Falha ao buscar snapshot de automação.' });
  }
}

async function handleKeysApi(req, res) {
  if (req.method === 'GET') {
    await handleProviderKeysList(req, res);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const action = String(body.action || 'save_key').trim().toLowerCase();
  if (action === 'remove_key') {
    const provider = String(body.provider || '').trim();
    const id = String(body.id || '').trim();
    const label = String(body.label || '').trim();
    if (!provider || (!id && !label)) {
      sendJson(res, 400, { error: 'provider e id/label são obrigatórios para remoção.' });
      return;
    }
    try {
      const removed = await keyVault.removeProviderKey({ provider, id, label });
      sendJson(res, 200, { ok: true, ...removed });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao remover key.' });
    }
    return;
  }

  const provider = String(body.provider || '').trim();
  const apiKey = String(body.apiKey || '').trim();
  const label = String(body.label || 'default').trim();
  if (!provider || !apiKey) {
    sendJson(res, 400, { error: 'provider e apiKey são obrigatórios.' });
    return;
  }
  try {
    const saved = await keyVault.saveProviderKey({ provider, apiKey, label });
    sendJson(res, 200, { ok: true, key: saved });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao salvar key.' });
  }
}

async function handleAutomationApi(req, res) {
  if (req.method === 'GET') {
    await handleAutomationSnapshot(req, res);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, 2 * 1024 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const action = String(body.action || '').trim().toLowerCase();
  if (action === 'ingest') {
    const result = await automationEngine.runIngestAnalysis(body).catch((error) => ({ __error: error }));
    if (result && result.__error) {
      sendJson(res, result.__error.statusCode || 500, { error: result.__error.message || 'Falha ao analisar ingestão.' });
      return;
    }
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (action === 'frame_patch') {
    const result = await automationEngine.createFramePatch(body).catch((error) => ({ __error: error }));
    if (result && result.__error) {
      sendJson(res, result.__error.statusCode || 500, { error: result.__error.message || 'Falha ao criar patch de frame.' });
      return;
    }
    sendJson(res, 200, { ok: true, patch: result });
    return;
  }

  if (action === 'frame_patch_execute') {
    const result = await executeFramePatchRuntime(body).catch((error) => ({ __error: error }));
    if (result && result.__error) {
      sendJson(res, result.__error.statusCode || 500, {
        error: result.__error.message || 'Falha ao executar patch de frame.'
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (action === 'motion_reconstruct') {
    const result = await automationEngine.createMotionReconstruction(body).catch((error) => ({ __error: error }));
    if (result && result.__error) {
      sendJson(res, result.__error.statusCode || 500, { error: result.__error.message || 'Falha ao gerar plano de motion reconstruction.' });
      return;
    }
    sendJson(res, 200, { ok: true, motion: result });
    return;
  }

  if (action === 'render_incremental') {
    const result = await automationEngine.createIncrementalRender(body).catch((error) => ({ __error: error }));
    if (result && result.__error) {
      sendJson(res, result.__error.statusCode || 500, { error: result.__error.message || 'Falha ao planejar render incremental.' });
      return;
    }
    sendJson(res, 200, { ok: true, renderPlan: result });
    return;
  }

  if (action === 'render_execute') {
    const result = await executeIncrementalRenderRuntime(body).catch((error) => ({ __error: error }));
    if (result && result.__error) {
      sendJson(res, result.__error.statusCode || 500, {
        error: result.__error.message || 'Falha ao executar render incremental.'
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  sendJson(res, 400, {
    error: 'action inválida. Use: ingest, frame_patch, frame_patch_execute, motion_reconstruct, render_incremental, render_execute.'
  });
}

async function handleWorkflowApi(req, res) {
  if (req.method === 'GET') {
    await handleWorkflowTemplates(req, res);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, 512 * 1024);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'Invalid body.' });
    return;
  }

  const action = String(body.action || 'apply_template').trim().toLowerCase();
  if (action !== 'apply_template') {
    sendJson(res, 400, { error: 'action inválida para workflow. Use: apply_template.' });
    return;
  }
  try {
    const workflow = await automationEngine.applyTemplate(body);
    sendJson(res, 200, { ok: true, workflow });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || 'Falha ao aplicar template.' });
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
      youtubeFallbackReady: true,
      keyVaultReady: keyVault.getStatus().ready,
      keyVaultProviders: keyVault.getStatus().providers,
      automationReady: true,
      imageGenerationReady: Boolean(OPENAI_API_KEY),
      videoEditReady: false,
      ffmpeg: {
        configured: FFMPEG_BIN,
        available: false,
        detail: 'Unable to probe ffmpeg.'
      },
      ytDlp: {
        configured: YT_DLP_BIN,
        available: false,
        detail: error?.message || 'Unable to probe yt-dlp.'
      },
      ytdlCore: {
        package: '@distube/ytdl-core',
        available: false,
        detail: 'Unable to probe @distube/ytdl-core.'
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

  if (pathname === '/api/keys') {
    await handleKeysApi(req, res);
    return;
  }

  if (pathname === '/api/automation') {
    await handleAutomationApi(req, res);
    return;
  }

  if (pathname === '/api/workflow') {
    await handleWorkflowApi(req, res);
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

  if (pathname === '/api/youtube/ingest') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleYoutubeIngest(req, res);
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

  if (pathname === '/api/keys/list') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleProviderKeysList(req, res);
    return;
  }

  if (pathname === '/api/keys/save') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleProviderKeysSave(req, res);
    return;
  }

  if (pathname === '/api/keys/remove') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleProviderKeysRemove(req, res);
    return;
  }

  if (pathname === '/api/automation/ingest') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleAutomationIngest(req, res);
    return;
  }

  if (pathname === '/api/automation/frame/patch') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleAutomationFramePatch(req, res);
    return;
  }

  if (pathname === '/api/automation/motion/reconstruct') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleAutomationMotionReconstruct(req, res);
    return;
  }

  if (pathname === '/api/automation/render/incremental') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleAutomationIncrementalRender(req, res);
    return;
  }

  if (pathname === '/api/automation/snapshot') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleAutomationSnapshot(req, res);
    return;
  }

  if (pathname === '/api/workflow/templates') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleWorkflowTemplates(req, res);
    return;
  }

  if (pathname === '/api/workflow/templates/apply') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    await handleWorkflowTemplateApply(req, res);
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
    console.log(keyVault.getStatus().ready
      ? '[server] Key Vault ready: encrypted multi-provider keys enabled'
      : '[server] Key Vault not ready: set KEY_VAULT_MASTER_KEY to enable encrypted key storage');
    // eslint-disable-next-line no-console
    console.log((String(YOUTUBE_COOKIES || '').trim() || decodeBase64Utf8(YOUTUBE_COOKIES_BASE64))
      ? '[server] YouTube cookies detected in env: bot-check protected videos have better extraction odds'
      : '[server] YouTube cookies missing: bot-check protected videos may fail extraction');
    // eslint-disable-next-line no-console
    console.log(`[server] YouTube auto-transcribe: yt-dlp=${YT_DLP_BIN} with HTTP fallback enabled`);
    getYtdlCoreHealth(false).then((status) => {
      // eslint-disable-next-line no-console
      console.log(`[server] ytdl-core: ${status.available ? 'available' : 'unavailable'} (${status.detail})`);
    }).catch(() => { });
    // eslint-disable-next-line no-console
    console.log(`[server] Video runtime: ffmpeg=${FFMPEG_BIN} ffprobe=${FFPROBE_BIN}`);
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
  handleYoutubeIngest,
  handleAgentSignedUrl,
  handleComplementImage,
  handleProviderKeysList,
  handleProviderKeysSave,
  handleProviderKeysRemove,
  handleKeysApi,
  handleAutomationIngest,
  handleAutomationFramePatch,
  handleAutomationMotionReconstruct,
  handleAutomationIncrementalRender,
  handleAutomationSnapshot,
  handleAutomationApi,
  handleWorkflowTemplates,
  handleWorkflowTemplateApply,
  handleWorkflowApi,
  handleRequest,
  startLocalServer
};
