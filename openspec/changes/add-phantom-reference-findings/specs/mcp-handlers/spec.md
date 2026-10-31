# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AddedReferencesResolveOrAreReported

For each import, named import, or member access on an imported internal module that a diff (or a
speculative `patch`) adds, `verify_change` SHALL resolve the reference against the index and the
manifests in scope, and SHALL report each miss as a registered advisory finding:
`unresolved-internal-import`, `unresolved-internal-symbol`, `undeclared-dependency`, or
`unpinned-dependency`. Internal misses SHALL carry at most three exact-prefix candidates from the
index. Standard-library modules SHALL be excluded by a closed per-language list. The check SHALL
make no network request. A file in a language without import support, an alias the resolver cannot
resolve, and a non-literal dynamic import SHALL each be disclosed, never reported as resolved.

#### Scenario: An invented internal export is reported before it is written

- **GIVEN** a speculative patch that imports `formatDate` from `packages/utils`, which exports only
  `formatTime` and `formatDuration`
- **WHEN** `verify_change` runs with the patch
- **THEN** an `unresolved-internal-symbol` finding names the import with its file and line, and no
  file is written

#### Scenario: An undeclared external package is reported

- **GIVEN** a diff that adds `import pad from 'left-padx'` and no manifest in scope declares it
- **WHEN** `verify_change` runs
- **THEN** an `undeclared-dependency` finding names the specifier, and a `node:fs` import in the same
  diff yields no finding

#### Scenario: Unsupported languages are not called clean

- **GIVEN** a diff in a language without import support
- **WHEN** `verify_change` runs
- **THEN** the file is listed as `not-assessed` for reference resolution
