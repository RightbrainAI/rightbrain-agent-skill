# Contributing

This repository is the official Rightbrain
[Agent Skill](https://agentskills.io): a `SKILL.md` package with scripts and
harness distribution metadata.

## Development setup

Node.js 18 and newer are supported and tested in CI; an active LTS release
(20+) is recommended. There are zero npm dependencies and no install step.

```bash
git clone https://github.com/RightbrainAI/rightbrain-agent-skill.git
cd rightbrain-agent-skill

node --check plugins/rightbrain/skills/rightbrain/scripts/rb-api.mjs
node --check plugins/rightbrain/skills/rightbrain/scripts/rb-auth.mjs
node --test test/*.test.mjs
```

The unit tests use in-process mock servers and require no Rightbrain credential.

When documenting bundled scripts, either use an absolute `RB_SKILL_DIR`:

```bash
export RB_SKILL_DIR="/absolute/path/to/rightbrain"
node "$RB_SKILL_DIR/scripts/rb-api.mjs" whoami
```

or explicitly state that the reader has changed to the skill root. Never assume
an installed harness starts there.

## Documentation boundary

Do not copy API reference prose or schemas into this repository. Concepts and
endpoint contracts belong in
[`llms.txt`](https://docs.rightbrain.ai/v-1/llms.txt), the linked Markdown
pages, and the canonical
[OpenAPI document](https://app.rightbrain.ai/api/v1/openapi.json). This
repository should contain only wrapper behavior, safety guidance, authentication
details, and instructions specific to using the skill.

## Documentation changes

- Require Rightbrain CLI 0.3.0 or newer and use `rightbrain@latest` in install
  commands.
- Do not add static endpoint walkthroughs or API drift automation. The skill
  must resolve current contracts from live docs at execution time.
- Do not add commands that delete credentials, modify shell startup files, or
  change repository configuration without clearly explaining and obtaining
  user consent.
- Never include real credentials, tenant names, IDs, or customer payloads.
- Check every relative Markdown link.

## Tests

Tests live under `test/` and use
Node's built-in `node:test`. Always run every `*.test.mjs` file with the glob
shown above. Spawn the wrapper asynchronously with piped stdio; synchronous
child execution can deadlock the in-process mock server.

Add coverage for observable behavior, especially credential precedence,
redaction, exact-path routing, explicit scopes, retries, pagination, multipart,
and streaming.
Response-safety tests must distinguish structured JSON key redaction and
confirmed one-time-secret `--secret-output <new-path>` enforcement from
arbitrary unstructured model/tool/error text, which is not promised to be
sanitized.

## Releases

`plugins/rightbrain/.claude-plugin/plugin.json` is the one canonical version
source. Do not duplicate it in `.claude-plugin/marketplace.json`; Claude derives
the marketplace plugin version from the manifest.

For a release:

1. Keep changes under `Unreleased` while work is uncommitted.
2. Choose semver and move entries to `X.Y.Z - YYYY-MM-DD`.
3. Set the chosen version in `plugin.json`.
4. Commit the release.
5. Create immutable signed tag `vX.Y.Z` from that commit and publish matching
   release notes.

Never document a tag or release as existing before the release commit exists.
User-visible changes require changelog entries. Breaking changes require a
major bump; additive features use minor; compatible fixes use patch.

## Commit messages and pull requests

Use imperative conventional subjects:

```text
feat: add agent workflow
fix: preserve wrapper exit status
docs: clarify headless authentication
ci: test Node 24
```

Pull requests should state the user-facing behavior, tests run, canonical docs
used, and any security/data-flow effect. Report vulnerabilities according to
[SECURITY.md](SECURITY.md).
