#!/usr/bin/env node
/**
 * rb-auth.mjs — Non-interactive Rightbrain auth resolver.
 *
 * Node >= 18 required. No npm dependencies (uses the built-in `fetch`).
 *
 * Usage:
 *   node rb-auth.mjs status    Emit a human-readable auth status. Never prints a token.
 *
 * Resolution order (first tier whose inputs are present wins):
 *   1. RB_API_KEY              Static bearer token (CI / headless). Requires RB_ORG_ID + RB_PROJECT_ID.
 *   2. RB_CLIENT_ID/SECRET     OAuth2 client-credentials grant (headless). Token cached at
 *                              ~/.rightbrain/cc-token-{identity-hash}.json and reused until 5 minutes
 *                              before expiry.
 *   3. Interactive session       Written and read by the Rightbrain CLI via
 *                              `rightbrain token --json`, which verifies and refreshes before
 *                              printing (CLI >= 0.3.0). The CLI is REQUIRED for this tier: it is
 *                              the only thing that knows which environment a session belongs to.
 *   4. none of the above       Exit 2 — install/login with Rightbrain CLI.
 *
 * Environment:
 *   RB_ENV             production | staging | local   (default: production)
 *                      Selects the host for tiers 1 and 2 only, and is never used to describe a
 *                      session. It does NOT move a session: a session
 *                      token is only valid for the environment it was issued from, so tier 3 takes
 *                      its host from the CLI's active environment instead. Use `RB_CLI_ENV` or
 *                      `rightbrain env use <name>` to switch that.
 *   RB_CLI_ENV         Read by the CLI itself to pick a named environment (passed straight through).
 *   RB_CLI             Override the CLI invocation (default: `rightbrain` on PATH).
 *   RB_API_BASE_URL    API base override for headless tiers and dry-run metadata. CLI sessions
 *                      always use the CLI-reported dashboard URL.
 *   RB_OAUTH_URL       Explicit override for the OAuth host used to mint client-credentials tokens.
 *                      Required whenever a token must be minted (tier 2) for RB_ENV != production,
 *                      since only the production OAuth host (oauth.rightbrain.ai) is documented.
 *   RB_API_KEY         Static bearer token (tier 1).
 *   RB_ORG_ID          Required alongside RB_API_KEY (tier 1). Also fills org_id for tier 2 if set.
 *   RB_PROJECT_ID      Required alongside RB_API_KEY (tier 1). Also fills project_id for tier 2 if set.
 *   RB_CLIENT_ID       OAuth2 client id (tier 2).
 *   RB_CLIENT_SECRET   OAuth2 client secret (tier 2).
 *   RB_AUDIENCE        Optional OAuth2 audience (tier 2); included in cache identity.
 *   RB_AUTH_TIMEOUT_MS OAuth mint/refresh timeout in milliseconds (default: 30000).
 *
 * Exit codes:
 *   0  Success — safe status text on stdout.
 *   2  Not authenticated — install/login with Rightbrain CLI.
 *   3  Refresh failed — session expired/revoked, re-login needed.
 *   4  Configuration error — see stderr.
 *
 * All diagnostics go to stderr. Direct execution requires the explicit `status` command and never
 * includes the token itself. Importers use resolve() to receive credentials in process.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RB_DIR = join(homedir(), '.rightbrain');
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const LOCK_WAIT_MS = 50;
const STALE_LOCK_AGE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = STALE_LOCK_AGE_MS + 5000;
const DEFAULT_AUTH_TIMEOUT_MS = 30000;
const MAX_TIMER_DELAY_MS = 2147483647;

// Only the published production hosts are hardcoded. Other environments are
// named but carry no host: their addresses are not public, and since CLI 0.3.0 a
// session supplies its own host anyway (`login --env <name> --url <base-url>`),
// so the preset is only a convenience for the headless tiers. Set
// RB_API_BASE_URL — and RB_OAUTH_URL if a token must be minted — for those.
const HOSTS = {
  production: {
    api_base_url: 'https://app.rightbrain.ai/api/v1',
    oauth_url: 'https://oauth.rightbrain.ai',
  },
  staging: { api_base_url: null, oauth_url: null },
  local: { api_base_url: null, oauth_url: null },
};

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function resolveEnv() {
  const env = (process.env.RB_ENV || 'production').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(HOSTS, env)) {
    throw new AuthError(4, `invalid RB_ENV "${env}" — expected one of: ${Object.keys(HOSTS).join(', ')}`);
  }
  const defaults = HOSTS[env];
  const api_base_url = process.env.RB_API_BASE_URL || defaults.api_base_url;
  if (!api_base_url) {
    throw new AuthError(
      4,
      `no published API host for RB_ENV="${env}" — set RB_API_BASE_URL, or log in ` +
        `with \`rightbrain login --env ${env} --url <base-url>\` and let the session supply it.`,
    );
  }
  const oauth_url = process.env.RB_OAUTH_URL || defaults.oauth_url || null;
  return { env, api_base_url, oauth_url };
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Resolve only request-target metadata without touching credential resolution.
 *
 * This path never invokes the CLI, reads token properties, mints or refreshes
 * credentials, takes locks, writes caches, or performs network requests.
 */
