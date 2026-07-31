// Test suite for rb-api.mjs, run with: node --test test/
//
// Uses a single in-process mock HTTP server (per-test handler swapped in/out) and spawns the
// CLI as a real child process with explicit stdio pipes and a hard timeout — execFileSync
// against this same mock server previously hung, so everything here goes through async spawn.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveUrl } from '../plugins/rightbrain/skills/rightbrain/scripts/rb-api.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const scriptsDir = join(
  __dirname,
  '..',
  'plugins',
  'rightbrain',
  'skills',
  'rightbrain',
  'scripts',
);
const CLI = join(scriptsDir, 'rb-api.mjs');
const AUTH_CLI = join(scriptsDir, 'rb-auth.mjs');
const CLI_TIMEOUT_MS = 5000;

// --- mock server -----------------------------------------------------------

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let currentHandler = async (_req, res) => {
  res.writeHead(500, { 'content-type': 'text/plain' }).end('no handler installed for this test');
};

const server = createServer((req, res) => {
  Promise.resolve(currentHandler(req, res)).catch((err) => {
    try {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err && err.stack ? err.stack : err));
    } catch {
      // response already sent
    }
  });
});

let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function baseUrl() {
  return `http://127.0.0.1:${port}`;
}

function setHandler(fn) {
  currentHandler = fn;
}

// --- CLI runner --------------------------------------------------------------

function runScript(script, args, { env = {}, input } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectPromise(new Error(`CLI timed out after ${CLI_TIMEOUT_MS}ms: ${args.join(' ')}\nstdout so far: ${stdout}\nstderr so far: ${stderr}`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function runCli(args, options = {}) {
  return runScript(CLI, args, options);
}

function combinedOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function clientCredentialEnv(home, extra = {}) {
  return {
    RB_API_BASE_URL: baseUrl(),
    RB_OAUTH_URL: baseUrl(),
    RB_CLIENT_ID: 'client-1',
    RB_CLIENT_SECRET: 'secret-1',
    RB_ORG_ID: 'org-1',
    RB_PROJECT_ID: 'proj-1',
    RB_API_KEY: '',
    RB_CLI: '/definitely/not/a/rightbrain-cli',
    HOME: home,
    ...extra,
  };
}

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'rb-api-test-home-'));
}

// Writes a stand-in for the Rightbrain CLI that answers `token --json`. The session
// tier requires a CLI — it is the only thing that knows which environment a session
// belongs to — so tests covering session behaviour supply one.
function writeSessionCli(home, { token = 'cli-session-token', dashboardUrl, expiresAt } = {}) {
  const path = join(home, 'fake-rightbrain-cli');
  const payload = {
    access_token: token,
    org_id: 'org-1',
    project_id: 'proj-1',
    ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
  writeFileSync(
    path,
    '#!/usr/bin/env node\n' +
      'const a = process.argv.slice(2);\n' +
      "if (a[0] === '--version') { process.stdout.write('0.3.0\\n'); process.exit(0); }\n" +
      "if (a[0] === 'token') { process.stdout.write(JSON.stringify(" +
      JSON.stringify(payload) +
      ") + '\\n'); process.exit(0); }\n" +
      'process.exit(1);\n',
  );
  chmodSync(path, 0o700);
  return path;
}

// Common env baseline for tests using the static-API-key tier.
function apiKeyEnv(extra = {}) {
  return {
    RB_API_BASE_URL: baseUrl(),
    RB_API_KEY: 'test-static-key',
    RB_ORG_ID: 'org-1',
    RB_PROJECT_ID: 'proj-1',
    HOME: freshHome(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Path scoping
// ---------------------------------------------------------------------------

test('paths are exact by default', async () => {
  let seenPath;
  setHandler(async (req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code, stdout } = await runCli(
    ['GET', '/org/org-1/project/proj-1/thing'],
    { env: apiKeyEnv() },
  );
  assert.equal(code, 0);
  assert.equal(seenPath, '/org/org-1/project/proj-1/thing');
  assert.match(stdout, /"ok": true/);
});

test('--project-scope prefixes selected organization and project', async () => {
  let seenPath;
  setHandler(async (req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code } = await runCli(['GET', '/thing', '--project-scope'], {
    env: apiKeyEnv(),
  });
  assert.equal(code, 0);
  assert.equal(seenPath, '/org/org-1/project/proj-1/thing');
});

test('--org-scope prefixes the selected organization', async () => {
  let seenPath;
  setHandler(async (req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code } = await runCli(['GET', '/thing', '--org-scope'], { env: apiKeyEnv() });
  assert.equal(code, 0);
  assert.equal(seenPath, '/org/org-1/thing');
});

test('scoped root URLs omit the trailing slash', () => {
  const base = 'https://stag.leftbrain.me/api/v1';
  const projectUrl = resolveUrl(
    base,
    '/',
    { projectScope: true, orgScope: false, query: [['view', 'openapi']] },
    'org-1',
    'proj-1',
  );
  const orgUrl = resolveUrl(
    base,
    '/',
    { projectScope: false, orgScope: true, query: [] },
    'org-1',
    'proj-1',
  );
  const exactUrl = resolveUrl(
    base,
    '/',
    { projectScope: false, orgScope: false, query: [] },
    'org-1',
    'proj-1',
  );

  assert.equal(
    projectUrl.href,
    'https://stag.leftbrain.me/api/v1/org/org-1/project/proj-1?view=openapi',
  );
  assert.equal(orgUrl.href, 'https://stag.leftbrain.me/api/v1/org/org-1');
  assert.equal(exactUrl.href, 'https://stag.leftbrain.me/api/v1/');
});

test('empty-body 2xx (e.g. 204 DELETE) is success, not binary output', async () => {
  setHandler(async (req, res) => {
    res.writeHead(204).end(); // no body, no content-type
  });

  const { code, stdout, stderr } = await runCli(['DELETE', '/thing/t-1'], { env: apiKeyEnv() });
  assert.equal(code, 0);
  assert.match(stderr, /204 \(no response body\)/);
  assert.doesNotMatch(stderr, /--output/);
  assert.equal(stdout.trim(), '');
});

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

test('query building: multiple --query flags are URL-encoded and merged', async () => {
  let seenQuery;
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    seenQuery = url.searchParams;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code } = await runCli(
    ['GET', '/thing', '--query', 'a=1', '--query', 'b=two words', '--query', 'c=x&y'],
    { env: apiKeyEnv() },
  );
  assert.equal(code, 0);
  assert.equal(seenQuery.get('a'), '1');
  assert.equal(seenQuery.get('b'), 'two words');
  assert.equal(seenQuery.get('c'), 'x&y');
});

// ---------------------------------------------------------------------------
// JSON body
// ---------------------------------------------------------------------------

test('JSON body: --data is sent as application/json and echoed back', async () => {
  let receivedContentType;
  let receivedBody;
  setHandler(async (req, res) => {
    receivedContentType = req.headers['content-type'];
    const raw = await readRawBody(req);
    receivedBody = JSON.parse(raw.toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ echoed: receivedBody }));
  });

  const { code, stdout } = await runCli(
    ['POST', '/things', '--data', JSON.stringify({ name: 'widget', qty: 3 })],
    { env: apiKeyEnv() },
  );
  assert.equal(code, 0);
  assert.equal(receivedContentType, 'application/json');
  assert.deepEqual(receivedBody, { name: 'widget', qty: 3 });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.echoed, { name: 'widget', qty: 3 });
});

test('successful JSON responses recursively redact secrets without hiding token metrics', async () => {
  const secrets = [
    'access-value',
    'refresh-value',
    'client-secret-value',
    'webhook-secret-value',
    'password-value',
    'authorization-value',
    'credential-value',
    'api-key-value',
    'verification-code-value',
    'one-time-token-value',
  ];
  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          access_token: secrets[0],
          nested: {
            refreshToken: secrets[1],
            client_secret: secrets[2],
            webhookSecret: secrets[3],
            password: secrets[4],
            authorization: secrets[5],
            credentials: { value: secrets[6] },
            apiKey: secrets[7],
            verification_code: secrets[8],
            one_time_token: secrets[9],
          },
          token_count: 123,
          input_tokens: 45,
          token_usage: { total: 168 },
          token_usage_report: 'public-metric',
          public_token_id: 'public-id',
          key: 'ordinary-key',
          has_api_key: true,
          status_code: 200,
        }),
      );
  });

  const result = await runCli(['GET', '/secrets'], { env: apiKeyEnv() });
  assert.equal(result.code, 0, result.stderr);
  for (const secret of secrets) {
    assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
  }
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.access_token, '***');
  assert.equal(parsed.nested.refreshToken, '***');
  assert.equal(parsed.nested.client_secret, '***');
  assert.equal(parsed.nested.credentials, '***');
  assert.equal(parsed.token_count, 123);
  assert.equal(parsed.input_tokens, 45);
  assert.deepEqual(parsed.token_usage, { total: 168 });
  assert.equal(parsed.token_usage_report, 'public-metric');
  assert.equal(parsed.public_token_id, 'public-id');
  assert.equal(parsed.key, 'ordinary-key');
  assert.equal(parsed.has_api_key, true);
  assert.equal(parsed.status_code, 200);
});

