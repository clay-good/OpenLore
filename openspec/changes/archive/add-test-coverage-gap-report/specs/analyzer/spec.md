# analyzer spec delta

## ADDED Requirements

### Requirement: StructuralCoverageGapComputation

The system SHALL compute, deterministically and without executing any test, the set of functions that
are in the backward-reachable set of no test node — i.e. no test transitively calls them — as the
inverse of the existing test-selection reachability run once over the whole indexed graph. This
computation SHALL require no test execution, no coverage instrumentation, and no working runtime, and
SHALL be a pure function of the indexed graph. The result SHALL exclude test files themselves, generated
code, and vendored code. A gap that is ALSO unreachable from any liveness root SHALL carry an explicit
also-dead marker, while an untested-but-live gap (e.g. a framework-invoked entry point) SHALL NOT carry
it; the two SHALL never be conflated, so this conclusion stays separate from `find_dead_code` (whose
domain is the dead subset). The seeds for test-reachability SHALL be every test node together with the
production side of every `tested_by` association, so a function a test imports/asserts on without
directly calling it is still counted as reachable-from-a-test.

#### Scenario: A function reached by no test is a coverage gap

- **GIVEN** a function that no test transitively calls
- **WHEN** the structural coverage gap is computed
- **THEN** the function is in the untested set, and a function that some test does transitively reach is
  not

#### Scenario: An untested entry point is reported as untested, not dead

- **GIVEN** a framework-invoked handler with no in-repo caller and no reaching test
- **WHEN** the coverage gap is computed
- **THEN** it is reported in the untested set WITHOUT the also-dead marker (it is a live root), while a
  gap that is unreachable from any liveness root DOES carry the also-dead marker — the two are never
  conflated

### Requirement: CoverageGapRankingAndSoundnessContract

The untested set SHALL be ranked using existing significance classifiers — `hub` (high fan-in) and
`chokepoint` (betweenness) — ordered by label tier then raw fan-in, with no composite score and no new
tuning constant; each reported symbol SHALL carry its labels and raw evidence. The report SHALL make only
the sound claim that a symbol with no reaching test has a coverage gap, and SHALL NOT claim that a symbol
with a reaching test is "tested" or "covered" — structural reachability from a test means the test can
reach the code, not that it verifies the code's behavior. The report SHALL disclose this limitation
explicitly.

#### Scenario: An untested hub outranks untested leaves

- **GIVEN** an untested high-fan-in function and several untested trivial leaf functions
- **WHEN** the coverage gap report is ranked
- **THEN** the untested hub ranks above the leaves, carrying its fan-in evidence, so the most
  load-bearing gap surfaces first

#### Scenario: The report never asserts a symbol is tested

- **GIVEN** a symbol that is reachable from a test but whose behavior the test does not assert
- **WHEN** the report is produced
- **THEN** the symbol is simply absent from the untested set, and the report makes no claim that it is
  tested or covered, disclosing that reachable-from-a-test is not behavior-verified
