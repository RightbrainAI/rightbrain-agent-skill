# Changelog

## 2.0.0 - 2026-07-31

First public release.

- Resolve API contracts at execution time through Rightbrain Docs MCP,
  `llms.txt`, and OpenAPI instead of bundling generated references.
- Delegate interactive session storage and refresh entirely to Rightbrain CLI
  0.3.0 or newer.
- Provide one dependency-free wrapper for exact-path API requests, explicit
  project/organization scoping, pagination, streaming, uploads, dry runs, and
  secret-safe output.
- Support secret-managed API keys and OAuth client credentials for headless
  environments.
- Distribute as an Agent Skills standard package and Claude Code plugin.