test('API-key response context and secret suffixes redact without hiding ordinary keys', async () => {
  const secrets = ['created-api-key', 'webhook-auth-secret', 'project-agent-access-key'];
  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          id: 'key-id-1',
          name: 'Automation key',
          oauth_client_id: 'oauth-client-1',
          key: secrets[0],
          webhook: { auth_secret: secrets[1], auth_secret_configured: true },
          project: {
            agent_access_key: secrets[2],
            agent_access_key_id: 'public-agent-key-id',
            has_agent_access_key: true,
          },
          ordinary: {
            key: 'visible-root-key',
            nested: { key: 'visible-nested-key' },
            metadata: { id: 'meta-1', name: 'metadata', key: 'visible-metadata-key' },
          },
        }),
      );
  });

  const result = await runCli(['GET', '/api-key-response'], { env: apiKeyEnv() });
  assert.equal(result.code, 0, result.stderr);
  for (const secret of secrets) {
    assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
  }
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.key, '***');
  assert.equal(parsed.webhook.auth_secret, '***');
  assert.equal(parsed.webhook.auth_secret_configured, true);
  assert.equal(parsed.project.agent_access_key, '***');
  assert.equal(parsed.project.agent_access_key_id, 'public-agent-key-id');
  assert.equal(parsed.project.has_agent_access_key, true);
  assert.equal(parsed.ordinary.key, 'visible-root-key');
  assert.equal(parsed.ordinary.nested.key, 'visible-nested-key');
  assert.equal(parsed.ordinary.metadata.key, 'visible-metadata-key');
});

test('JSON API error bodies are recursively redacted on both output streams', async () => {
  const secrets = ['error-access-value', 'error-client-secret', 'error-code-value'];
  setHandler(async (_req, res) => {
    res
      .writeHead(422, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          detail: {
            access_token: secrets[0],
            nested: { clientSecret: secrets[1], verification_code: secrets[2] },
            token_count: 7,
          },
        }),
      );
  });

  const result = await runCli(['POST', '/secrets', '--data', '{}'], {
    env: apiKeyEnv(),
  });
  assert.equal(result.code, 5);
  for (const secret of secrets) {
    assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
  }
  assert.match(result.stderr, /"access_token":"\*\*\*"/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.detail.access_token, '***');
  assert.equal(parsed.detail.nested.clientSecret, '***');
  assert.equal(parsed.detail.token_count, 7);
});

