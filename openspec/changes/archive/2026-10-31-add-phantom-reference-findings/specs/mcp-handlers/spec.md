# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AddedReferencesResolveOrAreReported

For each import and named import a diff adds, `verify_change` SHALL resolve the reference against
the working tree, the target module's current exports, and the manifests in scope, and SHALL report
each miss as a registered advisory finding: `unresolved-internal-import`,
`unresolved-internal-symbol`, `undeclared-dependency`, or `unpinned-dependency`. The check SHALL
make no network request.

- **Implementation**: `checkPhantomReferences::src/core/services/phantom-references.ts`

#### Scenario: An invented internal export is reported with the names the target has

- **GIVEN** a diff that imports `formatDate` from a module exporting only `formatTime` and
  `formatDuration`
- **WHEN** `verify_change` runs
- **THEN** an `unresolved-internal-symbol` finding names the import with its file and line, and
  offers at most three names from the target that share a prefix with it

#### Scenario: An undeclared external package is reported and the standard library is not

- **GIVEN** a diff that adds `import pad from 'left-padx'`, which no manifest in scope declares, and
  `import { readFile } from 'node:fs'`
- **WHEN** `verify_change` runs
- **THEN** an `undeclared-dependency` finding names `left-padx`, and the `node:fs` import yields no
  finding

#### Scenario: A declared dependency the lockfile does not pin is reported

- **GIVEN** a diff that adds a dependency to a manifest and imports it, while the lockfile beside
  that manifest does not pin it
- **WHEN** `verify_change` runs
- **THEN** an `unpinned-dependency` finding names the package and the lockfile

### Requirement: UnjudgeableReferencesAreDisclosed

The reference check SHALL NOT present a reference it cannot judge as resolving: each such reference
SHALL be disclosed with its reason, and the number of references checked SHALL be reported.

- **Implementation**: `checkPhantomReferences::src/core/services/phantom-references.ts`

#### Scenario: Each kind of unjudgeable reference is disclosed

- **GIVEN** a diff with a path alias, a target that re-exports from an unfollowable module, an
  ecosystem with no manifest in scope, an unparseable manifest or lockfile, and a dynamic import
  with a computed specifier
- **WHEN** `verify_change` runs
- **THEN** each is disclosed with its reason and none is reported as a finding

#### Scenario: An unreadable language is not called clean

- **GIVEN** a diff that changes a file in a language whose imports the check cannot read
- **WHEN** `verify_change` runs
- **THEN** the file is listed as not assessed with that reason, and no finding is reported for it

#### Scenario: A path alias is disclosed rather than reported

- **GIVEN** a diff that adds an import matching a `tsconfig` `paths` pattern
- **WHEN** `verify_change` runs
- **THEN** no finding is reported and the skipped alias is disclosed

### Requirement: ExportsAreReadFromCurrentContent

The reference check SHALL resolve a named import against the target module's current content, not
against the index, so that an export added by the same diff resolves; and it SHALL follow a
re-exporting module to the module that exports the name.

- **Implementation**: `exportsOf::src/core/services/phantom-references.ts`

#### Scenario: An export added by the same diff resolves

- **GIVEN** a diff that adds `export function brandNew()` to a module and imports `brandNew` from it
- **WHEN** `verify_change` runs
- **THEN** no `unresolved-internal-symbol` finding is reported
