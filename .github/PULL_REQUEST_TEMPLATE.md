## Summary

<!-- What does this change, and why? -->

## How tested

<!-- The test suite must pass locally: -->

```bash
node --test test/*.test.mjs
```

<!-- Note any manual verification (e.g. against a real org/project) in addition to the suite. -->

## Checklist

- [ ] Unit tests pass
- [ ] No tokens, API keys, or real request/response payloads in the diff, commit history, or test fixtures
- [ ] API methods, paths, and request fields were checked against canonical Rightbrain docs/OpenAPI
- [ ] No API reference prose or schema was copied into the skill
- [ ] `CHANGELOG.md` updated for any user-facing change