export function resolveTargetMetadata() {
  const configuredEnv = (process.env.RB_ENV || 'production').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(HOSTS, configuredEnv)) {
    throw new AuthError(4, `invalid RB_ENV "${configuredEnv}" — expected one of: ${Object.keys(HOSTS).join(', ')}`);
  }

  const explicitApiBase = optionalString(process.env.RB_API_BASE_URL);
  const explicitOrgId = optionalString(process.env.RB_ORG_ID);
  const explicitProjectId = optionalString(process.env.RB_PROJECT_ID);
  const apiBaseUrl = explicitApiBase || HOSTS[configuredEnv].api_base_url || null;
  const hasExplicitMetadata = Boolean(explicitApiBase || explicitOrgId || explicitProjectId);

  return {
    env: configuredEnv,
    api_base_url: apiBaseUrl,
    org_id: explicitOrgId,
    project_id: explicitProjectId,
    source: hasExplicitMetadata ? 'environment' : apiBaseUrl ? 'preset' : 'unresolved',
  };
}

// ---------------------------------------------------------------------------
// Rightbrain CLI (>= 0.3.0) integration
//
// `rightbrain token --json` verifies and refreshes the stored session before
// printing, so we no longer reimplement the OAuth refresh dance for the session
// tier. It also understands named environments and honours RB_CLI_ENV itself,
// which means an agent switches environment without this script knowing how.
//
// From 0.3.0-beta.2 the CLI also reports `dashboard_url` and `env`, so one call
// yields everything needed to build a request — see resolveSessionBaseUrl.
// ---------------------------------------------------------------------------

let cachedCliCommand;

function parseCommandLine(value) {
  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped || quote) {
    throw new AuthError(4, 'RB_CLI contains an unfinished escape or quote.');
  }
  if (current) args.push(current);
  if (args.length === 0) throw new AuthError(4, 'RB_CLI must not be empty.');
  return args;
}

function cliCommand() {
  if (cachedCliCommand !== undefined) return cachedCliCommand;

  let command;
  let configured = false;
  if (process.env.RB_CLI) {
    const value = process.env.RB_CLI.trim();
    command = existsSync(value) ? [value] : parseCommandLine(value);
    configured = true;
  } else {
    command = ['rightbrain'];
  }

  const [bin, ...prefix] = command;
  const probe = spawnSync(bin, [...prefix, '--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') {
    if (configured) throw new AuthError(4, `RB_CLI executable was not found: ${bin}`);
    cachedCliCommand = null;
    return cachedCliCommand;
  }
  if (probe.error || probe.status !== 0) {
    throw new AuthError(
      4,
      'the Rightbrain CLI could not start. Reinstall `rightbrain@latest` or correct RB_CLI.',
    );
  }
  const match = probe.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 3)) {
    throw new AuthError(4, 'Rightbrain CLI 0.3.0 or newer is required.');
  }
  cachedCliCommand = command;
  return cachedCliCommand;
}

function runCli(args) {
  const command = cliCommand();
  if (!command) return null;
  const [bin, ...prefix] = command;
  const res = spawnSync(bin, [...prefix, ...args], { encoding: 'utf8' });
  if (res.error) {
    throw new AuthError(4, 'the Rightbrain CLI could not start. Reinstall it or correct RB_CLI.');
  }
  if (res.status !== 0) {
    throw new AuthError(
      2,
      'the Rightbrain CLI has no usable session. Run `rightbrain login --non-interactive`, then retry once.',
    );
  }
  return res.stdout || '';
}

