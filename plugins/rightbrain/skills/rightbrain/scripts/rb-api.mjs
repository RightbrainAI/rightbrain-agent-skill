#!/usr/bin/env node
/**
 * rb-api.mjs — Single authenticated request wrapper for the Rightbrain API.
 *
 * Node >= 18 required. No npm dependencies (uses the built-in `fetch`, global `FormData`, and
 * `Blob` from `node:buffer`). Delegates all credential resolution to rb-auth.mjs.
 *
 * Usage:
 *   node rb-api.mjs <METHOD> <path> [options]
 *   node rb-api.mjs whoami
 *   node rb-api.mjs status
 *   node rb-api.mjs --help
 *
 * METHOD: GET | POST | PUT | PATCH | DELETE (case-insensitive).
 *
 * Paths are joined to api_base_url exactly as supplied. Use the canonical path from live OpenAPI,
 * replacing path parameters with their values. `--project-scope` and `--org-scope` are optional
 * conveniences for project- or organization-relative paths.
 *
 * Options:
 *   --query k=v          Append a URL query parameter. Repeatable.
 *   --data <json>        Request body. application/json is sent.
 *   --data @file          - Read the JSON body from a file.
 *   --data -              - Read the JSON body from stdin.
 *   --form k=v            Build multipart/form-data. Repeatable, combine with --file.
 *   --file field=@path    Attach a file under `field` for multipart/form-data. Repeatable.
 *   --accept <mime>       Override the Accept header (default: application/json).
 *   --output <path>       Write the response body to a file instead of stdout. Required when
 *                         the response is binary (content-type is not json/text).
 *   --secret-output <path> Write a successful JSON response unredacted to a new 0600 file while
 *                         stdout remains redacted. Never overwrites and never prints secrets.
 *   --sse                 Set Accept: text/event-stream and stream the body to stdout line by
 *                         line as it arrives. Exits 0 when the stream ends normally.
 *   --all                 Auto-paginate a `results` list endpoint; emits one merged JSON object
 *                         {results:[...], count:N} instead of one page.
 *   --timeout <ms>        Time allowed to establish a response (default RB_REQUEST_TIMEOUT_MS or
 *                         30000). The timer is cleared after response headers so SSE can remain
 *                         open indefinitely.
 *   --compact              Disable pretty-printing of JSON output (default: 2-space indent).
 *   --dry-run              Print the fully resolved method/URL/headers (Authorization redacted)
 *                         and a body summary to stderr, then exit 0 without making a request.
 *                         Uses explicit environment target metadata only.
 *                         If no exact target is available, prints URL as unresolved.
 *   --project-scope        Prefix /org/{org_id}/project/{project_id}.
 *   --org-scope            Prefix /org/{org_id}.
 *   -h, --help              Print this usage text and exit 0.
 *
 * JSON response fields with known secret-bearing keys are recursively redacted by default.
 * Unstructured text, binary data, and non-JSON SSE payloads cannot be field-redacted and are
 * passed through with an explicit warning.
 *
 * Environment: same as rb-auth.mjs (RB_ENV, RB_API_BASE_URL, RB_OAUTH_URL, RB_API_KEY,
 * RB_ORG_ID, RB_PROJECT_ID, RB_CLIENT_ID, RB_CLIENT_SECRET). RB_MAX_PAGES controls the --all
 * safety limit (default 10000). RB_API_BASE_URL targets headless and mock-server requests;
 * CLI sessions always use the CLI-reported host.
 *
 * Auth / retry: client credentials are re-minted once after HTTP 401. Static API keys and CLI
 * sessions fail immediately with tier-specific guidance. A rejected retry exits 3.
 *
 * Error mapping (stderr message, then exit 5; the response body is still printed to stdout when
 * present):
 *   403  "your role lacks permission on this project"
 *   404  "not found — verify the canonical path and IDs (run `rb-api.mjs whoami`)"
 *   422  the API's validation detail, printed verbatim
 *   429  the Retry-After header value, if present
 *   other 4xx/5xx  a generic "HTTP <status>" message
 *
 * Exit codes:
 *   0  ok
 *   2  not authenticated — install/login with Rightbrain CLI
 *   3  auth rejected (static key rejected, refresh failed, or retry rejected)
 *   4  usage / configuration / network error
 *   5  HTTP 4xx/5xx (non-auth)
 *
 * All diagnostics go to stderr. Only the response body (default mode) or the whoami/status
 * summary is written to stdout; a token is never printed.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Blob } from 'node:buffer';

import { resolveTargetMetadata, resolve, AuthError } from './rb-auth.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_MAX_PAGES = 10000;
const MAX_TIMER_DELAY_MS = 2147483647;
const SECRET_KEYS = new Set([
  'access_token',
  'access_tokens',
  'api_key',
  'api_key_value',
  'api_keys',
  'api_token',
  'auth_token',
  'authorization',
  'authorization_code',
  'authorization_codes',
  'authorization_header',
  'authorization_value',
  'bearer_token',
  'client_secret',
  'client_secrets',
  'code',
  'code_verifier',
  'credential',
  'credentials',
  'csrf_token',
  'id_token',
  'invite_code',
  'invite_token',
  'one_time_code',
  'one_time_token',
  'one_time_tokens',
  'otp',
  'otp_code',
  'password',
  'password_confirmation',
  'password_hash',
  'passwords',
  'recovery_code',
  'recovery_codes',
  'refresh_token',
  'refresh_tokens',
  'reset_code',
  'reset_token',
  'secret',
  'secret_value',
  'secrets',
  'session_token',
  'token',
  'verification_code',
  'verification_codes',
  'verification_token',
  'webhook_secret',
]);

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

const HELP_TEXT = `rb-api.mjs — authenticated Rightbrain API request wrapper

Usage:
  node rb-api.mjs <METHOD> <path> [options]
  node rb-api.mjs whoami
  node rb-api.mjs status
  node rb-api.mjs --help

METHOD: GET | POST | PUT | PATCH | DELETE (case-insensitive)

Path scoping:
  default          use {api_base}<path> exactly as supplied
  --project-scope  prefix /org/{org_id}/project/{project_id}
  --org-scope      prefix /org/{org_id}

Options:
  --query k=v       repeatable, URL-encoded query parameter
  --data <json>     request body; also accepts @file or - (stdin)
  --form k=v        repeatable, multipart/form-data field
  --file field=@path repeatable, multipart/form-data file attachment
  --accept <mime>   override the Accept header (default application/json)
  --output <path>   write response body to a file instead of stdout
  --secret-output <path>
                    write full successful JSON to a new 0600 file; stdout stays redacted
  --sse             stream a text/event-stream response to stdout line by line
  --all             auto-paginate a results list; emit {results:[...], count:N}
  --timeout <ms>    response-header timeout (default RB_REQUEST_TIMEOUT_MS or 30000)
  --compact         disable pretty-printing
  --dry-run         print resolved request (redacted) to stderr and exit 0; no network call
  -h, --help        print this text and exit 0

Exit codes: 0 ok · 2 not authenticated · 3 auth rejected · 4 usage/config/network error ·
5 HTTP 4xx/5xx (non-auth)

Security: known secret-bearing JSON keys are recursively redacted. Unstructured text, binary
responses, and non-JSON SSE data cannot be reliably field-redacted and pass through with warnings.
`;

function usageError(message) {
  process.stderr.write(`rb-api: ${message}\n`);
  process.exit(4);
}

function normalizePath(p) {
  if (!p) return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

function inferMime(filePath) {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    return { help: true };
  }

  if (argv[0] === 'whoami' || argv[0] === 'status') {
    return { sub: argv[0] };
  }

  const method = argv[0].toUpperCase();
  if (!METHODS.has(method)) {
    usageError(`unknown method "${argv[0]}" — expected one of GET, POST, PUT, PATCH, DELETE (or whoami/status).`);
  }
  const path = argv[1];
  if (!path) {
    usageError('missing <path>. Usage: rb-api.mjs <METHOD> <path> [options]');
  }

  const opts = {
    method,
    path,
    query: [],
    data: null,
    form: [],
    files: [],
    accept: null,
    output: null,
    secretOutput: null,
    sse: false,
    all: false,
    compact: false,
    dryRun: false,
    projectScope: false,
    orgScope: false,
    timeout: null,
  };

  let i = 2;
  const next = (flag) => {
    i += 1;
    if (i >= argv.length) usageError(`${flag} requires a value.`);
    return argv[i];
  };

  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--query': {
        const kv = next(arg);
        const eq = kv.indexOf('=');
        if (eq < 0) usageError(`--query expects k=v, got "${kv}".`);
        opts.query.push([kv.slice(0, eq), kv.slice(eq + 1)]);
        break;
      }
      case '--data':
        opts.data = next(arg);
        break;
      case '--form': {
        const kv = next(arg);
        const eq = kv.indexOf('=');
        if (eq < 0) usageError(`--form expects k=v, got "${kv}".`);
        opts.form.push([kv.slice(0, eq), kv.slice(eq + 1)]);
        break;
      }
      case '--file': {
        const kv = next(arg);
        const eq = kv.indexOf('=');
        if (eq < 0 || !kv.slice(eq + 1).startsWith('@')) {
          usageError(`--file expects field=@path, got "${kv}".`);
        }
        opts.files.push([kv.slice(0, eq), kv.slice(eq + 2)]);
        break;
      }
      case '--accept':
        opts.accept = next(arg);
        break;
      case '--output':
        opts.output = next(arg);
        break;
      case '--secret-output':
        opts.secretOutput = next(arg);
        break;
      case '--sse':
        opts.sse = true;
        break;
      case '--all':
        opts.all = true;
        break;
      case '--timeout':
        opts.timeout = next(arg);
        break;
      case '--compact':
        opts.compact = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--project-scope':
        opts.projectScope = true;
        break;
      case '--org-scope':
        opts.orgScope = true;
        break;
      case '-h':
      case '--help':
        return { help: true };
      default:
        usageError(`unknown option "${arg}".`);
    }
    i += 1;
  }

  if (opts.projectScope && opts.orgScope) {
    usageError('cannot combine --project-scope and --org-scope.');
  }
  if (opts.data !== null && (opts.form.length || opts.files.length)) {
    usageError('cannot combine --data with --form or --file.');
  }
  if (opts.all && opts.method !== 'GET') usageError('--all is only valid with GET.');
  if (opts.all && (opts.data !== null || opts.form.length || opts.files.length || opts.sse)) {
    usageError('--all cannot be combined with a body, form, file, or --sse.');
  }
  if (opts.sse && opts.output) usageError('--sse streams to stdout and cannot be combined with --output.');
  if (opts.sse && opts.compact) usageError('--compact has no effect with --sse.');
  if (opts.sse && opts.accept) usageError('--sse sets Accept automatically; do not also pass --accept.');
  if (opts.secretOutput && opts.output) {
    usageError('--secret-output cannot be combined with --output.');
  }
  if (opts.secretOutput && opts.dryRun) {
    usageError('--secret-output cannot be combined with --dry-run.');
  }
  if (opts.secretOutput && opts.sse) {
    usageError('--secret-output cannot be combined with --sse.');
  }
  if (opts.secretOutput && opts.all) {
    usageError('--secret-output cannot be combined with --all.');
  }
  if (opts.timeout !== null) {
    const timeout = Number(opts.timeout);
    if (
      !/^\d+$/.test(opts.timeout) ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      timeout > MAX_TIMER_DELAY_MS
    ) {
      usageError(`--timeout must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds.`);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Path / URL resolution
// ---------------------------------------------------------------------------

function resolveUrl(apiBase, rawPath, opts, orgId, projectId) {
  const path = normalizePath(rawPath);
  const base = apiBase.replace(/\/$/, '');

  let prefix = '';
  if (opts.projectScope) {
    if (!orgId || !projectId) {
      throw new AuthError(
        4,
        'project scoping requested but org_id/project_id are unresolved. ' +
          'Set RB_ORG_ID and RB_PROJECT_ID.',
      );
    }
    prefix = `/org/${encodeURIComponent(orgId)}/project/${encodeURIComponent(projectId)}`;
  } else if (opts.orgScope) {
    if (!orgId) {
      throw new AuthError(4, 'org scoping requested but org_id is unresolved. Set RB_ORG_ID.');
    }
    prefix = `/org/${encodeURIComponent(orgId)}`;
  }

  const scopedPath = path === '/' && prefix ? '' : path;
  const url = new URL(base + prefix + scopedPath);
  for (const [k, v] of opts.query) url.searchParams.append(k, v);
  return url;
}

// ---------------------------------------------------------------------------
// Body building
// ---------------------------------------------------------------------------

function readDataValue(data) {
  try {
    if (data === '-') return readFileSync(0, 'utf8');
    if (data.startsWith('@')) return readFileSync(data.slice(1), 'utf8');
  } catch (err) {
    const source = data === '-' ? 'stdin' : data.slice(1);
    throw new AuthError(4, `failed to read request data from ${source}: ${err.message}`);
  }
  return data;
}

function buildJsonBody(dataArg) {
  const raw = readDataValue(dataArg);
  try {
    JSON.parse(raw);
  } catch (err) {
    usageError(`--data is not valid JSON: ${err.message}`);
  }
  return raw;
}

function buildMultipartBody(form, files) {
  const fd = new FormData();
  for (const [k, v] of form) fd.append(k, v);
  for (const [field, filePath] of files) {
    let buf;
    try {
      buf = readFileSync(filePath);
    } catch (err) {
      throw new AuthError(4, `failed to read upload file ${filePath}: ${err.message}`);
    }
    const blob = new Blob([buf], { type: inferMime(filePath) });
    fd.append(field, blob, basename(filePath));
  }
  return fd;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function doFetch(url, method, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    const safeUrl = safeUrlForDiagnostic(url);
    if (err && err.name === 'AbortError') {
      throw new AuthError(4, `request to ${safeUrl} timed out after ${timeoutMs}ms`);
    }
    throw new AuthError(4, `network error calling ${safeUrl}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function isTextish(contentType) {
  return /json|text/i.test(contentType || '');
}

async function emitErrorAndExit(res, bodyText) {
  const status = res.status;
  let parsedBody = null;
  let safeBodyText = bodyText;
  if (bodyText) {
    try {
      parsedBody = redactValue(JSON.parse(bodyText));
      safeBodyText = JSON.stringify(parsedBody);
    } catch {
      process.stderr.write(
        'rb-api: warning: unstructured error text cannot be field-redacted; review before sharing\n',
      );
    }
  }

  if (status === 403) {
    process.stderr.write('rb-api: your role lacks permission on this project\n');
  } else if (status === 404) {
    process.stderr.write(
      'rb-api: not found — verify the canonical path and IDs (run `rb-api.mjs whoami`)\n',
    );
  } else if (status === 422) {
    const detail =
      parsedBody?.detail !== undefined ? JSON.stringify(parsedBody.detail) : safeBodyText;
    process.stderr.write(`rb-api: validation error: ${detail}\n`);
  } else if (status === 429) {
    const retryAfter = res.headers.get('retry-after');
    process.stderr.write(
      retryAfter ? `rb-api: rate limited — retry after ${retryAfter}\n` : 'rb-api: rate limited (429)\n',
    );
  } else {
    process.stderr.write(`rb-api: HTTP ${status}\n`);
  }
  if (safeBodyText) {
    process.stdout.write(safeBodyText.endsWith('\n') ? safeBodyText : `${safeBodyText}\n`);
  }
  process.exit(5);
}

/**
 * Re-mint client credentials once after a 401.
 */
