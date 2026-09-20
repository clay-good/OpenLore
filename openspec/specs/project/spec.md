# Project Specification

> Source files: src/core/services/project-detector.ts

## Purpose

Detects the project type of an analyzed repository (Node.js/TypeScript, Python, Rust, Go, Java,
Ruby, PHP, or unknown) and maps each type key to its human-readable display name. Used to tailor
onboarding and language-aware defaults.

## Entities

### ProjectType

Represents the human-readable name of a project type.

**Properties:**

| Name | Type | Description |
|------|------|-------------|
| typeKey | string | The internal key representing the project type (e.g., 'nodejs', 'python'). |
| displayName | string | The human-readable name of the project type (e.g., 'Node.js/TypeScript', 'Python'). |

## Requirements

### Requirement: ProjectTypeValidation

The system SHALL validate ProjectType according to these rules:
- typeKey must be one of: 'nodejs', 'python', 'rust', 'go', 'java', 'ruby', 'php', 'unknown'
- displayName must be a non-empty string

#### Scenario: GetDisplayNameForNode.jsProjectType
- **GIVEN** The project type key is 'nodejs'
- **WHEN** getProjectTypeName is called with 'nodejs'
- **THEN** The display name is 'Node.js/TypeScript'

#### Scenario: GetDisplayNameForPythonProjectType
- **GIVEN** The project type key is 'python'
- **WHEN** getProjectTypeName is called with 'python'
- **THEN** The display name is 'Python'

#### Scenario: GetDisplayNameForUnknownProjectType
- **GIVEN** The project type key is 'unknown'
- **WHEN** getProjectTypeName is called with 'unknown'
- **THEN** The display name is 'Unknown'

### Requirement: TestSuiteHasNoKnownTimeBombs

The test suite SHALL contain no known deprecation warnings scheduled to become errors (a warning
of that class fails CI when introduced) and no known-flaky test left unfixed: a test observed to
fail intermittently under load SHALL be made deterministic (event-driven assertions or serial
isolation) with the fix verified by repeated full-suite runs, not quarantined indefinitely.

#### Scenario: A future vitest upgrade cannot flip green to red

- **GIVEN** the suite passing on the current vitest
- **WHEN** vitest promotes the vi.mock hoisting warning to an error
- **THEN** the suite still passes because no test triggers the warning

#### Scenario: A flake is fixed, not tolerated

- **GIVEN** a test that fails intermittently under full-suite load
- **WHEN** the fix lands
- **THEN** the PR records a repeated-run verification demonstrating determinism

### Requirement: BenchmarkHarnessIsReproducibleAndDeterministicallyScored

The project SHALL maintain a checked-in benchmark harness for preset-vs-preset comparison whose
runs are reproducible and deterministically scored: task environments pinned by repository SHA
and container image digest, the agent configuration recorded in the results artifact, and all
scores derived from independent oracles plus post-hoc metrics (tool-selection accuracy, step
counts, token cost) computed deterministically from logged transcripts — the model under test is
the subject of measurement, never a scorer. Task corpora SHALL declare expected tools and
plausible distractors by tool id, and corpus validation SHALL fail loudly when a referenced tool
id no longer exists. Benchmark runs SHALL be manual or scheduled, never part of per-commit CI;
the deterministic sub-benchmarks SHALL remain runnable without agent credentials at no cost.

#### Scenario: A logged run scores identically everywhere

- **GIVEN** a logged benchmark transcript from a completed run
- **WHEN** the post-hoc metrics are recomputed on a different machine
- **THEN** every score (selection accuracy, steps, token cost) is identical
- **AND** no scoring step invokes a model

#### Scenario: Corpus rot fails loudly

- **GIVEN** a corpus task declaring a distractor tool id that was removed from the surface
- **WHEN** corpus validation runs
- **THEN** validation fails naming the stale tool id, before any paid run starts

#### Scenario: Per-commit CI is unaffected

- **GIVEN** the benchmark harness is checked in
- **WHEN** a commit lands
- **THEN** CI runs only the existing test suite; no benchmark executes per-commit

### Requirement: PerformanceBudgetsAreCounterBasedAndDeterministic

The project SHALL guard against performance regressions with counter-based budgets — counts of
deterministic work units (files parsed, queries compiled, node-table loads, adjacency
rebuilds, type inferences, SQL statements, bytes written) on a pinned fixture — asserted in
CI-visible tests, not wall-clock timings. Budgets over deterministic counters SHALL be exact;
a change that legitimately raises a budget SHALL update its recorded baseline in the same
change with the measured delta stated.

#### Scenario: A reintroduced redundant pass fails CI

- **GIVEN** the counter-based budget suite on the pinned fixture
- **WHEN** a change reintroduces a redundant corpus parse pass or a per-call full-graph rebuild
- **THEN** a budget assertion fails, rather than the regression landing silently

#### Scenario: Budgets are deterministic, not flaky

- **GIVEN** the budget suite run repeatedly on the same fixture
- **WHEN** the same analysis and serving work is measured again
- **THEN** the measured counts are identical across runs (no wall-clock dependence), so the
  budgets can be exact

## Technical Notes

- **Implementation**: `src/core/services/project-detector.ts`, `bench/Dockerfile`,
  `bench/container-entrypoint.sh`,
  `bench/container/package.json`, `bench/container/package-lock.json`, `bench/run.ts`,
  `scripts/bench-agent.ts`, `src/bench/container-launch.ts`, `src/bench/pinned-repository.ts`,
  `src/bench/preregistered-rule.ts`, `src/bench/protocol-verdict.ts`, `src/bench/result-path.ts`,
  `src/bench/fixtures/trajectory.txt`, `src/core/analyzer/perf-counters.ts`,
  `src/core/analyzer/parse-budget.ts`, `src/core/analyzer/json-stream.ts`,
  `src/core/services/edge-store.ts`, `src/core/services/mcp-handlers/graph.ts`,
  and `src/core/decisions/atomic-store.ts`.