test('JSON-shaped text responses are redacted even with an incorrect content type', async () => {
  const secret = 'mislabelled-json-secret';
  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end(JSON.stringify({ access_token: secret, token_count: 2 }));
  });
  const result = await runCli(['GET', '/mislabelled'], { env: apiKeyEnv() });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { access_token: '***', token_count: 2 });
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
});

// ---------------------------------------------------------------------------
// Multipart with a file
// ---------------------------------------------------------------------------

test('multipart: --form and --file build multipart/form-data', async () => {
  const home = freshHome();
  const filePath = join(home, 'upload.txt');
  writeFileSync(filePath, 'hello from a test file\n');

  let receivedContentType;
  let receivedRaw;
  setHandler(async (req, res) => {
    receivedContentType = req.headers['content-type'];
    receivedRaw = (await readRawBody(req)).toString('utf8');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code } = await runCli(
    [
      'POST',
      '/upload',
      '--form',
      'title=my upload',
      '--file',
      `attachment=@${filePath}`,
    ],
    { env: apiKeyEnv({ HOME: home }) },
  );

  assert.equal(code, 0);
  assert.match(receivedContentType, /^multipart\/form-data; boundary=/);
  assert.match(receivedRaw, /name="title"/);
  assert.match(receivedRaw, /my upload/);
  assert.match(receivedRaw, /name="attachment"/);
  assert.match(receivedRaw, /filename="upload\.txt"/);
  assert.match(receivedRaw, /hello from a test file/);
});

// ---------------------------------------------------------------------------
// 401 -> client-credentials re-mint -> retry once
// ---------------------------------------------------------------------------

test('401 then forced client-credentials re-mint succeeds on retry', async () => {
  const home = freshHome();
  let mintCount = 0;
  let apiCallTokens = [];

  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      mintCount += 1;
      const body = await readRawBody(req);
      assert.match(body.toString('utf8'), /grant_type=client_credentials/);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: `token-${mintCount}`, expires_in: 3600 }));
      return;
    }

    const auth = req.headers.authorization || '';
    apiCallTokens.push(auth);
    if (auth === 'Bearer token-1') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"expired"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code, stdout } = await runCli(['GET', '/widgets'], {
    env: {
      RB_API_BASE_URL: baseUrl(),
      RB_OAUTH_URL: baseUrl(),
      RB_CLIENT_ID: 'client-1',
      RB_CLIENT_SECRET: 'secret-1',
      RB_ORG_ID: 'org-1',
      RB_PROJECT_ID: 'proj-1',
      HOME: home,
    },
  });

  assert.equal(code, 0);
  assert.match(stdout, /"ok": true/);
  assert.equal(mintCount, 2, 'expected one initial mint and one forced re-mint after 401');
  assert.deepEqual(apiCallTokens, ['Bearer token-1', 'Bearer token-2']);
});

// ---------------------------------------------------------------------------
// 401 twice -> exit 3
// ---------------------------------------------------------------------------

test('static API key 401 exits 3 with tier-accurate guidance', async () => {
  setHandler(async (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"nope"}');
  });

  const { code, stderr } = await runCli(['GET', '/widgets'], { env: apiKeyEnv() });
  assert.equal(code, 3);
  assert.match(stderr, /static API key was rejected/);
  assert.doesNotMatch(stderr, /session invalid|login/);
});

// ---------------------------------------------------------------------------
// 404 mapping -> exit 5
// ---------------------------------------------------------------------------

test('404 maps to an actionable message, prints body, exits 5', async () => {
  setHandler(async (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"widget not found"}');
  });

  const { code, stdout, stderr } = await runCli(['GET', '/widgets/999'], { env: apiKeyEnv() });
  assert.equal(code, 5);
  assert.match(stderr, /not found — verify the canonical path and IDs/);
  assert.match(stderr, /rb-api\.mjs whoami/);
  assert.match(stdout, /widget not found/);
});

// ---------------------------------------------------------------------------
// --dry-run redaction
// ---------------------------------------------------------------------------

test('--dry-run redacts the token and never calls the network', async () => {
  setHandler(async (_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('dry-run must never reach the server');
  });

  const secret = 'super-secret-token-value-should-not-leak';
  const { code, stdout, stderr } = await runCli(['GET', '/widgets', '--dry-run'], {
    env: apiKeyEnv({ RB_API_KEY: secret }),
  });

  assert.equal(code, 0);
  assert.match(stderr, /Bearer \*\*\*/);
  assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(secret));
  assert.equal(stdout, '');
});

test('--dry-run reports unresolved explicit project scope', async () => {
  const home = freshHome();
  const { code, stderr } = await runCli(
    ['GET', '/widgets', '--project-scope', '--dry-run'],
    {
    env: {
      RB_API_BASE_URL: baseUrl(),
      HOME: home,
    },
    },
  );
  assert.equal(code, 0);
  assert.match(stderr, /Bearer \*\*\*/);
  assert.match(stderr, /url: \(unresolved\)/);
  assert.match(stderr, /project scoping requested/);
  assert.doesNotMatch(stderr, /%7Borg_id%7D|%7Bproject_id%7D|app\.rightbrain\.ai/);
});

test('--dry-run never invokes auth, reads upload files, or exposes secret fields', async () => {
  const home = freshHome();
  const marker = join(home, 'cli-was-run');
  const fakeCli = join(home, 'rightbrain cli with spaces');
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
  );
  chmodSync(fakeCli, 0o700);

  const secret = 'must-not-appear';
  const result = await runCli(
    [
      'POST',
      '/widgets',
      '--query',
      `access_token=${secret}`,
      '--form',
      `password=${secret}`,
      '--form',
      'title=visible',
      '--file',
      `attachment=@${join(home, 'missing upload.bin')}`,
      '--dry-run',
    ],
    {
      env: {
        RB_API_BASE_URL: baseUrl(),
        RB_CLI: fakeCli,
        HOME: home,
      },
    },
  );

  assert.equal(result.code, 0);
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
  assert.match(result.stderr, /access_token=\*\*\*/);
  assert.match(result.stderr, /password=\*\*\*/);
  assert.match(result.stderr, /title=visible/);
  assert.equal(readdirSync(home).includes('cli-was-run'), false);
});

