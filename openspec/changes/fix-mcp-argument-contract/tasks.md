# Tasks — fix-mcp-argument-contract

## Implementation

- [ ] Resolve omitted `directory` to the server launch root (captured once at startup) before
      validation in the CallTool handler; explicit value always wins; same
      `validateDirectory` path for both. Watch the `--watch-auto` bootstrap: it keys off the
      first call's directory — the resolved default must feed it too
- [ ] Mark `directory` optional in `TOOL_DEFINITIONS` schemas with the default documented in
      the description; keep serve-daemon delegation passing the resolved (absolute) value
- [ ] Strict validation in `validateToolArgs`: reject unknown top-level properties; reuse the
      config-schema validator's did-you-mean helper for the suggestion
- [ ] Missing-property errors: include property name, type, and a concrete example (the
      resolved launch root for `directory`-like cases)
- [ ] Tests: omitted directory resolves to launch root (and equals explicit-root behavior);
      invalid launch root → example-bearing error; `remember` with `anchor:` → rejected, no
      persistence; audit existing tests that rely on loose validation

## Verification

- [ ] E2E stdio probe: `orient {task}` with no directory succeeds from an install-wired
      server; `remember` with a mis-named property is rejected with a did-you-mean
