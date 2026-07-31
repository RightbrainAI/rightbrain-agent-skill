# Rightbrain Agent Skill

[![Tests](https://github.com/RightbrainAI/rightbrain-agent-skill/actions/workflows/test.yml/badge.svg)](https://github.com/RightbrainAI/rightbrain-agent-skill/actions/workflows/test.yml)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-standard-blue.svg)](https://agentskills.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

An Agent Skill for safely building and operating
[Rightbrain](https://rightbrain.ai) Tasks, TaskAgents, knowledge, tools, and
automations.

The skill reads Rightbrain's live documentation and OpenAPI contract at
execution time. It does not bundle an API reference or require API-spec syncs.

## How it works

- **Rightbrain CLI** owns interactive login and session refresh.
- **`rb-api.mjs`** gives agents one safe interface for every API operation,
  including scoping, pagination, streaming, uploads, dry runs, and secret
  redaction.
- **Live docs** provide the current endpoint contract:
  [`llms.txt`](https://docs.rightbrain.ai/v-1/llms.txt),
  [Docs MCP](https://docs.rightbrain.ai/v-1/_mcp/server), and
  [OpenAPI](https://app.rightbrain.ai/api/v1/openapi.json).

## Quick start

1. [Install the skill](INSTALL.md).
2. Install and authenticate the CLI:

```bash
npm install --global rightbrain@latest
rightbrain login --non-interactive
```

3. Ask your agent to use the Rightbrain skill.

The skill verifies the selected organization, project, and production API host
before making changes. Headless environments may use secret-managed API keys or
OAuth client credentials instead of an interactive session.

## Safety

Writes show their target and effect first. Deletion, public sharing, credentials,
permissions, automation, external writes, and potentially expensive runs require
explicit confirmation.

Never paste secrets into prompts, command arguments, issues, or logs. Structured
responses redact known secret fields; arbitrary model and tool output cannot be
guaranteed secret-free. See [SECURITY.md](SECURITY.md).

## Development

```bash
node --test test/*.test.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and
[LICENSE](LICENSE).
