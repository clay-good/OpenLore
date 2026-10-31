# Tasks — add-phantom-reference-findings

## Implementation
- [ ] Added-reference extraction over the diff (and over `verify_change`'s in-memory `patch`):
      imports, named imports, member accesses on imported internal modules
- [ ] Internal resolution against the index via the existing import resolver (tsconfig `paths`,
      workspace aliases); unresolvable alias → disclosed boundary
- [ ] Manifests: extend `external-packages.ts` (`package.json`, `pyproject.toml`, `requirements*.txt`,
      `go.mod`, `Cargo.toml`); workspaces via `workspace-shards.ts`; new lockfile readers: npm, pnpm,
      yarn, poetry/uv, `go.sum`, `Cargo.lock`
- [ ] Per-language stdlib/builtin allow lists (closed)
- [ ] Codes `unresolved-internal-import`, `unresolved-internal-symbol`, `undeclared-dependency`,
      `unpinned-dependency` registered (advisory); exact-prefix candidates (≤3) for internal misses
- [ ] `verify_change` projection; `not-assessed` per file for unsupported languages

## Verification
- [ ] Invented internal export → `unresolved-internal-symbol` with candidates; real export → nothing
- [ ] `import x from 'left-padx'` with no manifest entry → `undeclared-dependency`; `node:fs` → nothing
- [ ] Manifest entry added without a lockfile update → `unpinned-dependency`
- [ ] Same results through a speculative `patch` as through the written diff
- [ ] No network access in any path (test runs with network disabled)
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD AddedReferencesResolveOrAreReported
