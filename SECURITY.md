# Security policy

## Supported versions

Security fixes are provided for the latest released minor line. Reports against
`main` are also accepted.

## Scope

This policy covers executable code, distribution metadata, workflows, and
documentation in `rightbrain-agent-skill`, including the auth resolver and API
wrapper. Platform/API/dashboard vulnerabilities should be reported to the same
security address but may be triaged in the relevant private repository.

## Report privately

Do not open a public issue. Email **security@rightbrain.ai** or create a
[private GitHub security advisory](https://github.com/RightbrainAI/rightbrain-agent-skill/security/advisories/new).
Include:

- affected version, tag, or commit;
- minimal reproduction and impact;
- harness/OS/Node version where relevant;
- redacted logs only—never send a live token or customer payload.

We aim to acknowledge a report within three business days and provide a triage
update within seven business days. Resolution time depends on severity and
coordination needs. We will coordinate disclosure and credit with the reporter.

## Credential handling

Credential precedence is `RB_API_KEY`, then client credentials, then the stored
interactive session.

- Interactive sessions are created, stored, validated, and refreshed only by
  Rightbrain CLI 0.3.0 or newer.
- Client-credentials minting caches a short-lived token in
  `~/.rightbrain/cc-token-<identity-hash>.json` (glob:
  `cc-token-*.json`). Different client/OAuth/API/audience identities are
  isolated, so multiple caches may coexist. Do not use blanket deletion.
- The wrapper writes its client-credential cache under a mode-`0700`
  `~/.rightbrain` directory. Cache files are mode `0600` and replaced atomically.
- `whoami`, `status`, and redacted `--dry-run` output do not expose bearer
  tokens. The wrapper never prints a token-bearing `curl` command.
- Structured JSON responses are key-redacted by default. Confirmed
  one-time-secret handoff requires `--secret-output <new-path>`; it writes the
  unredacted successful JSON once to a new mode-`0600` file while stdout stays
  redacted and refuses overwrite/unsafe combinations. Never read that file into
  an agent transcript. Key-based redaction does not sanitize arbitrary
  unstructured model, tool, or error text.

Installation alone does not create Rightbrain credentials. Login and the first
client-credentials request write local state; users should run them only with
consent and protect runner homes according to their policy.

A path that exposes a token through output, errors, dry runs, or crash handling
is in scope and should be reported privately.

## Data flow and telemetry

- Prompts, API bodies, uploaded files, and other wrapper payloads are sent to
  Rightbrain. Platform/server logging is separate from this skill and is
  governed by Rightbrain's service policies.
- Configured model providers, integrations, MCP servers, forwarders, or
  webhooks may receive relevant data. Users must review those destinations.
- The skill and wrapper implement no independent analytics or telemetry.
- Host harnesses and installers have their own behavior. Claude Code can emit
  plugin/skill attribution in configured OpenTelemetry, and package managers or
  Git hosts receive ordinary fetch/install metadata. Consult the harness's
  policy before installation.

Do not place secrets in prompts, command arguments, committed files, issues, or
logs. Use a CI secret manager to populate environment variables.

## Out of scope

- Reading protected local credentials after the operating system account is
  already compromised.
- Documentation-only inaccuracies without a confidentiality, integrity, or
  availability impact; report those as normal issues.
- Vulnerabilities solely in third-party harnesses, package managers, model
  providers, or integrations. Report them to the responsible vendor, while
  notifying Rightbrain if this skill materially amplifies the impact.
