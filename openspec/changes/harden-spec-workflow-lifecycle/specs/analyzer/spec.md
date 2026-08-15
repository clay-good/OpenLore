## ADDED Requirements

### Requirement: Repository-Scoped Analysis Single Flight

Only one full analysis SHALL own a repository at a time. Ownership SHALL be represented by an inspectable runtime lock containing the canonical repository identity, PID, start time, last heartbeat, current stage, and progress. A concurrent invocation SHALL report `ANALYSIS_IN_PROGRESS` with that metadata and SHALL either exit without starting duplicate work or attach in wait mode.

A lock MAY be reclaimed only when its owner is no longer alive and its heartbeat is stale. Runtime lock/progress state SHALL remain outside deterministic analysis evidence.

#### Scenario: Concurrent analyze does not duplicate work
- **GIVEN** a live full analysis owns the repository lock
- **WHEN** another full analysis starts for the same canonical repository
- **THEN** the second invocation performs no analysis, reports the owner and elapsed duration, and offers an attach/wait path

#### Scenario: Waiting invocation follows progress
- **GIVEN** a live analysis and a second invocation using wait mode
- **WHEN** the owner advances stages and completes
- **THEN** the waiting invocation receives periodic progress and returns the owner analysis result without starting another analysis

#### Scenario: Dead stale owner is recoverable
- **GIVEN** a lock whose PID is not alive and whose heartbeat exceeds the stale threshold
- **WHEN** a new analysis starts
- **THEN** it discloses and reclaims the stale lock before becoming the sole owner

### Requirement: Atomic Analysis Generation Publication

A completed full analysis SHALL publish one generation identity and a manifest binding every required artifact to that identity and content digest. Writers SHALL hold the analysis lock across the complete required artifact write set and manifest commit point. Readers SHALL validate the manifest before and after multi-artifact reads. An interrupted in-place generation MUST fail closed as `analysis-changed`; it MUST NOT serve either a mixed snapshot or overwritten artifacts under the prior identity.

#### Scenario: Reader never accepts mixed generations
- **GIVEN** one analysis generation is current while a new generation is being written
- **WHEN** an MCP request reads multiple artifacts
- **THEN** it observes a complete verified generation or a typed `analysis-changed` response, never a mixture

#### Scenario: Interrupted analysis fails closed
- **GIVEN** a valid current analysis and a replacement analysis that terminates before publication
- **WHEN** a reader requests evidence
- **THEN** digest validation rejects the overwritten artifact set as `analysis-changed` until a complete generation is published

### Requirement: Long Analysis Phases Emit Heartbeats

Every long-running analysis stage, including artifact generation, SHALL update observable progress at a bounded interval even when its exact completion percentage is unchanged. Preflight/status consumers SHALL distinguish `FRESH`, `STALE`, `MISSING`, and `ANALYSIS_IN_PROGRESS`.

#### Scenario: Artifact generation remains visibly alive
- **GIVEN** artifact generation takes longer than the heartbeat interval without completing a sub-step
- **WHEN** a user observes CLI or attached progress
- **THEN** periodic heartbeat messages include stage and elapsed duration until completion or failure

#### Scenario: Preflight reports active analysis
- **GIVEN** an analysis lock with a live owner and current heartbeat
- **WHEN** preflight/status is requested
- **THEN** it reports `ANALYSIS_IN_PROGRESS` and owner metadata rather than `STALE` or `FRESH`
