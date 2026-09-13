# analyzer spec delta

## ADDED Requirements

### Requirement: FrameworkEntryPointAdapters

The analyzer SHALL provide a staged set of deterministic entry-point adapters — readers of
declarative config formats (stage 1: the root package.json `bin`/`main`/`module`/`exports`, npm
scripts, and `jest` setup files, with build outputs mapped back to their sources; stage 2:
vitest/vite/jest setup files and tsconfig `files`; stage 3: GitHub Actions `run:`-step scripts, reusing
the existing workflow parser) — each producing "externally referenced" liveness evidence that
extends the dead-code roots definition with an `externally-wired` root kind carrying an auditable
adapter receipt (config file and key). An adapter SHALL only ever add evidence of use — removing
false dead-candidates — and SHALL never assert deadness. Unrecognized config shapes, dynamic
references, and unresolvable globs SHALL surface as disclosed boundaries, never as guesses.
Every function in a config-wired file SHALL be a root, because module-scope code has no
call-graph node. Framework route conventions and workspace-member manifests are explicitly deferred
and disclosed as remaining boundaries.
Downstream conclusions SHALL consume the evidence: coverage-gap labels distinguish a config-wired
untested entry point (`untested-not-dead`) from unreachable code (`also-dead`), and the
entry-points digest distinguishes "config-wired" from "true orphan".

#### Scenario: A bin-wired CLI entry is not a dead-code candidate

- **GIVEN** a repository whose package.json `bin` names `src/cli/index.ts`, which no internal
  code imports
- **WHEN** `find_dead_code` runs
- **THEN** the CLI entry is excluded from candidate-dead as an `externally-wired` root, and the
  output carries the receipt naming package.json and the `bin` key

#### Scenario: Adapters never assert deadness

- **GIVEN** a file referenced by no config format and no import
- **WHEN** the adapters run
- **THEN** they contribute no evidence about it, and it remains a candidate under the existing
  conservative roots doctrine — its confidence and caveats unchanged by this feature

#### Scenario: An unrecognized config shape is a disclosed boundary

- **GIVEN** an npm script invoking a file through a variable (`node $SCRIPT`)
- **WHEN** the package.json adapter parses it
- **THEN** no root is added and the result discloses the unresolvable reference as a boundary,
  never guessing a target

#### Scenario: A config-wired untested entry point labels honestly

- **GIVEN** a workflow-run script no test reaches
- **WHEN** `report_coverage_gaps` runs with the adapters active
- **THEN** the gap is labeled `untested-not-dead` with the adapter receipt, not `also-dead`
