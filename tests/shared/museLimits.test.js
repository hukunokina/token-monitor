'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  fetchMuseLimits,
  mapMintedKeyToProvider,
  museAuthPath,
  museMintUrl,
  readMuseLogin
} = require('../../src/shared/providers/muse/limits');
const { collectLimitsOnce } = require('../../src/shared/limits/collector');

const NOW = Date.parse('2026-09-22T00:00:00Z');

// The shape POST https://api.meta.ai/muse-code/key answers with (secrets elided).
const MINTED_KEY = {
  api_key: 'mk_test',
  base_url: 'https://api.meta.ai/v1',
  has_payment_method: false,
  require_payment: false,
  is_subs_active: true,
  user_full_name: 'Test User',
  user_email: 'test@example.com',
  subs_tier_id: '27681527378179523',
  subs_tier_name: 'Muse Code High Usage',
  subs_usage: {
    window: { used_percent: 1, window_duration_mins: 300, resets_at: 1790036555 },
    weekly: { used_percent: 2, resets_at: 1790553600 },
    tier: '27681527378179523'
  }
};

function writeAuth(dir, providers) {
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, providers }));
  return file;
}

function oauthAuth(dir) {
  return writeAuth(dir, {
    meta: {
      access_token: 'oauth-token',
      obtained_via: 'device_code',
      mechanism: 'oauth',
      api_key: 'mk_stored',
      api_base_url: 'https://api.meta.ai/v1',
      user_full_name: 'Test User',
      user_email: 'test@example.com'
    }
  });
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('museAuthPath follows MUSE_AUTH_PATH, then XDG_CONFIG_HOME, then ~/.config', () => {
  assert.equal(museAuthPath({ env: { MUSE_AUTH_PATH: '/x/auth.json' }, homeDir: '/h' }), '/x/auth.json');
  assert.equal(museAuthPath({ env: { XDG_CONFIG_HOME: '/cfg' }, homeDir: '/h' }), path.join('/cfg', 'muse', 'auth.json'));
  assert.equal(museAuthPath({ env: {}, homeDir: '/h' }), path.join('/h', '.config', 'muse', 'auth.json'));
  assert.equal(museMintUrl({}), 'https://api.meta.ai/muse-code/key');
  assert.equal(museMintUrl({ TBH_MINT_BASE_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9/muse-code/key');
});

test('readMuseLogin needs an OAuth login; API-key logins and missing files read as signed out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-limits-'));
  assert.equal(readMuseLogin({ env: { MUSE_AUTH_PATH: path.join(dir, 'missing.json') } }), null);

  const apiKeyOnly = writeAuth(dir, { meta: { api_key: 'k', mechanism: 'api_key' } });
  assert.equal(readMuseLogin({ env: { MUSE_AUTH_PATH: apiKeyOnly } }), null);

  const oauth = oauthAuth(dir);
  assert.deepEqual(readMuseLogin({ env: { MUSE_AUTH_PATH: oauth } }), {
    accessToken: 'oauth-token',
    email: 'test@example.com',
    fullName: 'Test User'
  });
});

test('mapMintedKeyToProvider maps the 5-hour and weekly windows and the plan', () => {
  const provider = mapMintedKeyToProvider(MINTED_KEY, { updatedAt: new Date(NOW).toISOString() });
  assert.equal(provider.provider, 'muse');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.source, 'oauth');
  assert.equal(provider.accountEmail, 'test@example.com');
  assert.equal(provider.accountName, 'Test User');
  assert.equal(provider.planLabel, 'High Usage');
  assert.equal(provider.windows.length, 2);
  const [session, weekly] = provider.windows;
  assert.equal(session.kind, 'session');
  assert.equal(session.usedPercent, 1);
  assert.equal(session.windowMinutes, 300);
  assert.equal(session.resetsAt, new Date(1790036555 * 1000).toISOString());
  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.usedPercent, 2);
  assert.equal(weekly.windowMinutes, 7 * 24 * 60);
  assert.equal(weekly.resetsAt, new Date(1790553600 * 1000).toISOString());
});

test('fetchMuseLimits mints with the stored bearer token and never a prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-limits-'));
  const calls = [];
  const provider = await fetchMuseLimits({}, {
    env: { MUSE_AUTH_PATH: oauthAuth(dir) },
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response(MINTED_KEY);
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.meta.ai/muse-code/key');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer oauth-token');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(provider.status, 'ok');
  assert.equal(provider.updatedAt, new Date(NOW).toISOString());
  assert.equal(provider.windows[0].usedPercent, 1);
});

test('fetchMuseLimits reports signed-out, rejected and subscription-less accounts as statuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-limits-'));
  await assert.rejects(
    fetchMuseLimits({}, { env: { MUSE_AUTH_PATH: path.join(dir, 'none.json') }, fetch: async () => response(MINTED_KEY) }),
    (error) => error.status === 'notConfigured'
  );
  const auth = oauthAuth(dir);
  await assert.rejects(
    fetchMuseLimits({}, { env: { MUSE_AUTH_PATH: auth }, fetch: async () => response({ error: 'expired' }, 401) }),
    (error) => error.status === 'unauthorized'
  );
  await assert.rejects(
    fetchMuseLimits({}, { env: { MUSE_AUTH_PATH: auth }, fetch: async () => response({ ...MINTED_KEY, is_subs_active: false, subs_usage: null }) }),
    (error) => error.status === 'notConfigured'
  );
});

test('collectLimitsOnce dispatches the muse provider through the shared probe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-limits-'));
  const summary = await collectLimitsOnce(
    { limitProviders: ['muse'] },
    { env: { MUSE_AUTH_PATH: oauthAuth(dir) }, now: () => NOW, fetch: async () => response(MINTED_KEY) }
  );
  assert.equal(summary.providers.length, 1);
  assert.equal(summary.providers[0].provider, 'muse');
  assert.equal(summary.providers[0].status, 'ok');
  assert.equal(summary.providers[0].windows.length, 2);
});
