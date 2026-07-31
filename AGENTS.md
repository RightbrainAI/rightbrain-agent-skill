# Repository guidance

This is the official, harness-neutral Rightbrain Agent Skill.

## Architecture

```text
SKILL.md → scripts/rb-api.mjs → scripts/rb-auth.mjs → Rightbrain API
```

- `rb-api.mjs` is the universal agent request layer. Keep arbitrary methods,
  pagination, SSE, multipart, dry runs, response redaction, and stable exit
  codes.
- `rb-auth.mjs` supports API keys, OAuth client credentials, and Rightbrain CLI
  sessions. The CLI owns all interactive session storage and refresh behavior;
  never parse or modify its credential files.
- Paths are exact by default. Agents use the current canonical path from live
  docs; optional `--project-scope` and `--org-scope` only prepend selected IDs.
- Endpoint contracts belong to live Rightbrain docs and OpenAPI. Never commit
  generated API references, snapshots, operation lists, or sync workflows.

## Invariants

1. Node.js 18+ and zero npm dependencies for the installed wrapper.
2. Tokens and secrets never reach stdout, stderr, dry-run output, tests, or
   documentation.
3. Interactive sessions require Rightbrain CLI 0.3.0+ on `PATH`; headless
   credentials come only from environment variables.
4. Client-credential caches are atomic, mode `0600`, under a mode `0700`
   directory, and isolated by client/API/OAuth/audience identity.
5. A credential may only be retried against the same API origin.
6. The public skill targets production. Development overrides exist for tests
   and internal use but must not appear in public guidance.
7. `SKILL.md` stays concise and resolves contracts live.

## Validation

```bash
node --check plugins/rightbrain/skills/rightbrain/scripts/rb-api.mjs
node --check plugins/rightbrain/skills/rightbrain/scripts/rb-auth.mjs
node --test test/*.test.mjs
```

Use the official `skills-ref` validator for `SKILL.md`. Tests use local mock
servers and must not require Rightbrain credentials.

## Releases

- `plugins/rightbrain/.claude-plugin/plugin.json` is the only machine-readable
  version source.
- Record user-visible changes in `CHANGELOG.md`.
- Public releases use immutable `vX.Y.Z` tags.
- Keep conventional commit prefixes (`feat:`, `fix:`, `docs:`, `ci:`,
  `refactor:`, `chore:`).
