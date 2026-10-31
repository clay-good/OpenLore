# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ChangeVerificationReceiptIsComposedAndActionable

The system SHALL provide an opt-in `verify_change` conclusion tool that, given a working-tree or
staged diff against a base resolved through `resolveBaseRefDisclosed`, composes the existing
deterministic verification conclusions over the diff's changed and reachable symbols and returns
ONE receipt. Each receipt item SHALL name the symbol or file, the check that produced it, a
severity, and a single next action, and items SHALL be ordered by severity and budgeted with a
disclosed truncation count — never a raw dump. The receipt SHALL carry a versioned, documented
schema so a harness, hook, or agent can consume it mechanically. The tool SHALL perform no new
graph analysis and invent no new finding codes: it assembles the answers of its component
conclusions (`blast_radius`, `select_tests`, `check_spec_drift`, `certify_public_surface`,
`structural_diff`) and SHALL cross-reference them as its siblings. It SHALL be advisory by default,
gateable through `enforcement.policy` on the finding codes its components already register, and a
bad base SHALL be fatal to the verification rather than silently verified against a fallback.

#### Scenario: A change gets one ordered next-action list

- **GIVEN** a diff that narrows a public export, adds a call into a deprecated symbol, and leaves
  one requirement's implementation drifted
- **WHEN** `verify_change` runs against the merge-base
- **THEN** the receipt lists the surface break first (with the affected consumers), then the spec
  drift, then the advisory deprecated-call, each with its symbol, producing check, and next action,
  and names the `select_tests` set to re-run

#### Scenario: The receipt is bounded, not a dump

- **GIVEN** a large diff whose composed findings exceed the response budget
- **WHEN** the receipt is assembled
- **THEN** it returns the highest-severity items within budget and discloses the count omitted,
  never silently dropping a higher severity for a lower one

#### Scenario: A bad base is fatal, not fallback

- **GIVEN** a `--base` ref that cannot be resolved
- **WHEN** `verify_change` runs
- **THEN** it fails the verification with the disclosed reason rather than verifying against a
  silently substituted base

#### Scenario: It grades, it does not author

- **GIVEN** the receipt names a set of tests to re-run and a surface break to fix
- **WHEN** the tool returns
- **THEN** it has neither run the tests nor modified any file — the next actions are for the
  harness or agent to perform

### Requirement: SpeculativePatchIsGradedInMemory

`verify_change` SHALL accept an optional `patch` (a unified diff over files in the working tree)
and, when given, SHALL apply it in memory to the current file contents, build the patched graph
over that in-memory file set while reusing the hash-keyed Pass-1 fact cache, and return the same
receipt it would return had the edit been written to disk, marked `speculative: true` with the
list of patched files. The tool SHALL NOT write, create, or delete any file in the working tree or
persist the patched graph. A patch MAY create new files within the analyzed corpus's include
patterns. A hunk that does not apply cleanly, a patch that touches a path outside those patterns,
or a patch over the patched-file cap SHALL fail the verification with the reason, never return a
partial grade.

#### Scenario: A proposed edit is graded before it is written

- **GIVEN** a cached index and a patch that removes a function two other functions call
- **WHEN** `verify_change` runs with that patch
- **THEN** the receipt names the removed function and its two callers, is marked
  `speculative: true`, and the working tree is byte-identical before and after the call

#### Scenario: A patch that does not apply is not graded

- **GIVEN** a patch whose second hunk's context does not match the current file
- **WHEN** `verify_change` runs with that patch
- **THEN** the verification fails naming the file and the hunk, and no receipt items are returned

### Requirement: DiffScopedRuleAndSecretFindings

`verify_change` SHALL include architecture-rule violations from `check_architecture` only when the
diff adds the violating import or call edge, so violations present at the base are not reported.
It SHALL also apply the existing credential patterns to the diff's added lines and report each match
as a registered advisory `secret-added` finding naming the file, line, and pattern class, without
echoing the matched value.

It SHALL report each file-level dependency cycle present after the change but not at the base as a
registered advisory `cycle-introduced` finding that names the files of the cycle in order.

#### Scenario: Only a new violation is reported

- **GIVEN** a declared rule "core must not import cli", one existing violation at the base, and a
  diff that adds a second one
- **WHEN** `verify_change` runs
- **THEN** the receipt lists only the violation the diff added

#### Scenario: A pasted key is flagged without being repeated

- **GIVEN** a diff that adds a line containing an API key matching a credential pattern
- **WHEN** `verify_change` runs
- **THEN** a `secret-added` finding names the file and line, and no output contains the key

#### Scenario: A new import cycle is named

- **GIVEN** a base where `a.ts` imports `b.ts`, and a speculative patch that makes `b.ts` import
  `a.ts`
- **WHEN** `verify_change` runs with the patch
- **THEN** a `cycle-introduced` finding names `a.ts` → `b.ts` → `a.ts`, and cycles present at the base
  are not reported
