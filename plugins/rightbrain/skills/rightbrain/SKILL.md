---
name: rightbrain
description: Builds and operates Rightbrain Tasks, TaskAgents, knowledge, tools, and automations. Use only when the user explicitly asks to work with Rightbrain, the Rightbrain API, rb-api, or a Rightbrain TaskAgent.
license: MIT
compatibility: Requires Node.js 18+, network access, and Rightbrain CLI 0.3.0+ for session authentication.
metadata:
  author: Rightbrain AI
---

# Rightbrain

Turn the user's goal into safe Rightbrain API operations. Live Rightbrain
documentation owns endpoint contracts; this skill owns execution and safety.

## Operating loop

1. Resolve the directory containing this activated `SKILL.md`. Never infer it
   from the process working directory.
2. Run the wrapper's `whoami` command using its quoted absolute path.
3. Confirm the production host, organization, project, target, and intended
   effect before a write.
4. Read the current operation contract from Rightbrain's live documentation.
5. Execute through the wrapper, inspect the response, and report the result.

```bash
node "/absolute/path/to/rightbrain/scripts/rb-api.mjs" whoami
```

For several commands in one shell block:

```bash
RB_API="/absolute/path/to/rightbrain/scripts/rb-api.mjs"
node "$RB_API" whoami
node "$RB_API" METHOD /path [options]
```

Shell variables may not survive later tool calls. Use the literal absolute path
again when needed. Never invoke `rb-auth.mjs` directly, inspect credential
files, or print secrets.

## Authentication and target

This public skill targets:

- API: `https://app.rightbrain.ai/api/v1`
- OAuth: `https://oauth.rightbrain.ai`

`whoami` must report the production API URL before any API operation. Stop if
it reports another host.

Authentication precedence:

1. `RB_API_KEY` with `RB_ORG_ID` and `RB_PROJECT_ID`
2. `RB_CLIENT_ID` with `RB_CLIENT_SECRET`
3. an authenticated Rightbrain CLI session

For a session, require Rightbrain CLI 0.3.0 or newer on `PATH`:

```bash
npm install --global rightbrain@latest
rightbrain login --non-interactive
```

The user must complete the browser flow. Retry `whoami` once, then stop and
surface the error. Headless credentials must come from the caller's secret
manager, never from chat.

If no organization or project is selected, use the live organization and
project list operations, then ask the user to choose when the target is
ambiguous.

## Find the current contract

Stop as soon as the exact operation is clear:

1. Use Rightbrain Docs MCP when available:
   `https://docs.rightbrain.ai/v-1/_mcp/server`.
2. Otherwise open the relevant page from
   `https://docs.rightbrain.ai/v-1/llms.txt`.
3. Use `https://app.rightbrain.ai/api/v1/openapi.json` only when exact method,
   path, parameter, body, or response details remain unclear.

Do not reconstruct request fields from memory. If the live contract is
unavailable, do not guess before a write.

## Execute

```text
node "/absolute/path/to/rightbrain/scripts/rb-api.mjs" METHOD /path [options]
```

Useful options:

- `--query k=v`
- `--data '<json>'`, `--data @file`, or `--data -`
- `--form k=v` and `--file field=@path`
- `--sse` for streams
- `--all` for pagination
- `--accept mime --output path` for files
- `--secret-output <new-path>` for a confirmed one-time secret
- `--project-scope` for a project-relative suffix
- `--org-scope` for an organization-relative suffix
- `--dry-run` for a redacted routing preview
- `--compact` for single-line JSON
- `--timeout <ms>` to bound a slow request

Paths are exact by default. Use the canonical path from live docs and replace
its path parameters with the selected IDs. Use `--project-scope` or
`--org-scope` only when intentionally passing a relative suffix.

For example, call a documented
`/org/{org_id}/project/{project_id}/task` path with its placeholders replaced,
or call `/task --project-scope`.

Exit codes: `0` success, `2` unauthenticated, `3` rejected authentication, `4`
usage/configuration/network error, and `5` API HTTP error. Fix the cause; do not
blindly retry.

## Safety

- Reads may proceed.
- For reversible writes, show the target and proposed change first.
- Ask immediately before deletion, public exposure, sharing, credentials,
  permissions, IAM, trigger enablement, production activation, external writes,
  or potentially expensive runs and evals.
- Prefer private, draft, disabled, disposable, and bounded resources.
- Treat Integrations, MCP tools, triggers, and webhooks as external side
  effects unless proven otherwise.
- Use `--dry-run` for sensitive routing previews, but never include secrets in
  a dry-run body.
- Structured output redacts known secret fields. Write a confirmed one-time
  secret only with `--secret-output <new-path>` and never read that file into
  the conversation.
- Send the minimum required data. Prompts, files, and tool inputs may reach
  configured model providers or third parties.