function rejectedAuthMessage(source) {
  if (source === 'api_key') {
    return 'static API key was rejected — check RB_API_KEY, RB_ORG_ID, and RB_PROJECT_ID';
  }
  if (source === 'client_credentials') {
    return 'client credentials were rejected after re-minting — check RB_CLIENT_ID and RB_CLIENT_SECRET';
  }
  return 'session invalid — run `rightbrain login --non-interactive`';
}

async function requestWithAuthRetry(creds, url, method, headers, body, timeoutMs) {
  const authHeaders = { ...headers, Authorization: `Bearer ${creds.access_token}` };
  let res = await doFetch(url, method, authHeaders, body, timeoutMs);
  if (res.status !== 401) return { res, creds };

  if (creds.source !== 'client_credentials') {
    throw new AuthError(3, rejectedAuthMessage(creds.source));
  }

  let refreshed;
  try {
    refreshed = await resolve(null, { forceRefresh: true });
  } catch (err) {
    throw new AuthError(3, `${rejectedAuthMessage(creds.source)} (${err.message})`);
  }
  if (new URL(refreshed.api_base_url).origin !== url.origin) {
    throw new AuthError(3, 'refreshed credentials target a different API host; refusing to retry');
  }
  const retryHeaders = { ...headers, Authorization: `Bearer ${refreshed.access_token}` };
  res = await doFetch(url, method, retryHeaders, body, timeoutMs);
  if (res.status === 401) {
    throw new AuthError(3, rejectedAuthMessage(refreshed.source));
  }
  return { res, creds: refreshed };
}

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