/** Credentials from `rightbrain token --json`, or null when the CLI is unavailable. */
function cliSession() {
  const out = runCli(['token', '--json']);
  if (out === null) return null;
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new AuthError(4, 'the Rightbrain CLI returned invalid token metadata; update it and retry.');
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed?.access_token || !parsed?.dashboard_url) {
      throw new Error('access_token or dashboard_url is missing');
    }
    return parsed;
  } catch {
    throw new AuthError(4, 'the Rightbrain CLI returned invalid token metadata; update it and retry.');
  }
}

/**
 * Which host does this session belong to?
 *
 * A session token is only valid for the deployment that issued it, so this must
 * follow the session and not the RB_ENV preset. `token --json` reports
 * `dashboard_url` from CLI 0.3.0-beta.2 onwards, which makes it authoritative;
 * CLI 0.3.0 and newer returns `dashboard_url`, so session routing never reads
 * or infers private CLI state.
 */
function resolveSessionBaseUrl(fromCli) {
  return `${fromCli.dashboard_url.replace(/\/$/, '')}/api/v1`;
}

function normalizedHost(value) {
  return value ? value.replace(/\/+$/, '') : '';
}

function clientCredentialIdentity(envInfo, clientId) {
  return {
    client_id: clientId,
    oauth_url: normalizedHost(envInfo.oauth_url),
    api_base_url: normalizedHost(envInfo.api_base_url),
    audience: process.env.RB_AUDIENCE || '',
  };
}

function cacheFileFor(identity) {
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  return join(RB_DIR, `cc-token-${digest}.json`);
}

function ensureSecureDirectory() {
  mkdirSync(RB_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RB_DIR, 0o700);
}

function writeSecureFile(path, obj) {
  ensureSecureDirectory();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AuthError(4, `failed to parse ${path}: ${err.message}`);
  }
}

function metadataMatches(cached, identity) {
  if (!cached || !cached.identity) return false;
  return Object.entries(identity).every(([key, value]) => cached.identity[key] === value);
}

function validCachedToken(cached, identity) {
  return (
    metadataMatches(cached, identity) &&
    typeof cached.access_token === 'string' &&
    cached.access_token.trim() !== '' &&
    Number.isFinite(cached.expires_at) &&
    Date.now() < cached.expires_at - REFRESH_WINDOW_MS
  );
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function staleLockOwner(lockPath) {
  let raw;
  let owner;
  try {
    raw = readFileSync(lockPath, 'utf8');
    owner = JSON.parse(raw);
  } catch {
    return null;
  }

  const timestamp = Number(owner?.timestamp);
  const pid = Number(owner?.pid);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp < STALE_LOCK_AGE_MS) return null;
  if (processIsAlive(pid)) return null;
  return raw;
}

function recoverStaleLock(lockPath) {
  const staleOwner = staleLockOwner(lockPath);
  if (staleOwner === null) return false;
  try {
    if (readFileSync(lockPath, 'utf8') !== staleOwner) return false;
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    return false;
  }
}

async function withFileLock(path, operation) {
  ensureSecureDirectory();
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd;

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, timestamp: Date.now(), nonce: randomUUID() }),
        );
      } catch (err) {
        closeSync(fd);
        fd = undefined;
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the metadata-write failure as the actionable error.
        }
        throw new AuthError(4, `failed to write auth cache lock metadata: ${err.message}`);
      }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new AuthError(4, `failed to acquire auth cache lock ${lockPath}: ${err.message}`);
      }
      if (recoverStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        let age = 'unknown';
        try {
          age = `${Math.max(0, Date.now() - statSync(lockPath).mtimeMs).toFixed(0)}ms`;
        } catch {
          // The lock disappeared after the timeout check.
        }
        throw new AuthError(4, `timed out waiting for live auth cache lock ${lockPath} (age ${age})`);
      }
      await sleep(LOCK_WAIT_MS);
    }
  }

  try {
    return await operation();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new AuthError(4, `failed to release auth cache lock ${lockPath}: ${err.message}`);
      }
    }
  }
}

