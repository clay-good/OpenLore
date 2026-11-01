# Tasks — add-phantom-reference-findings

## Implementation
- [x] Added-reference extraction over the diff: imports and named imports, compared base-to-head by
      specifier and bound names. Member accesses on a namespace import are NOT extracted (the import
      parser records none); stated as a limit in the proposal and the docs.
- [x] Internal resolution against the working tree via the existing import resolver, so a file the
      same diff adds resolves; a path alias (`@/x`, `~/x`, `#x`, tsconfig/jsconfig `paths`) →
      disclosed boundary
- [x] Manifests: `external-packages.ts` refactored to pure content parsers and widened
      (`optionalDependencies`, Cargo build/workspace sections); every manifest from the file's
      directory to the root is read; workspace package names and Go module paths treated as internal
- [x] New lockfile readers: npm (v1/v2/v3), pnpm (packages + v9 snapshots), yarn (classic + berry),
      poetry/uv/pdm/Cargo (TOML), `Pipfile.lock`, `go.sum`
- [x] Per-language stdlib/builtin allow lists (closed): Node's own `builtinModules`, CPython module
      names, and Go's own module-path rule
- [x] Codes `unresolved-internal-import`, `unresolved-internal-symbol`, `undeclared-dependency`,
      `unpinned-dependency` registered (advisory); prefix candidates (≤3) for internal misses
- [x] `verify_change` projection with a next action per code; `blast_radius` `phantomReferences`
      field, headline part, and a shared hook so the check runs once; `not-assessed` per file

## Verification
- [x] Invented internal export → `unresolved-internal-symbol` with candidates; real export → nothing
- [x] `import x from 'left-padx'` with no manifest entry → `undeclared-dependency`; `node:fs` → nothing
- [x] Manifest entry added without a lockfile update → `unpinned-dependency`
- [x] An export added by the same diff resolves (exports read from current content, not the index)
- [x] No network access in any path (asserted with `fetch` replaced by a throwing stub)
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD AddedReferencesResolveOrAreReported, UnjudgeableReferencesAreDisclosed,
      ExportsAreReadFromCurrentContent
