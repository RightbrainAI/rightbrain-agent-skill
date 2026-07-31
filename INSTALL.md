# Install the Rightbrain skill

## Requirements

- Node.js 18 or newer for the wrapper
- Node.js 22 or newer and Rightbrain CLI 0.3.0+ on `PATH` for session
  authentication
- Network access to Rightbrain's production API and documentation
- Git and a POSIX shell for the portable install commands

Install and authenticate the current CLI:

```bash
npm install --global rightbrain@latest
rightbrain login --non-interactive
```

The CLI prints a browser URL and waits for a loopback callback. Headless
environments should use secret-managed `RB_API_KEY`, or `RB_CLIENT_ID` and
`RB_CLIENT_SECRET`. API keys also require `RB_ORG_ID` and `RB_PROJECT_ID`.

## Claude Code

```bash
claude plugin marketplace add \
  https://github.com/RightbrainAI/rightbrain-agent-skill.git
claude plugin install rightbrain@rightbrain-agent-skill
```

Reload plugins, then run `/rightbrain:rightbrain` or ask Claude to use
Rightbrain.

## Cursor, Codex, and compatible Agent Skills clients

Copy the skill into the standard project directory:

```bash
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 \
  https://github.com/RightbrainAI/rightbrain-agent-skill.git "$tmp/source"
mkdir -p .agents/skills
cp -R "$tmp/source/plugins/rightbrain/skills/rightbrain" .agents/skills/rightbrain
```

Use `~/.agents/skills/rightbrain` instead for a personal installation. Restart
the client if it does not discover the new skill.

Claude's manual skill directory is `.claude/skills/rightbrain` (project) or
`~/.claude/skills/rightbrain` (personal).

## Verify

Ask the client to activate the Rightbrain skill and run its `whoami` check. It
must report:

```text
api_base_url: https://app.rightbrain.ai/api/v1
```

## Update or remove

To update a manual installation, review this repository's changelog and replace
only the installed `rightbrain` skill directory with a fresh copy. Pin an
immutable release tag instead of `main` in automated environments.

To remove it, delete only the installed `rightbrain` directory. Claude plugin
users can run:

```bash
claude plugin uninstall rightbrain@rightbrain-agent-skill
```
