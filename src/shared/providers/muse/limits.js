'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, nowIso, numberOrNull, statusForHttp, toIso } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

// Muse Code (Meta) has no usage endpoint, but the CLI mints its Model API key
// from the stored OAuth login on every start (`credential.refresh`):
// POST <mint base>/muse-code/key with the bearer token. That response carries
// the subscription usage the TUI shows — a 5-hour window and a weekly window,
// the same snapshot the SSE stream repeats on model turns — so reading it here
// costs no prompt. Minting does not revoke the key the CLI already holds (the
// stored key keeps answering /v1/models after a fresh mint), so polling is safe
// while a session is open.
const MUSE_MINT_BASE_URL = 'https://api.meta.ai';
const MUSE_MINT_PATH = '/muse-code/key';
const MUSE_FETCH_TIMEOUT_MS = 12_000;
const MUSE_AUTH_FILE_MAX_BYTES = 256 * 1024;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** The CLI's own credential lookup: $MUSE_AUTH_PATH, then $XDG_CONFIG_HOME/muse, then ~/.config/muse. */
function museAuthPath(options = {}) {
  const env = options.env || process.env;
  const explicit = cleanText(env.MUSE_AUTH_PATH);
  if (explicit) return explicit;
  const configHome = cleanText(env.XDG_CONFIG_HOME) || path.join(options.homeDir || os.homedir(), '.config');
  return path.join(configHome, 'muse', 'auth.json');
}

/** Same override the CLI honours for its mint server. */
function museMintUrl(env = process.env) {
  const base = cleanText(env.TBH_MINT_BASE_URL) || MUSE_MINT_BASE_URL;
  return `${base.replace(/\/+$/, '')}${MUSE_MINT_PATH}`;
}

/**
 * The stored Meta account login, or null when Muse is signed out or runs on a
 * raw META_API_KEY (pay-as-you-go: nothing to meter).
 */
function readMuseLogin(options = {}) {
  const authPath = museAuthPath(options);
  let raw;
  try {
    const stat = fs.statSync(authPath);
    if (!stat.isFile() || stat.size > MUSE_AUTH_FILE_MAX_BYTES) return null;
    raw = fs.readFileSync(authPath, 'utf8');
  } catch (_) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  const meta = parsed?.providers?.meta;
  const accessToken = cleanText(meta?.access_token);
  if (!accessToken || cleanText(meta?.mechanism).toLowerCase() !== 'oauth') return null;
  return {
    accessToken,
    email: cleanText(meta?.user_email),
    fullName: cleanText(meta?.user_full_name)
  };
}

function usageWindow(source, kind, limitId, fallbackMinutes) {
  if (!source || typeof source !== 'object') return null;
  const usedPercent = numberOrNull(source.used_percent ?? source.usedPercent);
  if (usedPercent === null) return null;
  return {
    kind,
    limitId,
    usedPercent,
    resetsAt: toIso(numberOrNull(source.resets_at ?? source.resetsAt)),
    windowMinutes: numberOrNull(source.window_duration_mins ?? source.windowDurationMins) ?? fallbackMinutes
  };
}

/** Map a minted-key payload (its `subs_usage`) onto the shared provider shape. */
function mapMintedKeyToProvider(payload, meta = {}) {
  const usage = payload?.subs_usage;
  const windows = [
    usageWindow(usage?.window, 'session', 'window', null),
    usageWindow(usage?.weekly, 'weekly', 'weekly', WEEKLY_WINDOW_MINUTES)
  ].filter(Boolean);
  const email = cleanText(payload?.user_email) || cleanText(meta.email);
  return normalizeLimitProvider({
    provider: 'muse',
    accountKey: hashKey('muse', email || cleanText(payload?.subs_tier_id)),
    accountLabel: email,
    accountName: cleanText(payload?.user_full_name) || cleanText(meta.fullName),
    accountEmail: email,
    // "Muse Code High Usage" reads as "High Usage" next to the provider name.
    planLabel: cleanText(payload?.subs_tier_name).replace(/^muse\s+code\s+/i, ''),
    source: 'oauth',
    sourceDetail: 'muse-code/key',
    status: 'ok',
    updatedAt: meta.updatedAt,
    windows
  });
}

async function fetchMuseLimits(_options = {}, deps = {}) {
  const env = deps.env || process.env;
  const login = readMuseLogin({ env, homeDir: deps.homeDir });
  if (!login) throw errorWithStatus('notConfigured', 'Muse Code account login not found — run `muse login`');
  const nowMs = (deps.now || Date.now)();
  const deadlineMs = Number(deps.museFetchTimeoutMs || deps.fetchTimeoutMs || MUSE_FETCH_TIMEOUT_MS);
  const payload = await runWithProbeDeadline(async ({ signal }) => {
    const response = await (deps.fetch || fetch)(museMintUrl(env), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${login.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        // The client surface header the CLI sends; the mint server keys its
        // product checks on it.
        'x-client-id': 'tbh:tui'
      },
      body: '{}',
      // The bearer token must never follow a redirect off the mint host.
      redirect: 'error',
      signal
    });
    const status = Number(response?.status || 0);
    if (response?.ok === false || status >= 400) {
      throw errorWithStatus(statusForHttp(status), `Muse Code key mint failed (HTTP ${status})`);
    }
    return response.json();
  }, { deadlineMs, signal: deps.signal });
  if (!payload || typeof payload !== 'object') throw errorWithStatus('unavailable', 'Muse Code key mint returned no body');
  if (payload.is_subs_active === false || !payload.subs_usage) {
    throw errorWithStatus('notConfigured', 'No active Muse Code subscription on this account');
  }
  return mapMintedKeyToProvider(payload, { updatedAt: nowIso(nowMs), email: login.email, fullName: login.fullName });
}

module.exports = {
  MUSE_MINT_BASE_URL,
  MUSE_MINT_PATH,
  fetchMuseLimits,
  mapMintedKeyToProvider,
  museAuthPath,
  museMintUrl,
  readMuseLogin
};
