# mcp-handlers spec delta

## ADDED Requirements

### Requirement: BackgroundConsolidationFailsClosed

A background process spawned by a long-lived MCP handler (e.g. the decision consolidator fired by
`record_decision`) SHALL never be able to crash the host server: every spawn SHALL register an
error listener, and a spawn failure (ENOENT, EACCES, or any pre-exec error) SHALL be contained and
reported. The tool response SHALL reflect the actual spawn outcome — a handler SHALL NOT claim
background work is running when the spawn failed; a failed spawn SHALL be disclosed together with
the manual recovery command. Concurrent spawn requests SHALL be coalesced against the existing
consolidation lock (reused as the in-flight sentinel — no new locking mechanism): while a run is
in flight no additional consolidator is spawned, and the response discloses that the work was
coalesced. The primary write (the recorded decision) SHALL commit independently of the background
spawn's outcome.

#### Scenario: The consolidator binary is missing

- **GIVEN** an environment where binary resolution falls through to a bare `openlore` that is not
  on PATH
- **WHEN** `record_decision` fires the background consolidation and the spawn emits ENOENT
- **THEN** the MCP server process survives (no uncaught exception)
- **AND** the decision itself is recorded and its id returned
- **AND** the response states consolidation could not be started and names
  `openlore decisions --consolidate` as the recovery step, instead of claiming it is running

#### Scenario: A successful spawn is reported as started

- **GIVEN** a resolvable consolidator binary
- **WHEN** `record_decision` fires the background consolidation and the child emits `spawn`
- **THEN** the response reports consolidation running in the background, as today

#### Scenario: Rapid records coalesce onto one consolidator

- **GIVEN** a consolidation run already in flight (its lock held)
- **WHEN** a second `record_decision` arrives before the run completes
- **THEN** no second consolidator process is spawned
- **AND** the response disclosed that consolidation was coalesced onto the in-flight run

### Requirement: DecisionStatusPromotionIsCasChecked

Every mutation of a decision's status SHALL be committed through the compare-and-swap store update
(`updateDecisionStore`) and verified after commit, following the patch-then-verify shape of
`approve_decision`/`reject_decision`. No handler SHALL promote a decision's status on a
locally-loaded copy of the store and act on that copy outside the CAS path. A promotion whose
post-commit verification shows the decision was concurrently removed or changed SHALL return an
honest error rather than a false success, and SHALL never clobber decisions recorded concurrently.

#### Scenario: sync_decisions promotes an id under CAS

- **GIVEN** a draft decision and a `sync_decisions` call naming its id
- **WHEN** the handler promotes the decision to `approved` before syncing
- **THEN** the promotion is committed via `updateDecisionStore` and re-verified on the committed
  store, not applied to a locally-loaded copy

#### Scenario: A concurrent draft survives a sync

- **GIVEN** a `sync_decisions` call in progress and a `record_decision` committing a new draft
  concurrently
- **WHEN** both operations complete
- **THEN** the new draft is present in the store (the CAS merge re-applied it)
- **AND** the synced decision's status reflects the sync

#### Scenario: A concurrently-removed decision yields an honest error

- **GIVEN** a decision removed between load and promotion
- **WHEN** the promotion's post-commit verification runs
- **THEN** the handler returns an error naming the id, not a success claiming it was synced
