# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ChangeVerificationReceiptIsComposedAndActionable

The opt-in `verify_change` tool SHALL grade the working-tree diff against a base and return one
advisory receipt composed from existing checks: `blast_radius` (with tests to run and spec drift),
`structural_diff` (with check weakening), the generated-file guard, phantom references, and request
bodies. Each item SHALL name its subject, check, severity, and next action. Items SHALL be sorted by
severity and capped, with the omitted count stated.

#### Scenario: A change gets one ordered list

- **GIVEN** a diff that removes a called function, adds a call into a deprecated function, and
  touches code a requirement links to
- **WHEN** `verify_change` runs
- **THEN** the receipt lists the removed function first, the spec drift next, and the deprecated
  call last, each with its subject, check, severity, and next action, and it names the tests to run

#### Scenario: The receipt is capped, not a dump

- **GIVEN** a diff whose checks produce more items than the cap
- **WHEN** the receipt is built
- **THEN** it keeps the highest-severity items and states the number omitted

#### Scenario: A base that does not resolve is disclosed

- **GIVEN** a `baseRef` that git cannot resolve
- **WHEN** `verify_change` runs
- **THEN** the receipt is graded against the fallback base that `blast_radius` resolves, and a
  boundary names both the requested and the resolved base

#### Scenario: A failed check is a boundary, not a clean result

- **GIVEN** `structural_diff` fails for the diff
- **WHEN** `verify_change` runs
- **THEN** the receipt carries the other checks' items and a boundary that names the failure, and if
  `blast_radius` itself fails the tool returns an error instead of a receipt

#### Scenario: Policy classifies, the default is advisory

- **GIVEN** no `enforcement.policy` in the repository
- **WHEN** `verify_change` returns findings
- **THEN** `gated` is false and nothing blocks

#### Scenario: It grades, it does not author

- **WHEN** `verify_change` returns
- **THEN** it has run no tests and changed no file

### Requirement: VerificationReceiptCoversEveryDiffCheck

`verify_change` SHALL also report, each with proof: breaking exports with their consumers
(`certify_public_surface`), contract breaks and parity verdicts (`certify_service_contract`), env
keys the diff stops reading that an IaC site still sets, new architecture-rule violations,
`secret-added`, and `cycle-introduced`. Each `nextAction` SHALL state a fact, not an order, and the
receipt SHALL carry a `schemaVersion` field.

#### Scenario: Only a new violation is reported

- **GIVEN** the rule "core must not import cli", one violation at the base, and a diff that adds a
  second one
- **WHEN** `verify_change` runs
- **THEN** the receipt lists only the violation the diff added

#### Scenario: A pasted key is flagged without being repeated

- **GIVEN** a diff that adds a line with an API key that matches a credential pattern
- **WHEN** `verify_change` runs
- **THEN** a registered advisory `secret-added` finding names the file, line, and pattern class, and
  no output contains the key

#### Scenario: Only a new import cycle is reported

- **GIVEN** a base where `a.ts` imports `b.ts`, and a diff that makes `b.ts` import `a.ts`
- **WHEN** `verify_change` runs
- **THEN** a registered advisory `cycle-introduced` finding names `a.ts` → `b.ts` → `a.ts`, and
  cycles present at the base are not reported

### Requirement: SpeculativePatchIsGradedInMemory

`verify_change` SHALL accept an optional `patch` (a unified diff over working-tree files), apply it
in memory, and return the receipt it would return had the edit been written, marked
`speculative: true` with the patched files. It SHALL NOT write any file or keep the patched graph. A
hunk that does not apply, a path outside the include patterns, or a patch over the file cap SHALL
fail with the reason.

#### Scenario: A proposed edit is graded before it is written

- **GIVEN** a patch that removes a function two other functions call
- **WHEN** `verify_change` runs with that patch
- **THEN** the receipt names the removed function, is marked `speculative: true`, and the working
  tree is byte-identical before and after the call

#### Scenario: A patch that does not apply is not graded

- **GIVEN** a patch whose second hunk does not match the current file
- **WHEN** `verify_change` runs with that patch
- **THEN** the verification fails naming the file and the hunk, and returns no items
