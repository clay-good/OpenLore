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