test('--dry-run redacts nested inline JSON and never reads @files', async () => {
  const secret = 'nested-secret-value';
  const inline = JSON.stringify({
    name: 'visible',
    credentials: { authorization: secret },
  });
  const inlineResult = await runCli(['POST', '/widgets', '--data', inline, '--dry-run'], {
    env: { RB_API_BASE_URL: baseUrl(), HOME: freshHome() },
  });
  assert.equal(inlineResult.code, 0);
  assert.match(inlineResult.stderr, /"name":"visible"/);
  assert.doesNotMatch(combinedOutput(inlineResult), new RegExp(secret));

  const fileResult = await runCli(
    ['POST', '/widgets', '--data', '@/definitely/missing/private.json', '--dry-run'],
    { env: { RB_API_BASE_URL: baseUrl(), HOME: freshHome() } },
  );
  assert.equal(fileResult.code, 0);
  assert.match(fileResult.stderr, /not read during dry-run/);
});

// ---------------------------------------------------------------------------
// --sse streaming order
// ---------------------------------------------------------------------------

test('--sse streams lines to stdout in arrival order, split across chunks', async () => {
  setHandler(async (req, res) => {
    assert.equal(req.headers.accept, 'text/event-stream');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: chunk1\ndata: ch');
    await new Promise((r) => setTimeout(r, 20));
    res.write('unk2\n');
    await new Promise((r) => setTimeout(r, 20));
    res.write('data: chunk3\n');
    res.end();
  });

  const { code, stdout } = await runCli(['GET', '/stream', '--sse'], { env: apiKeyEnv() });
  assert.equal(code, 0);
  assert.equal(stdout, 'data: chunk1\ndata: chunk2\ndata: chunk3\n');
});

