# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AlwaysSelectTiersWithReasonReceipts

`select_tests`, when selecting from a diff, SHALL union three deterministic, git-derived selection
tiers: (1) tests whose own file changed since the base ref, (2) test files new since the base ref —
including untracked, non-ignored test files that a diff never lists — and (3) tests transitively
reaching a changed symbol (the existing mechanism). A deleted test file SHALL NOT be selected. A test
file the analysis has not yet indexed SHALL be selected whole. A diff that touches only test files
SHALL still select them rather than report that nothing changed. Every selected test SHALL carry a `reason`
receipt naming its strongest tier ("included: new test", then "included: test file itself changed",
then "included: reaches changed symbol at depth N") beside the existing `confidence` field, and SHALL
list any other reason that also selected it. The tiers
SHALL only add selections — a tier SHALL never remove a test the reachability walk selected — and
SHALL be computed locally from the diff already derived for seeding, with no network dependency.

#### Scenario: A changed test file is selected even when unreachable

- **GIVEN** a diff that modifies a test file that reaches no changed production symbol
- **WHEN** `select_tests` runs against that base ref
- **THEN** the test is selected with reason "included: test file itself changed"

#### Scenario: A new test has standing

- **GIVEN** a test file added since the base ref
- **WHEN** `select_tests` runs
- **THEN** the test is selected with reason "included: new test"

#### Scenario: Reachability selections carry their receipt

- **GIVEN** a test selected by the existing backward walk at depth N
- **WHEN** the result is served
- **THEN** it carries "included: reaches changed symbol at depth N" beside its confidence

### Requirement: FlakinessAndStructuralConfidenceDisclosure

A selection whose reaching path traverses synthesized edges SHALL carry a per-test
structural-confidence qualifier naming how many such edges the path crosses and the rules that
produced them, derived from the existing edge-provenance labels (a direct edge for the same pair
takes precedence) — no new scoring constants and no blended score. A directly-resolved selection, and
one selected by an always-select tier, SHALL carry none. The response-level confidence boundary SHALL
be unchanged.

`select_tests` SHALL disclose flakiness as not assessed, and SHALL label no test flaky, while it reads
no test-outcome history. A history reader that labels a test flaky only when runs at identical
tree-hash inputs produced differing outcomes — advisory only, never a selection change — is deferred:
no local history source in the repository records per-test outcomes against a tree hash.

#### Scenario: No history source, no guess

- **GIVEN** a repository with no test-outcome history
- **WHEN** `select_tests` runs
- **THEN** the output discloses that flakiness was not assessed and labels no test flaky

#### Scenario: A heuristic-path selection says so

- **GIVEN** a test whose only reaching path crosses a synthesized dynamic-dispatch edge
- **WHEN** the result is served
- **THEN** that test carries a structural-confidence qualifier naming the heuristic basis, while a
  directly-resolved selection carries none
