# Spec Delta

## ADDED Requirements

### Requirement: OneShotOrientSelfBootstraps

A one-shot `openlore orient` invocation (`--task`, `--inject`, or the no-task primer) that finds the
analysis index absent or stale SHALL start one detached background build and SHALL return without
waiting for it. The build SHALL follow `AutoInitIsConsentGuarded`, SHALL be at-most-once per
repository across processes, and SHALL be fail-soft. The not-ready conclusion SHALL say that a build
is running, or name the reason that none started.

#### Scenario: First orient in a fresh worktree builds the index

- **GIVEN** a git worktree with no `.openlore/analysis` and no opt-out
- **WHEN** `openlore orient --json --task "<task>"` runs
- **THEN** it starts one detached build, returns a not-ready conclusion that says a build is
  running, and exits 0 without waiting
- **AND** a later invocation, after the build completes, returns a real orientation

#### Scenario: Concurrent hook calls start one build

- **GIVEN** a repository with no index
- **WHEN** several one-shot orient invocations run at the same time
- **THEN** exactly one build process runs

#### Scenario: A stale index is refreshed and still served

- **GIVEN** an index whose cited files changed after the last analyze
- **WHEN** a one-shot orient runs
- **THEN** it serves the existing orientation with its staleness disclosure and starts one
  background rebuild

#### Scenario: An opted-out repository is left alone

- **GIVEN** a repository with `autoInit: false`, or `OPENLORE_NO_AUTO_ANALYZE` set
- **WHEN** a one-shot orient finds no index
- **THEN** no build starts and the conclusion names the opt-out and the manual command

## MODIFIED Requirements

### Requirement: OneShotOrientCarriesTheSameStalenessDisclosure

The one-shot CLI read paths that install wires as agent hooks — `orient --json --task` and
`orient --inject` — SHALL perform the same cited-file freshness check as the MCP handlers and
carry the same staleness disclosure: in `--json` output as a payload field, in `--inject` output
as a single factual line inside the injection block (within the token budget). Configured
injection budgets below the 68-token mandatory-frame floor SHALL be clamped to that floor. The check SHALL
never block, never wait on analysis from the hook (it MAY start the detached build that
`OneShotOrientSelfBootstraps` specifies), and never write to stdout outside the
JSON/injection block.

#### Scenario: A hook-driven orientation after an unindexed edit discloses staleness

- **GIVEN** a repository where a function was added to `src/payments.ts` after the last analyze
- **WHEN** the `UserPromptSubmit` hook runs `orient --inject` with a prompt matching that file
- **THEN** the emitted block includes a staleness line naming `src/payments.ts`, stdout contains
  only the block, and the hook exits 0
