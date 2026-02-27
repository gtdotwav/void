import { randomBytes, createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY_VAULT_FILE = 'api-key-vault.json';
const PROVIDER_USAGE_FILE = 'provider-usage.json';

const PROVIDER_ALIASES = {
  google: 'google_nano_banana',
  google_nano_banana: 'google_nano_banana',
  gemini: 'google_nano_banana',
  kling: 'kling',
  veo: 'veo',
  elevenlabs: 'elevenlabs',
  openai: 'openai',
  youtube: 'youtube',
  ytdlp: 'youtube',
  yt_dlp: 'youtube'
};

function normalizeProviderName(rawProvider) {
  const candidate = String(rawProvider || '').trim().toLowerCase();
  return PROVIDER_ALIASES[candidate] || '';
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true });
  const tempPath = `${filePath}.${Date.now()}.${Math.round(Math.random() * 100000)}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  await rename(tempPath, filePath);
}

function deriveMasterKey(envVars) {
  const candidates = [
    envVars.KEY_VAULT_MASTER_KEY,
    envVars.VAULT_MASTER_KEY,
    envVars.INTERNAL_CRYPTO_KEY,
    envVars.ELEVENLABS_API_KEY
  ].map((value) => String(value || '').trim());

  const selected = candidates.find((value) => value.length >= 16);
  if (!selected) return null;

  return createHash('sha256').update(selected).digest();
}

function encryptSecret(plainText, keyBuffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText || ''), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

function decryptSecret(payload, keyBuffer) {
  const iv = Buffer.from(String(payload.iv || ''), 'base64');
  const authTag = Buffer.from(String(payload.authTag || ''), 'base64');
  const cipherText = Buffer.from(String(payload.cipherText || ''), 'base64');

  const decipher = createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return decrypted.toString('utf8');
}

export function createKeyVault({ dataRoot, envVars }) {
  const baseRoot = join(dataRoot, 'vault');
  const vaultPath = join(baseRoot, KEY_VAULT_FILE);
  const usagePath = join(baseRoot, PROVIDER_USAGE_FILE);

  const masterKey = deriveMasterKey(envVars || {});

  async function readVault() {
    const fallback = {
      version: 1,
      providers: {}
    };
    return readJsonFile(vaultPath, fallback);
  }

  async function writeVault(payload) {
    await writeJsonAtomic(vaultPath, payload);
  }

  async function readUsage() {
    const fallback = {
      version: 1,
      windows: {},
      totals: {}
    };
    return readJsonFile(usagePath, fallback);
  }

  async function writeUsage(payload) {
    await writeJsonAtomic(usagePath, payload);
  }

  async function listProviderKeys() {
    const vault = await readVault();
    const providers = Object.keys(vault.providers || {});
    const items = [];

    providers.forEach((provider) => {
      const keys = Array.isArray(vault.providers[provider]) ? vault.providers[provider] : [];
      keys.forEach((entry) => {
        items.push({
          id: String(entry.id || ''),
          provider,
          label: String(entry.label || 'default'),
          masked: `***${String(entry.last4 || '')}`,
          createdAt: String(entry.createdAt || ''),
          updatedAt: String(entry.updatedAt || '')
        });
      });
    });

    return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function saveProviderKey({ provider, apiKey, label = 'default' }) {
    if (!masterKey) {
      const error = new Error('KEY_VAULT_MASTER_KEY ausente. Configure a chave mestre para salvar API keys com criptografia.');
      error.statusCode = 500;
      throw error;
    }

    const normalizedProvider = normalizeProviderName(provider);
    if (!normalizedProvider) {
      const error = new Error('provider inválido para key vault.');
      error.statusCode = 400;
      throw error;
    }

    const plain = String(apiKey || '').trim();
    if (!plain || plain.length < 8) {
      const error = new Error('apiKey inválida para armazenamento.');
      error.statusCode = 400;
      throw error;
    }

    const normalizedLabel = String(label || 'default').trim().slice(0, 64) || 'default';
    const now = new Date().toISOString();

    const vault = await readVault();
    if (!vault.providers[normalizedProvider]) vault.providers[normalizedProvider] = [];

    const encrypted = encryptSecret(plain, masterKey);
    const currentList = Array.isArray(vault.providers[normalizedProvider]) ? vault.providers[normalizedProvider] : [];
    const existing = currentList.find((entry) => String(entry.label || '').toLowerCase() === normalizedLabel.toLowerCase());

    const record = {
      id: existing?.id || randomUUID(),
      provider: normalizedProvider,
      label: normalizedLabel,
      cipherText: encrypted.cipherText,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      last4: plain.slice(-4),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    if (existing) {
      const index = currentList.findIndex((entry) => entry.id === existing.id);
      currentList[index] = record;
    } else {
      currentList.push(record);
    }

    vault.providers[normalizedProvider] = currentList;
    await writeVault(vault);

    return {
      ok: true,
      id: record.id,
      provider: record.provider,
      label: record.label,
      masked: `***${record.last4}`,
      updatedAt: record.updatedAt
    };
  }

  async function removeProviderKey({ provider, id, label }) {
    const normalizedProvider = normalizeProviderName(provider);
    if (!normalizedProvider) {
      const error = new Error('provider inválido para remover key.');
      error.statusCode = 400;
      throw error;
    }

    const vault = await readVault();
    const list = Array.isArray(vault.providers[normalizedProvider]) ? vault.providers[normalizedProvider] : [];
    const targetId = String(id || '').trim();
    const targetLabel = String(label || '').trim().toLowerCase();

    const filtered = list.filter((entry) => {
      if (targetId) return String(entry.id) !== targetId;
      if (targetLabel) return String(entry.label || '').toLowerCase() !== targetLabel;
      return false;
    });

    if (filtered.length === list.length) {
      return { ok: true, removed: 0 };
    }

    vault.providers[normalizedProvider] = filtered;
    await writeVault(vault);

    return { ok: true, removed: list.length - filtered.length };
  }

  async function resolveProviderKeyValue(provider, options = {}) {
    const normalizedProvider = normalizeProviderName(provider);
    if (!normalizedProvider || !masterKey) return '';

    const vault = await readVault();
    const list = Array.isArray(vault.providers[normalizedProvider]) ? vault.providers[normalizedProvider] : [];
    if (!list.length) return '';

    const preferredId = String(options.id || '').trim();
    const preferredLabel = String(options.label || '').trim().toLowerCase();

    let selected = null;
    if (preferredId) selected = list.find((entry) => String(entry.id) === preferredId) || null;
    if (!selected && preferredLabel) {
      selected = list.find((entry) => String(entry.label || '').toLowerCase() === preferredLabel) || null;
    }
    if (!selected) {
      selected = list.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null;
    }
    if (!selected) return '';

    try {
      return decryptSecret(selected, masterKey);
    } catch (_error) {
      return '';
    }
  }

  async function consumeRateLimit(provider, options = {}) {
    const normalizedProvider = normalizeProviderName(provider);
    const limitPerMinute = Math.max(1, Number(options.limitPerMinute || 30));
    const windowMs = Math.max(5000, Number(options.windowMs || 60000));
    if (!normalizedProvider) {
      return { ok: false, remaining: 0, resetAt: Date.now() + windowMs };
    }

    const usage = await readUsage();
    const now = Date.now();
    if (!Array.isArray(usage.windows[normalizedProvider])) usage.windows[normalizedProvider] = [];

    usage.windows[normalizedProvider] = usage.windows[normalizedProvider].filter((ts) => now - Number(ts || 0) <= windowMs);
    const count = usage.windows[normalizedProvider].length;
    if (count >= limitPerMinute) {
      const oldest = Number(usage.windows[normalizedProvider][0] || now);
      return {
        ok: false,
        remaining: 0,
        resetAt: oldest + windowMs,
        used: count,
        limitPerMinute
      };
    }

    usage.windows[normalizedProvider].push(now);
    await writeUsage(usage);

    return {
      ok: true,
      remaining: Math.max(0, limitPerMinute - usage.windows[normalizedProvider].length),
      resetAt: now + windowMs,
      used: usage.windows[normalizedProvider].length,
      limitPerMinute
    };
  }

  async function recordProviderUsage(provider, options = {}) {
    const normalizedProvider = normalizeProviderName(provider);
    if (!normalizedProvider) return;

    const costUsd = Math.max(0, Number(options.costUsd || 0));
    const usage = await readUsage();
    if (!usage.totals[normalizedProvider]) {
      usage.totals[normalizedProvider] = { requests: 0, estimatedCostUsd: 0, lastUsedAt: null };
    }
    usage.totals[normalizedProvider].requests += 1;
    usage.totals[normalizedProvider].estimatedCostUsd = Number((usage.totals[normalizedProvider].estimatedCostUsd + costUsd).toFixed(6));
    usage.totals[normalizedProvider].lastUsedAt = new Date().toISOString();
    await writeUsage(usage);
  }

  async function getUsageSnapshot() {
    const usage = await readUsage();
    return usage.totals || {};
  }

  function getStatus() {
    return {
      ready: Boolean(masterKey),
      providers: Object.values(PROVIDER_ALIASES).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i)
    };
  }

  return {
    getStatus,
    listProviderKeys,
    saveProviderKey,
    removeProviderKey,
    resolveProviderKeyValue,
    consumeRateLimit,
    recordProviderUsage,
    getUsageSnapshot
  };
}