function authTimeoutMs() {
  const raw = process.env.RB_AUTH_TIMEOUT_MS || String(DEFAULT_AUTH_TIMEOUT_MS);
  if (!/^\d+$/.test(raw)) {
    throw new AuthError(4, 'RB_AUTH_TIMEOUT_MS must be a positive integer number of milliseconds.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new AuthError(
      4,
      `RB_AUTH_TIMEOUT_MS must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds.`,
    );
  }
  return value;
}

async function fetchAuth(url, options, context, errorCode) {
  const timeoutMs = authTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const body = await res.text();
    return { res, body };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new AuthError(errorCode, `${context} timed out after ${timeoutMs}ms`);
    }
    throw new AuthError(errorCode, `${context} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseTokenResponse(body, context, errorCode) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new AuthError(errorCode, `${context} returned malformed JSON: ${err.message}`);
  }

  if (!data || typeof data.access_token !== 'string' || data.access_token.trim() === '') {
    throw new AuthError(errorCode, `${context} returned no valid access_token.`);
  }

  const expiresIn =
    data.expires_in === undefined ? DEFAULT_EXPIRES_IN_SECONDS : Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new AuthError(errorCode, `${context} returned an invalid expires_in value.`);
  }
  return { data, expiresAt: Date.now() + expiresIn * 1000 };
}

function tierApiKey(envInfo) {
  const apiKey = process.env.RB_API_KEY;
  if (!apiKey) return null;
  const orgId = process.env.RB_ORG_ID;
  const projectId = process.env.RB_PROJECT_ID;
  if (!orgId || !projectId) {
    throw new AuthError(
      4,
      'RB_API_KEY is set but RB_ORG_ID and/or RB_PROJECT_ID is missing. Both are required alongside a static API key.',
    );
  }
  return {
    access_token: apiKey,
    org_id: orgId,
    project_id: projectId,
    api_base_url: envInfo.api_base_url,
    source: 'api_key',
    expires_at: null,
  };
}

async function tierClientCredentials(envInfo, forceRefresh = false) {
  const { env, oauth_url } = envInfo;
  const clientId = process.env.RB_CLIENT_ID;
  const clientSecret = process.env.RB_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new AuthError(
      4,
      'RB_CLIENT_ID and RB_CLIENT_SECRET must be set together; refusing to fall back to an ambient session.',
    );
  }
  if (!clientId) return null;

  const identity = clientCredentialIdentity(envInfo, clientId);
  const cachePath = cacheFileFor(identity);
  const observed = readJsonIfExists(cachePath);
  if (!forceRefresh && validCachedToken(observed, identity)) {
    return {
      access_token: observed.access_token,
      org_id: process.env.RB_ORG_ID || observed.org_id || null,
      project_id: process.env.RB_PROJECT_ID || observed.project_id || null,
      api_base_url: envInfo.api_base_url,
      source: 'client_credentials',
      expires_at: observed.expires_at,
    };
  }

  if (!oauth_url) {
    throw new AuthError(
      4,
      `client-credentials mint requested for RB_ENV=${env} but no OAuth host is known for this environment. Set RB_OAUTH_URL explicitly.`,
    );
  }

  return withFileLock(cachePath, async () => {
    const current = readJsonIfExists(cachePath);
    const anotherProcessRefreshed =
      forceRefresh &&
      validCachedToken(current, identity) &&
      current.access_token !== observed?.access_token;
    if ((!forceRefresh && validCachedToken(current, identity)) || anotherProcessRefreshed) {
      return {
        access_token: current.access_token,
        org_id: process.env.RB_ORG_ID || current.org_id || null,
        project_id: process.env.RB_PROJECT_ID || current.project_id || null,
        api_base_url: envInfo.api_base_url,
        source: 'client_credentials',
        expires_at: current.expires_at,
      };
    }

    const tokenEndpoint = `${oauth_url.replace(/\/$/, '')}/oauth2/token`;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'offline_access',
    });
    if (identity.audience) params.set('audience', identity.audience);

    const { res, body: responseBody } = await fetchAuth(
      tokenEndpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: params.toString(),
      },
      `client-credentials request to ${tokenEndpoint}`,
      4,
    );
    if (!res.ok) {
      throw new AuthError(
        4,
        `client-credentials mint failed (${res.status}); verify the OAuth host and client configuration`,
      );
    }
    const { data, expiresAt } = parseTokenResponse(
      responseBody,
      'client-credentials endpoint',
      4,
    );
    const cacheData = {
      identity,
      access_token: data.access_token,
      expires_at: expiresAt,
      org_id: process.env.RB_ORG_ID || null,
      project_id: process.env.RB_PROJECT_ID || null,
    };
    writeSecureFile(cachePath, cacheData);
    return {
      access_token: cacheData.access_token,
      org_id: cacheData.org_id,
      project_id: cacheData.project_id,
      api_base_url: envInfo.api_base_url,
      source: 'client_credentials',
      expires_at: expiresAt,
    };
  });
}

function tierSession() {
  const fromCli = cliSession();
  if (!fromCli) {
    throw new AuthError(
      2,
      'Rightbrain CLI is required for session authentication. Install `rightbrain@latest`, ' +
        'run `rightbrain login --non-interactive`, or configure headless credentials.',
    );
  }
  return {
    access_token: fromCli.access_token,
    org_id: process.env.RB_ORG_ID || fromCli.org_id || null,
    project_id: process.env.RB_PROJECT_ID || fromCli.project_id || null,
    api_base_url: resolveSessionBaseUrl(fromCli),
    source: 'session',
    expires_at: fromCli.expires_at || null,
  };
}

/**
 * Resolve credentials across the three tiers.
 *
 * @param {{env:string, api_base_url:string, oauth_url:string|null}|null} [envInfo]
 * @param {{forceRefresh?: boolean}} [options]  Re-mint client credentials after a 401.
 */
export async function resolve(envInfo = null, options = {}) {
  const { forceRefresh = false } = options;
  const headlessConfigured = Boolean(
    process.env.RB_API_KEY || process.env.RB_CLIENT_ID || process.env.RB_CLIENT_SECRET,
  );
  if (!headlessConfigured) return tierSession();

  const target = envInfo || resolveEnv();
  const apiKeyResult = tierApiKey(target);
  if (apiKeyResult) return apiKeyResult;

  const ccResult = await tierClientCredentials(target, forceRefresh);
  if (ccResult) return ccResult;

  throw new AuthError(4, 'headless authentication is configured but no complete credential tier resolved.');
}

function formatStatus(result) {
  const lines = [];
  // The host a call actually reaches, never a preset label. `env` comes from
  // RB_ENV and defaults to production, while the host comes from the session, so
  // a label here reported one environment while requests went to another.
  lines.push(`api_base_url: ${result.api_base_url || '(unresolved)'}`);
  lines.push(`source: ${result.source}`);
  lines.push(`org_id: ${result.org_id || '(unset)'}`);
  lines.push(`project_id: ${result.project_id || '(unset)'}`);
  if (result.expires_at) {
    const remainingMin = Math.round((result.expires_at - Date.now()) / 60000);
    const when = remainingMin >= 0 ? `in ${remainingMin}m` : `${-remainingMin}m ago`;
    lines.push(`expires_at: ${new Date(result.expires_at).toISOString()} (${when})`);
  } else {
    lines.push('expires_at: (none — static credential)');
  }
  return lines.join('\n');
}

async function main() {
  const mode = process.argv[2];
  if (!mode) {
    process.stderr.write(
      'rb-auth: implicit credential output has been removed for safety. ' +
        'Use `rb-auth.mjs status` for token-free status, or `import { resolve } from ' +
        "'./rb-auth.mjs'` — it takes no required arguments.\n",
    );
    process.exit(4);
  }
  if (mode !== 'status') {
    process.stderr.write(`rb-auth: unknown argument "${mode}". Usage: rb-auth.mjs status\n`);
    process.exit(4);
  }

  try {
    const result = await resolve();

    process.stdout.write(formatStatus(result) + '\n');
    process.exit(0);
  } catch (err) {
    const code = err instanceof AuthError ? err.code : 4;
    let apiBaseUrl = '(unresolved)';
    try {
      apiBaseUrl = resolveTargetMetadata().api_base_url || apiBaseUrl;
    } catch {
      // Preserve the authentication error; fallback metadata is diagnostic only.
    }
    process.stderr.write(`rb-auth: ${err.message}\n`);
    process.stdout.write(
      `api_base_url: ${apiBaseUrl}\nsource: none\nstatus: not authenticated\n`,
    );
    process.exit(code);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = err instanceof AuthError ? err.code : 4;
    process.stderr.write(`rb-auth: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(code);
  });
}