async function streamSse(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let warnedUnstructured = false;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw new AuthError(4, `failed while reading SSE response: ${err.message}`);
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      const redacted = redactSseLine(line);
      if (!redacted.redacted && redacted.hasData) warnedUnstructured = true;
      process.stdout.write(`${redacted.line}\n`);
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.length) {
    const redacted = redactSseLine(buffer);
    if (!redacted.redacted && redacted.hasData) warnedUnstructured = true;
    process.stdout.write(redacted.line);
  }
  if (warnedUnstructured) {
    process.stderr.write(
      'rb-api: warning: non-JSON SSE data cannot be field-redacted; review before sharing\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

async function readResponseText(res) {
  try {
    return await res.text();
  } catch (err) {
    throw new AuthError(4, `failed to read HTTP ${res.status} response: ${err.message}`);
  }
}

async function fetchAllPages(
  initialCreds,
  baseUrl,
  method,
  headers,
  timeoutMs,
  maxPages,
) {
  const results = [];
  let pageUrl = new URL(baseUrl.toString());
  let page = 1;
  let creds = initialCreds;
  const seenCursors = new Set();

  for (let pageCount = 1; ; pageCount += 1) {
    if (pageCount > maxPages) {
      throw new AuthError(
        4,
        `pagination exceeded the ${maxPages}-page safety limit; set RB_MAX_PAGES to a larger ` +
          'positive integer only after confirming the endpoint can return that many pages',
      );
    }

    const requestResult = await requestWithAuthRetry(
      creds,
      pageUrl,
      method,
      headers,
      undefined,
      timeoutMs,
    );
    const { res } = requestResult;
    creds = requestResult.creds;
    const bodyText = await readResponseText(res);
    if (!res.ok) {
      await emitErrorAndExit(res, bodyText);
      return; // unreachable, emitErrorAndExit exits
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Not JSON at all — nothing to paginate, just return what we have (or the raw body once).
      if (results.length === 0) {
        process.stderr.write(
          'rb-api: warning: unstructured response text cannot be field-redacted; review before sharing\n',
        );
        process.stdout.write(bodyText);
        process.exit(0);
      }
      break;
    }

    if (!parsed || !Array.isArray(parsed.results)) {
      // Doesn't look like a paginated list — pass the single response through as-is.
      if (results.length === 0) {
        process.stdout.write(`${JSON.stringify(redactValue(parsed))}\n`);
        process.exit(0);
      }
      break;
    }

    results.push(...parsed.results);

    if (parsed.results.length === 0) break;

    // Rightbrain's shape: {pagination: {next_cursor, has_next, page_limit}, results: [...]}
    const pg = parsed.pagination;
    if (pg && typeof pg === 'object') {
      if (pg.has_next && typeof pg.next_cursor === 'string' && pg.next_cursor) {
        if (seenCursors.has(pg.next_cursor)) {
          throw new AuthError(4, 'pagination returned a repeated cursor');
        }
        seenCursors.add(pg.next_cursor);
        pageUrl = new URL(baseUrl.toString());
        pageUrl.searchParams.set('cursor', pg.next_cursor);
        continue;
      }
      break;
    }

    if (typeof parsed.next === 'string' && parsed.next) {
      let nextUrl;
      try {
        nextUrl = new URL(parsed.next, baseUrl);
      } catch (err) {
        throw new AuthError(4, `pagination returned an invalid next URL: ${err.message}`);
      }
      if (nextUrl.origin !== baseUrl.origin) {
        throw new AuthError(
          4,
          `pagination returned a cross-origin next URL (${nextUrl.origin}); refusing to forward credentials`,
        );
      }
      const cursorIdentity = nextUrl.toString();
      if (seenCursors.has(cursorIdentity)) {
        throw new AuthError(4, 'pagination returned a repeated next URL');
      }
      seenCursors.add(cursorIdentity);
      pageUrl = nextUrl;
      continue;
    }

    const total = typeof parsed.total === 'number' ? parsed.total : null;
    if (total !== null && results.length < total) {
      page += 1;
      pageUrl = new URL(baseUrl.toString());
      pageUrl.searchParams.set('page', String(page));
      continue;
    }

    break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// whoami / status
// ---------------------------------------------------------------------------

function formatStatus(result) {
  const lines = [];
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

async function runStatus() {
  try {
    const result = await resolve();
    process.stdout.write(`${formatStatus(result)}\n`);
    process.exit(0);
  } catch (err) {
    let apiBaseUrl = '(unresolved)';
    try {
      apiBaseUrl = resolveTargetMetadata().api_base_url || apiBaseUrl;
    } catch {
      // Preserve the authentication error; fallback metadata is diagnostic only.
    }
    process.stderr.write(`rb-api: ${err.message}\n`);
    process.stdout.write(
      `api_base_url: ${apiBaseUrl}\nsource: none\nstatus: not authenticated\n`,
    );
    process.exit(err instanceof AuthError ? err.code : 4);
  }
}

/**
 * Look up one resource's display name, reporting why rather than throwing if it
 * cannot be read. `whoami` is the first command a new install runs, so a failed
 * lookup must still leave the rest of the report intact and readable.
 */
async function describeResource(creds, label, path, id) {
  const base = creds.api_base_url.replace(/\/$/, '');
  let currentCreds = creds;
  try {
    const requestResult = await requestWithAuthRetry(
      creds,
      new URL(`${base}${path}`),
      'GET',
      { Accept: 'application/json' },
      undefined,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    currentCreds = requestResult.creds;
    const { res } = requestResult;
    const text = await readResponseText(res);
    if (!res.ok) {
      return { creds: currentCreds, line: `${label}: ${id} (lookup failed: HTTP ${res.status})` };
    }
    const body = JSON.parse(text);
    const name = body.name || body.display_name || '(unnamed)';
    return { creds: currentCreds, line: `${label}: ${name} (${id})` };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { creds: currentCreds, line: `${label}: ${id} (lookup failed: ${err.message})` };
  }
}

async function runWhoami() {
  let creds;
  try {
    creds = await resolve();
  } catch (err) {
    process.stderr.write(`rb-api: ${err.message}\n`);
    process.exit(err instanceof AuthError ? err.code : 4);
  }

  const lines = [
    `api_base_url: ${creds.api_base_url}`,
    `source: ${creds.source}`,
  ];

  if (creds.org_id) {
    const org = await describeResource(
      creds,
      'org',
      `/org/${encodeURIComponent(creds.org_id)}`,
      creds.org_id,
    );
    creds = org.creds;
    lines.push(org.line);
  } else {
    lines.push('org: (unset)');
  }

  if (creds.org_id && creds.project_id) {
    const project = await describeResource(
      creds,
      'project',
      `/org/${encodeURIComponent(creds.org_id)}/project/${encodeURIComponent(creds.project_id)}`,
      creds.project_id,
    );
    creds = project.creds;
    lines.push(project.line);
  } else {
    lines.push(`project: ${creds.project_id || '(unset)'}`);
  }

  if (creds.expires_at) {
    const remainingMin = Math.round((creds.expires_at - Date.now()) / 60000);
    const when = remainingMin >= 0 ? `in ${remainingMin}m` : `${-remainingMin}m ago`;
    lines.push(`token expiry: ${new Date(creds.expires_at).toISOString()} (${when})`);
  } else {
    lines.push('token expiry: (none — static credential)');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function normalizeJsonKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isSecretBearingKey(key, value) {
  if (typeof value === 'boolean') return false;
  const normalized = normalizeJsonKey(key);
  if (SECRET_KEYS.has(normalized)) return true;
  if (normalized.endsWith('_token')) return true;
  if (normalized.endsWith('_secret')) return true;
  if (normalized.endsWith('_password')) return true;
  if (normalized.endsWith('_credential') || normalized.endsWith('_credentials')) return true;
  if (normalized.endsWith('_api_key')) return true;
  if (normalized.endsWith('_access_key')) return true;
  return false;
}

function isApiKeyResponseObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set(Object.keys(value).map(normalizeJsonKey));
  return (
    keys.has('key') &&
    keys.has('oauth_client_id') &&
    (keys.has('id') || keys.has('name'))
  );
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const apiKeyResponse = isApiKeyResponseObject(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => [
        key,
        isSecretBearingKey(key, fieldValue) ||
        (apiKeyResponse && normalizeJsonKey(key) === 'key')
          ? '***'
          : redactValue(fieldValue),
      ]),
    );
  }
  return value;
}

function redactField(key, value) {
  return isSecretBearingKey(key, value) ? '***' : value;
}

function safeUrlForDiagnostic(url) {
  try {
    const safeUrl = new URL(url.toString());
    for (const [key, value] of safeUrl.searchParams) {
      if (isSecretBearingKey(key, value)) safeUrl.searchParams.set(key, '***');
    }
    return safeUrl.toString();
  } catch {
    return '(unprintable URL)';
  }
}

function redactSseLine(line) {
  const match = line.match(/^(data:)(\s?)(.*)$/);
  if (!match) return { line, hasData: false, redacted: false };
  const [, prefix, spacing, payload] = match;
  if (!payload || payload === '[DONE]') {
    return { line, hasData: false, redacted: false };
  }
  try {
    const safePayload = JSON.stringify(redactValue(JSON.parse(payload)));
    return { line: `${prefix}${spacing}${safePayload}`, hasData: true, redacted: true };
  } catch {
    return { line, hasData: true, redacted: false };
  }
}

function summarizeBodyForDryRun(opts) {
  if (opts.form.length || opts.files.length) {
    const parts = [
      ...opts.form.map(([k, v]) => `${k}=${redactField(k, v)}`),
      ...opts.files.map(([k, v]) => `${k}=${redactField(k, `@${v}`)}`),
    ];
    return `multipart/form-data { ${parts.join(', ')} }`;
  }
  if (opts.data !== null) {
    if (opts.data === '-') return 'application/json <stdin not read during dry-run>';
    if (opts.data.startsWith('@')) {
      return `application/json <file ${opts.data.slice(1)} not read during dry-run>`;
    }
    let preview = opts.data;
    try {
      preview = JSON.stringify(redactValue(JSON.parse(opts.data)));
    } catch {
      preview = '<invalid inline JSON>';
    }
    return `application/json ${
      preview.length > 500 ? `${preview.slice(0, 500)}... (${preview.length} bytes)` : preview
    }`;
  }
  return '(none)';
}

function timeoutFromOptions(opts) {
  const raw = opts.timeout ?? process.env.RB_REQUEST_TIMEOUT_MS ?? String(DEFAULT_REQUEST_TIMEOUT_MS);
  const value = Number(raw);
  if (
    !/^\d+$/.test(String(raw)) ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new AuthError(
      4,
      `RB_REQUEST_TIMEOUT_MS must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds.`,
    );
  }
  return value;
}

function maxPagesFromEnv() {
  const raw = process.env.RB_MAX_PAGES || String(DEFAULT_MAX_PAGES);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new AuthError(4, 'RB_MAX_PAGES must be a positive safe integer.');
  }
  return value;
}

function writeOutput(path, value) {
  try {
    writeFileSync(path, value);
  } catch (err) {
    throw new AuthError(4, `failed to write output file ${path}: ${err.message}`);
  }
}

function writeSecretOutput(path, value) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, value);
    closeSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
      try {
        unlinkSync(path);
      } catch {
        // Preserve the original write failure.
      }
    }
    const reason =
      err.code === 'EEXIST' ? 'file already exists; refusing to overwrite it' : err.message;
    throw new AuthError(4, `failed to write secret output file ${path}: ${reason}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (opts.dryRun) {
    const target = resolveTargetMetadata();
    const previewOpts = {
      ...opts,
      query: opts.query.map(([key, value]) => [key, redactField(key, value)]),
    };
    let previewUrl = null;
    let unresolvedReason = null;
    if (!target.api_base_url) {
      unresolvedReason = 'RB_API_BASE_URL is unresolved';
    } else {
      try {
        previewUrl = resolveUrl(
          target.api_base_url,
          opts.path,
          previewOpts,
          target.org_id,
          target.project_id,
        );
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        unresolvedReason = err.message;
      }
    }
    const previewHeaders = {
      Accept: opts.sse ? 'text/event-stream' : opts.accept || 'application/json',
      Authorization: 'Bearer ***',
    };
    if (opts.data !== null) previewHeaders['Content-Type'] = 'application/json';
    process.stderr.write(
      [
        `method: ${opts.method}`,
        `url: ${previewUrl ? previewUrl.toString() : '(unresolved)'}`,
        `target_source: ${target.source}`,
        `target_env: ${target.env}`,
        `query: ${new URLSearchParams(previewOpts.query).toString() || '(none)'}`,
        `headers: ${JSON.stringify(previewHeaders)}`,
        `body: ${summarizeBodyForDryRun(opts)}`,
        unresolvedReason
          ? `note: ${unresolvedReason} Set the named target values for an exact preview.`
          : 'note: target metadata was resolved without accessing credentials',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }

  if (opts.sub === 'status') return runStatus();
  if (opts.sub === 'whoami') return runWhoami();

  const creds = await resolve();
  const orgId = creds.org_id;
  const projectId = creds.project_id;

  // --- resolve URL ---
  let url;
  try {
    url = resolveUrl(creds.api_base_url, opts.path, opts, orgId, projectId);
  } catch (err) {
    if (err instanceof AuthError) {
      process.stderr.write(`rb-api: ${err.message}\n`);
      process.exit(err.code);
    }
    throw err;
  }

  // --- build body / headers ---
  const headers = {};
  let body;
  if (opts.form.length || opts.files.length) {
    body = buildMultipartBody(opts.form, opts.files);
    // Content-Type (with multipart boundary) is set automatically by fetch for FormData bodies.
  } else if (opts.data !== null) {
    body = buildJsonBody(opts.data);
    headers['Content-Type'] = 'application/json';
  }
  headers.Accept = opts.sse ? 'text/event-stream' : opts.accept || 'application/json';
  const timeoutMs = timeoutFromOptions(opts);

  // --- pagination path ---
  if (opts.all) {
    const results = await fetchAllPages(
      creds,
      url,
      opts.method,
      headers,
      timeoutMs,
      maxPagesFromEnv(),
    );
    const merged = { results, count: results.length };
    const safeMerged = redactValue(merged);
    const text = opts.compact
      ? JSON.stringify(safeMerged)
      : JSON.stringify(safeMerged, null, 2);
    if (opts.output) {
      writeOutput(opts.output, text);
    } else {
      process.stdout.write(`${text}\n`);
    }
    process.exit(0);
  }

  // --- SSE path ---
  if (opts.sse) {
    const { res } = await requestWithAuthRetry(
      creds,
      url,
      opts.method,
      headers,
      body,
      timeoutMs,
    );
    if (!res.ok) {
      const bodyText = await readResponseText(res);
      await emitErrorAndExit(res, bodyText);
      return;
    }
    await streamSse(res);
    process.exit(0);
  }

  // --- normal request ---
  const { res } = await requestWithAuthRetry(
    creds,
    url,
    opts.method,
    headers,
    body,
    timeoutMs,
  );
  const contentType = res.headers.get('content-type') || '';
  const normalizedContentType = contentType.toLowerCase();

  if (!res.ok) {
    const bodyText = await readResponseText(res);
    if (opts.secretOutput) {
      process.stderr.write(
        'rb-api: --secret-output is only valid for successful JSON responses; no file was written\n',
      );
    }
    await emitErrorAndExit(res, bodyText);
    return;
  }

  if (opts.secretOutput && !normalizedContentType.includes('json')) {
    throw new AuthError(
      4,
      '--secret-output requires a successful JSON response; no file was written',
    );
  }

  // Empty-body success (e.g. 204 from a DELETE, or a 200 with no content-type and
  // no body) is a plain success — not binary output demanding --output.
  let rawBuf;
  try {
    rawBuf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new AuthError(4, `failed to read HTTP ${res.status} response: ${err.message}`);
  }
  if (rawBuf.length === 0) {
    if (opts.secretOutput) {
      throw new AuthError(
        4,
        '--secret-output requires a non-empty successful JSON response; no file was written',
      );
    }
    process.stderr.write(`rb-api: ${res.status} (no response body)\n`);
    process.exit(0);
  }

  if (!isTextish(contentType)) {
    process.stderr.write(
      'rb-api: warning: binary response content cannot be inspected or field-redacted\n',
    );
    if (!opts.output) {
      process.stderr.write(
        `rb-api: response is binary (content-type: ${contentType || 'unknown'}) — pass --output <path>.\n`,
      );
      process.exit(4);
    }
    writeOutput(opts.output, rawBuf);
    process.exit(0);
  }

  const bodyText = rawBuf.toString('utf8');
  if (opts.output) {
    writeOutput(opts.output, bodyText);
    process.exit(0);
  }

  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (opts.secretOutput) {
        writeSecretOutput(opts.secretOutput, bodyText);
        process.stderr.write(
          `rb-api: unredacted JSON written to new 0600 file ${opts.secretOutput}; stdout remains redacted\n`,
        );
      }
      const safeParsed = redactValue(parsed);
      const text = opts.compact
        ? JSON.stringify(safeParsed)
        : JSON.stringify(safeParsed, null, 2);
      process.stdout.write(`${text}\n`);
      process.exit(0);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (opts.secretOutput) {
        throw new AuthError(
          4,
          '--secret-output requires valid JSON; no file was written',
        );
      }
      // Not actually valid JSON despite the header — fall through and print raw text.
    }
  }

  process.stderr.write(
    'rb-api: warning: unstructured response text cannot be field-redacted; review before sharing\n',
  );
  process.stdout.write(bodyText.endsWith('\n') || bodyText === '' ? bodyText : `${bodyText}\n`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = err instanceof AuthError ? err.code : 4;
    process.stderr.write(`rb-api: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(code);
  });
}

export { parseArgs, resolveUrl, isTextish, inferMime };