test('--sse redacts JSON data payloads and warns for unstructured data', async () => {
  const secret = 'sse-access-secret';
  setHandler(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: update\ndata: {"access_token":"${secret}","token_count":9}\n\n`);
    res.write('data: plain text remains\n');
    res.end();
  });

  const result = await runCli(['GET', '/stream', '--sse'], { env: apiKeyEnv() });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    'event: update\ndata: {"access_token":"***","token_count":9}\n\ndata: plain text remains\n',
  );
  assert.match(result.stderr, /non-JSON SSE data cannot be field-redacted/);
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
});

// ---------------------------------------------------------------------------
// Pagination merge
// ---------------------------------------------------------------------------

test('--all auto-paginates and merges results with a count', async () => {
  const pages = {
    null: { results: [{ id: 1 }, { id: 2 }], total: 5 },
    2: { results: [{ id: 3 }, { id: 4 }], total: 5 },
    3: { results: [{ id: 5 }], total: 5 },
  };
  const requestedPages = [];

  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    const pageParam = url.searchParams.get('page');
    requestedPages.push(pageParam);
    const key = pageParam === null ? 'null' : Number(pageParam);
    const page = pages[key];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });

  const { code, stdout } = await runCli(['GET', '/items', '--all'], { env: apiKeyEnv() });
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.count, 5);
  assert.deepEqual(parsed.results.map((r) => r.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(requestedPages, [null, '2', '3']);
});

test('--all recursively redacts secrets in merged results', async () => {
  const secrets = ['page-one-token', 'page-two-secret'];
  setHandler(async (req, res) => {
    const cursor = new URL(req.url, baseUrl()).searchParams.get('cursor');
    const body = cursor
      ? {
          results: [{ id: 2, webhook_secret: secrets[1], output_tokens: 20 }],
          pagination: { has_next: false },
        }
      : {
          results: [{ id: 1, access_token: secrets[0], output_tokens: 10 }],
          pagination: { has_next: true, next_cursor: 'second' },
        };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  const result = await runCli(['GET', '/items', '--all'], { env: apiKeyEnv() });
  assert.equal(result.code, 0, result.stderr);
  for (const secret of secrets) {
    assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
  }
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.results[0].access_token, '***');
  assert.equal(parsed.results[1].webhook_secret, '***');
  assert.deepEqual(parsed.results.map((item) => item.output_tokens), [10, 20]);
});

// ---------------------------------------------------------------------------
// whoami output shape
// ---------------------------------------------------------------------------

test('whoami prints host/source/org/project and never the token', async () => {
  const secret = 'whoami-secret-token';
  const responseSecrets = ['whoami-org-access-token', 'whoami-project-client-secret'];
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (url.pathname === '/org/org-1') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            name: 'Acme Org',
            id: 'org-1',
            access_token: responseSecrets[0],
          }),
        );
      return;
    }
    if (url.pathname === '/org/org-1/project/proj-1') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            name: 'Widget Project',
            id: 'proj-1',
            client_secret: responseSecrets[1],
          }),
        );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });

  const { code, stdout, stderr } = await runCli(['whoami'], {
    env: apiKeyEnv({ RB_API_KEY: secret }),
  });
  assert.equal(code, 0);
  // whoami reports the host in use, not the RB_ENV preset — a session carries
  // its own environment, and the two disagree whenever it is not production.
  assert.match(stdout, /^api_base_url: http:\/\/127\.0\.0\.1:\d+$/m);
  assert.match(stdout, /^source: api_key$/m);
  assert.match(stdout, /^org: Acme Org \(org-1\)$/m);
  assert.match(stdout, /^project: Widget Project \(proj-1\)$/m);
  assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(secret));
  for (const responseSecret of responseSecrets) {
    assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(responseSecret));
  }
});

// ---------------------------------------------------------------------------
// org/project null -> exit 4
// ---------------------------------------------------------------------------

test('unresolved org/project on a scoped path exits 4 with guidance', async () => {
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }));
      return;
    }
    res.writeHead(500, { 'content-type': 'text/plain' }).end('should not reach the API without org/project');
  });

  const { code, stderr } = await runCli(['GET', '/widgets', '--project-scope'], {
    env: {
      RB_API_BASE_URL: baseUrl(),
      RB_OAUTH_URL: baseUrl(),
      RB_CLIENT_ID: 'client-1',
      RB_CLIENT_SECRET: 'secret-1',
      HOME: freshHome(),
      // Deliberately no RB_ORG_ID / RB_PROJECT_ID.
    },
  });

  assert.equal(code, 4);
  assert.match(stderr, /RB_ORG_ID/);
  assert.match(stderr, /RB_PROJECT_ID/);
});

test('exact paths do not require organization or project metadata', async () => {
  let seenPath;
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }));
      return;
    }
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const { code } = await runCli(['GET', '/health'], {
    env: {
      RB_API_BASE_URL: baseUrl(),
      RB_OAUTH_URL: baseUrl(),
      RB_CLIENT_ID: 'client-1',
      RB_CLIENT_SECRET: 'secret-1',
      HOME: freshHome(),
    },
  });
  assert.equal(code, 0);
  assert.equal(seenPath, '/health');
});

// ---------------------------------------------------------------------------
// Auth cache isolation and validation
// ---------------------------------------------------------------------------

test('client credential cache is isolated by client, OAuth host, API host, and audience', async () => {
  const home = freshHome();
  let mintCount = 0;
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (req.method === 'POST' && url.pathname.endsWith('/oauth2/token')) {
      mintCount += 1;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: `token-${mintCount}`, expires_in: 3600 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const variants = [
    {},
    { RB_CLIENT_ID: 'client-2' },
    { RB_CLIENT_ID: 'client-2', RB_OAUTH_URL: `${baseUrl()}/other-oauth` },
    {
      RB_CLIENT_ID: 'client-2',
      RB_OAUTH_URL: `${baseUrl()}/other-oauth`,
      RB_API_BASE_URL: `${baseUrl()}/alternate-api`,
    },
    {
      RB_CLIENT_ID: 'client-2',
      RB_OAUTH_URL: `${baseUrl()}/other-oauth`,
      RB_API_BASE_URL: `${baseUrl()}/alternate-api`,
      RB_AUDIENCE: 'different-audience',
    },
  ];

  for (const variant of variants) {
    const result = await runCli(['GET', '/health'], {
      env: clientCredentialEnv(home, variant),
    });
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(mintCount, variants.length);
  const cacheNames = readdirSync(join(home, '.rightbrain')).filter((name) =>
    name.startsWith('cc-token-'),
  );
  assert.equal(cacheNames.length, variants.length);
  assert.ok(cacheNames.every((name) => !name.includes('client') && !name.includes('secret')));
});

test('client credential writes tighten an existing Rightbrain directory to 0700', async () => {
  const home = freshHome();
  const rightbrainDir = join(home, '.rightbrain');
  mkdirSync(rightbrainDir, { recursive: true, mode: 0o755 });
  chmodSync(rightbrainDir, 0o755);
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (req.method === 'POST' && url.pathname.endsWith('/oauth2/token')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"access_token":"directory-mode-token","expires_in":3600}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const result = await runCli(['GET', '/health'], {
    env: clientCredentialEnv(home),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(statSync(rightbrainDir).mode & 0o777, 0o700);
});

test('concurrent client credential resolution mints once and reuses the locked cache', async () => {
  const home = freshHome();
  let mintCount = 0;
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (url.pathname === '/oauth2/token') {
      mintCount += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"access_token":"shared-token","expires_in":3600}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const env = clientCredentialEnv(home);
  const [first, second] = await Promise.all([
    runCli(['GET', '/health'], { env }),
    runCli(['GET', '/health'], { env }),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(mintCount, 1);
});

test('stale dead-owner auth locks are recovered before minting', async () => {
  const home = freshHome();
  let mintCount = 0;
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (url.pathname === '/oauth2/token') {
      mintCount += 1;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: `lock-token-${mintCount}`, expires_in: 3600 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const env = clientCredentialEnv(home);
  const first = await runCli(['GET', '/health'], { env });
  assert.equal(first.code, 0, first.stderr);
  const cacheDir = join(home, '.rightbrain');
  const cacheName = readdirSync(cacheDir).find(
    (name) => name.startsWith('cc-token-') && name.endsWith('.json'),
  );
  const cachePath = join(cacheDir, cacheName);
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  writeFileSync(cachePath, JSON.stringify({ ...cached, expires_at: 0 }));
  writeFileSync(
    `${cachePath}.lock`,
    JSON.stringify({ pid: 99999999, timestamp: Date.now() - 60000 }),
  );

  const second = await runCli(['GET', '/health'], { env });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(mintCount, 2);
  assert.equal(readdirSync(cacheDir).some((name) => name.endsWith('.lock')), false);
});

test('partial client credentials fail closed instead of using an ambient session', async () => {
  const home = freshHome();

  const { code, stderr } = await runCli(['GET', '/health'], {
    env: {
      RB_API_BASE_URL: baseUrl(),
      RB_CLIENT_ID: 'only-client-id',
      RB_CLIENT_SECRET: '',
      RB_API_KEY: '',
      RB_CLI: '/definitely/not/a/rightbrain-cli',
      HOME: home,
    },
  });
  assert.equal(code, 4);
  assert.match(stderr, /must be set together/);
  assert.match(stderr, /refusing to fall back/);
});

test('malformed client token response is not cached', async () => {
  const home = freshHome();
  let mintCount = 0;
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (url.pathname === '/oauth2/token') {
      mintCount += 1;
      let body = '{"access_token":"valid-token","expires_in":3600}';
      if (mintCount === 1) body = '{"access_token":"","expires_in":3600}';
      if (mintCount === 2) body = '{"access_token":"token","expires_in":-1}';
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const env = clientCredentialEnv(home);
  const first = await runCli(['GET', '/health'], { env });
  assert.equal(first.code, 4);
  assert.match(first.stderr, /no valid access_token/);
  const second = await runCli(['GET', '/health'], { env });
  assert.equal(second.code, 4);
  assert.match(second.stderr, /invalid expires_in/);
  const third = await runCli(['GET', '/health'], { env });
  assert.equal(third.code, 0, third.stderr);
  assert.equal(mintCount, 3);
});

test('OAuth error diagnostics never echo raw response secrets', async () => {
  const secret = 'oauth-error-response-secret';
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (url.pathname === '/oauth2/token') {
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ client_secret: secret, error: 'invalid_client' }));
      return;
    }
    res.writeHead(500).end();
  });

  const result = await runCli(['GET', '/health'], {
    env: clientCredentialEnv(freshHome()),
  });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /client-credentials mint failed \(400\)/);
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
});

test('session authentication requires the Rightbrain CLI', async () => {
  const home = freshHome();
  const { code, stderr } = await runCli(['GET', '/health'], {
    env: {
      RB_API_KEY: '',
      RB_CLIENT_ID: '',
      RB_CLIENT_SECRET: '',
      RB_CLI: '',
      PATH: '/definitely/no/rightbrain',
      HOME: home,
    },
  });

  assert.equal(code, 2);
  assert.match(stderr, /Rightbrain CLI is required/);
  assert.match(stderr, /rightbrain@latest/);
});

test('CLI session failures are not misreported as a missing installation', async () => {
  const home = freshHome();
  const fakeCli = join(home, 'rightbrain-cli');
  writeFileSync(
    fakeCli,
    "#!/usr/bin/env node\n" +
      "if (process.argv[2] === '--version') { console.log('0.3.0'); process.exit(0); }\n" +
      "process.stderr.write('expired private session detail\\n'); process.exit(1);\n",
  );
  chmodSync(fakeCli, 0o700);

  const result = await runCli(['GET', '/health'], {
    env: {
      RB_API_KEY: '',
      RB_CLIENT_ID: '',
      RB_CLIENT_SECRET: '',
      RB_CLI: fakeCli,
      RB_ENV: 'custom-session-name',
      HOME: home,
    },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no usable session/);
  assert.doesNotMatch(result.stderr, /install.*CLI/i);
  assert.doesNotMatch(result.stderr, /expired private session detail/);
});

test('invalid and outdated RB_CLI commands fail as configuration errors', async () => {
  const home = freshHome();
  const nonExecutable = join(home, 'non-executable-cli');
  writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  const startupResult = await runCli(['GET', '/health'], {
    env: { RB_CLI: nonExecutable, HOME: home },
  });
  assert.equal(startupResult.code, 4);
  assert.match(startupResult.stderr, /could not start/);

  const outdated = join(home, 'outdated-cli');
  writeFileSync(
    outdated,
    "#!/usr/bin/env node\nif (process.argv[2] === '--version') console.log('0.2.9');\n",
  );
  chmodSync(outdated, 0o700);
  const versionResult = await runCli(['GET', '/health'], {
    env: { RB_CLI: outdated, HOME: home },
  });
  assert.equal(versionResult.code, 4);
  assert.match(versionResult.stderr, /0\.3\.0 or newer is required/);
});

test('session requests use the host returned by the CLI', async () => {
  const home = freshHome();
  let calls = 0;
  setHandler(async (req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });

  const result = await runCli(['GET', '/health'], {
    env: {
      RB_ENV: 'custom-session-name',
      RB_API_BASE_URL: 'https://override.invalid/api/v1',
      RB_API_KEY: '',
      RB_CLIENT_ID: '',
      RB_CLIENT_SECRET: '',
      RB_CLI: writeSessionCli(home, { dashboardUrl: baseUrl().replace('/api/v1', '') }),
      HOME: home,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls, 1);
});

test('a rejected CLI session is not refreshed from private credential files', async () => {
  const home = freshHome();
  let calls = 0;
  setHandler(async (_req, res) => {
    calls += 1;
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"expired"}');
  });
  const result = await runCli(['GET', '/health'], {
    env: {
      RB_API_BASE_URL: baseUrl(),
      RB_API_KEY: '',
      RB_CLIENT_ID: '',
      RB_CLIENT_SECRET: '',
      RB_CLI: writeSessionCli(home, { dashboardUrl: baseUrl().replace('/api/v1', '') }),
      HOME: home,
    },
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /rightbrain login --non-interactive/);
  assert.equal(calls, 1);
  assert.equal(existsSync(join(home, '.rightbrain')), false);
});

// ---------------------------------------------------------------------------
// Pagination safety and refreshed credential propagation
// ---------------------------------------------------------------------------

test('--all rejects POST before authentication or network activity', async () => {
  let calls = 0;
  setHandler(async (_req, res) => {
    calls += 1;
    res.writeHead(500).end();
  });
  const result = await runCli(['POST', '/items', '--all'], {
    env: { RB_API_BASE_URL: baseUrl(), HOME: freshHome() },
  });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /only valid with GET/);
  assert.equal(calls, 0);
});

test('--all rejects repeated cursors', async () => {
  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"results":[{"id":1}],"pagination":{"has_next":true,"next_cursor":"same"}}');
  });
  const result = await runCli(['GET', '/items', '--all'], { env: apiKeyEnv() });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /repeated cursor/);
});

test('--all rejects cross-origin next URLs before forwarding credentials', async () => {
  let calls = 0;
  setHandler(async (_req, res) => {
    calls += 1;
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        '{"results":[{"id":1}],"next":"https://attacker.example/collect"}',
      );
  });

  const result = await runCli(['GET', '/items', '--all'], { env: apiKeyEnv() });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /cross-origin next URL/);
  assert.match(result.stderr, /refusing to forward credentials/);
  assert.equal(calls, 1);
});

test('RB_MAX_PAGES is configurable and strictly validated', async () => {
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    const cursor = url.searchParams.get('cursor') || 'first';
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          results: [{ cursor }],
          pagination: { has_next: true, next_cursor: `${cursor}-next` },
        }),
      );
  });

  const capped = await runCli(['GET', '/items', '--all'], {
    env: apiKeyEnv({ RB_MAX_PAGES: '1' }),
  });
  assert.equal(capped.code, 4);
  assert.match(capped.stderr, /exceeded the 1-page safety limit/);
  assert.match(capped.stderr, /set RB_MAX_PAGES/);

  for (const invalid of ['0', '-1', '1.5', '9007199254740992']) {
    const result = await runCli(['GET', '/items', '--all'], {
      env: apiKeyEnv({ RB_MAX_PAGES: invalid }),
    });
    assert.equal(result.code, 4);
    assert.match(result.stderr, /positive safe integer/);
  }
});

test('--all carries refreshed credentials into later pages', async () => {
  const home = freshHome();
  let mintCount = 0;
  const apiTokens = [];
  setHandler(async (req, res) => {
    const url = new URL(req.url, baseUrl());
    if (url.pathname === '/oauth2/token') {
      mintCount += 1;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ access_token: `page-token-${mintCount}`, expires_in: 3600 }));
      return;
    }

    apiTokens.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer page-token-1') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const cursor = url.searchParams.get('cursor');
    const body = cursor
      ? { results: [{ id: 2 }], pagination: { has_next: false } }
      : {
          results: [{ id: 1 }],
          pagination: { has_next: true, next_cursor: 'next-page' },
        };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  const result = await runCli(['GET', '/items', '--all'], {
    env: clientCredentialEnv(home),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).results, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(apiTokens, [
    'Bearer page-token-1',
    'Bearer page-token-2',
    'Bearer page-token-2',
  ]);
});

// ---------------------------------------------------------------------------
// Usage, filesystem, timeout, and direct auth safety
// ---------------------------------------------------------------------------

test('conflicting body and output/SSE flags fail with exit 4', async () => {
  const cases = [
    [['POST', '/items', '--data', '{}', '--form', 'name=x'], /cannot combine --data/],
    [['GET', '/items', '--sse', '--output', '/tmp/out'], /streams to stdout/],
    [['GET', '/items', '--sse', '--compact'], /no effect with --sse/],
    [['GET', '/items', '--sse', '--accept', 'text/plain'], /sets Accept automatically/],
  ];
  for (const [args, pattern] of cases) {
    const result = await runCli(args, {
      env: { RB_API_BASE_URL: baseUrl(), HOME: freshHome() },
    });
    assert.equal(result.code, 4);
    assert.match(result.stderr, pattern);
  }
});

test('missing upload files and unwritable output paths produce actionable exit 4', async () => {
  const missing = '/definitely/missing/upload.bin';
  const uploadResult = await runCli(
    ['POST', '/upload', '--file', `attachment=@${missing}`],
    { env: apiKeyEnv() },
  );
  assert.equal(uploadResult.code, 4);
  assert.match(uploadResult.stderr, /failed to read upload file/);
  assert.doesNotMatch(uploadResult.stderr, /\n\s+at /);

  setHandler(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const outputResult = await runCli(
    ['GET', '/items', '--output', join(freshHome(), 'missing-dir', 'out.json')],
    { env: apiKeyEnv() },
  );
  assert.equal(outputResult.code, 4);
  assert.match(outputResult.stderr, /failed to write output file/);
  assert.doesNotMatch(outputResult.stderr, /\n\s+at /);
});

test('--secret-output writes full JSON once at 0600 while all process output stays redacted', async () => {
  const home = freshHome();
  const outputPath = join(home, 'one-time-secret.json');
  const secret = 'one-time-handoff-secret';
  const response = {
    id: 'key-id-1',
    name: 'Disposable API key',
    oauth_client_id: 'oauth-client-1',
    key: secret,
    nested: { client_secret: 'nested-handoff-secret' },
    token_count: 4,
  };
  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(response));
  });

  const result = await runCli(
    ['GET', '/handoff', '--secret-output', outputPath],
    { env: apiKeyEnv({ HOME: home }) },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
  assert.doesNotMatch(combinedOutput(result), /nested-handoff-secret/);
  assert.match(result.stderr, /unredacted JSON written to new 0600 file/);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 'key-id-1',
    name: 'Disposable API key',
    oauth_client_id: 'oauth-client-1',
    key: '***',
    nested: { client_secret: '***' },
    token_count: 4,
  });
  assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), response);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);

  const second = await runCli(
    ['GET', '/handoff', '--secret-output', outputPath],
    { env: apiKeyEnv({ HOME: home }) },
  );
  assert.equal(second.code, 4);
  assert.match(second.stderr, /refusing to overwrite/);
  assert.doesNotMatch(combinedOutput(second), new RegExp(secret));
  assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), response);
});

test('--secret-output rejects unsafe combinations, errors, binary data, and write failures', async () => {
  const home = freshHome();
  const path = join(home, 'secret.json');
  const cases = [
    ['GET', '/items', '--secret-output', path, '--dry-run'],
    ['GET', '/items', '--secret-output', path, '--sse'],
    ['GET', '/items', '--secret-output', path, '--all'],
    ['GET', '/items', '--secret-output', path, '--output', join(home, 'ordinary.json')],
  ];
  for (const args of cases) {
    const result = await runCli(args, { env: apiKeyEnv({ HOME: home }) });
    assert.equal(result.code, 4);
    assert.match(result.stderr, /--secret-output cannot be combined/);
  }

  const errorSecret = 'error-secret-output-value';
  setHandler(async (_req, res) => {
    res
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ refresh_token: errorSecret }));
  });
  const errorResult = await runCli(
    ['GET', '/failure', '--secret-output', path],
    { env: apiKeyEnv({ HOME: home }) },
  );
  assert.equal(errorResult.code, 5);
  assert.match(errorResult.stderr, /only valid for successful JSON responses/);
  assert.doesNotMatch(combinedOutput(errorResult), new RegExp(errorSecret));
  assert.equal(existsSync(path), false);

  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/octet-stream' })
      .end(Buffer.from([1, 2, 3]));
  });
  const binaryResult = await runCli(
    ['GET', '/binary', '--secret-output', path],
    { env: apiKeyEnv({ HOME: home }) },
  );
  assert.equal(binaryResult.code, 4);
  assert.match(binaryResult.stderr, /requires a successful JSON response/);
  assert.equal(existsSync(path), false);

  const writeSecret = 'write-failure-secret-value';
  setHandler(async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ access_token: writeSecret }));
  });
  const writeResult = await runCli(
    ['GET', '/handoff', '--secret-output', join(home, 'missing', 'secret.json')],
    { env: apiKeyEnv({ HOME: home }) },
  );
  assert.equal(writeResult.code, 4);
  assert.match(writeResult.stderr, /failed to write secret output file/);
  assert.doesNotMatch(combinedOutput(writeResult), new RegExp(writeSecret));
});

test('request timeout exits 4 without a stack trace', async () => {
  setHandler(async (_req, res) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const secret = 'timeout-query-secret';
  const result = await runCli(
    ['GET', '/slow', '--query', `access_token=${secret}`, '--timeout', '25'],
    {
    env: apiKeyEnv(),
    },
  );
  assert.equal(result.code, 4);
  assert.match(result.stderr, /timed out after 25ms/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
});

test('request and auth timeout values reject unsafe timer delays', async () => {
  const requestResult = await runCli(
    ['GET', '/items', '--timeout', '2147483648'],
    { env: apiKeyEnv() },
  );
  assert.equal(requestResult.code, 4);
  assert.match(requestResult.stderr, /between 1 and 2147483647/);

  const authResult = await runCli(['GET', '/items'], {
    env: clientCredentialEnv(freshHome(), { RB_AUTH_TIMEOUT_MS: '2147483648' }),
  });
  assert.equal(authResult.code, 4);
  assert.match(authResult.stderr, /RB_AUTH_TIMEOUT_MS must be between 1 and 2147483647/);
});

test('OAuth mint requests honor RB_AUTH_TIMEOUT_MS', async () => {
  setHandler(async (_req, res) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"access_token":"late-token","expires_in":3600}');
  });
  const mintResult = await runCli(['GET', '/health'], {
    env: clientCredentialEnv(freshHome(), { RB_AUTH_TIMEOUT_MS: '25' }),
  });
  assert.equal(mintResult.code, 4);
  assert.match(mintResult.stderr, /client-credentials request .* timed out after 25ms/);
});

test('malformed API URLs exit 4 without a raw stack trace', async () => {
  const result = await runCli(['GET', '/items'], {
    env: apiKeyEnv({ RB_API_BASE_URL: 'not a valid URL' }),
  });
  assert.equal(result.code, 4);
  assert.match(result.stderr, /Invalid URL/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('direct rb-auth requires explicit status and never prints a live token', async () => {
  const secret = 'direct-auth-secret-token';
  const noCommand = await runScript(AUTH_CLI, [], {
    env: apiKeyEnv({ RB_API_KEY: secret }),
  });
  assert.equal(noCommand.code, 4);
  assert.match(noCommand.stderr, /implicit credential output has been removed/);
  assert.match(noCommand.stderr, /rb-auth\.mjs status/);
  assert.doesNotMatch(combinedOutput(noCommand), new RegExp(secret));

  const raw = await runScript(AUTH_CLI, ['raw'], {
    env: apiKeyEnv({ RB_API_KEY: secret }),
  });
  assert.equal(raw.code, 4);
  assert.match(raw.stderr, /unknown argument "raw"/);
  assert.doesNotMatch(combinedOutput(raw), new RegExp(secret));

  const status = await runScript(AUTH_CLI, ['status'], {
    env: apiKeyEnv({ RB_API_KEY: secret }),
  });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /^api_base_url: http:\/\/127\.0\.0\.1:\d+$/m);
  assert.match(status.stdout, /source: api_key/);
  assert.doesNotMatch(status.stdout, /^env/m);
  assert.doesNotMatch(combinedOutput(status), new RegExp(secret));
});

test('RB_CLI supports executable paths containing spaces', async () => {
  const home = freshHome();
  const fakeCli = join(home, 'rightbrain cli with spaces');
  const secret = 'cli-session-token';
  writeFileSync(
    fakeCli,
    "#!/usr/bin/env node\n" +
      "if (process.argv[2] === '--version') { console.log('0.3.0'); process.exit(0); }\n" +
      `process.stdout.write(JSON.stringify({access_token:${JSON.stringify(
        secret,
      )},dashboard_url:'https://app.rightbrain.ai',org_id:'org-1',project_id:'proj-1'}));\n`,
  );
  chmodSync(fakeCli, 0o700);

  const result = await runScript(AUTH_CLI, ['status'], {
    env: {
      RB_API_BASE_URL: baseUrl(),
      RB_API_KEY: '',
      RB_CLIENT_ID: '',
      RB_CLIENT_SECRET: '',
      RB_CLI: fakeCli,
      RB_ENV: 'custom-session-name',
      HOME: home,
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /api_base_url: https:\/\/app\.rightbrain\.ai\/api\/v1/);
  assert.match(result.stdout, /source: session/);
  assert.doesNotMatch(combinedOutput(result), new RegExp(secret));
});
