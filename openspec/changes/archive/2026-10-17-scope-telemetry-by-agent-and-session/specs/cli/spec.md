## ADDED Requirements

### Requirement: TelemetryEventsCarryAgentAndSessionIdentity

Every emitted telemetry event SHALL carry the emitting agent's name and version and a session id that is stable for the emitting process and distinct across processes. Identity SHALL be stamped at emit time, not inferred at read time.

Emission SHALL remain non-throwing and SHALL keep redacting secrets; a missing or unknown agent name SHALL be recorded as `unknown` rather than omitted.

#### Scenario: Two agents in one checkout stay distinguishable

- **GIVEN** two agent processes emitting into the same repository
- **WHEN** their events are written
- **THEN** each event carries its own agent identity and session id, and no event of one process carries the other's

#### Scenario: Telemetry failure still cannot break the hot path

- **GIVEN** an identity source that throws
- **WHEN** an event is emitted
- **THEN** the event is written with `unknown` identity or dropped silently, and the caller is unaffected

### Requirement: TelemetryAggregatesAreAgentScoped

The telemetry report SHALL compute call, error, cache, and behavioral aggregates per agent, and SHALL present an explicit cross-agent total distinct from any single agent's figures. An `--agent` filter SHALL restrict the report to one agent. Events without identity SHALL be reported under `unknown` and SHALL NOT be merged into a named agent.

The report SHALL state the agents and session count observed.

#### Scenario: A tool another agent called is not attributed to mine

- **GIVEN** a telemetry file containing calls from two agents
- **WHEN** the report is produced for one of them
- **THEN** only that agent's calls appear in its aggregates, and the other agent's tools are absent from them

#### Scenario: Legacy events are attributable to nobody

- **GIVEN** events written before identity stamping
- **WHEN** the report is produced
- **THEN** those events appear under `unknown` and are excluded from every named agent's figures

### Requirement: IntervalMetricsAreSessionBounded

A metric measured between two events — including stale-warning to orientation latency and recovery latency — SHALL pair events only within one session of one agent. A candidate pair spanning two sessions or two agents SHALL be excluded from the metric, never averaged into it.

The report SHALL state how many sessions contributed to each interval metric and how many candidate pairs were excluded, so a small or empty sample is visible rather than silently averaged.

#### Scenario: Cross-session pairs do not inflate a latency

- **GIVEN** a stale warning in one session and an orientation two hours later in another session
- **WHEN** the stale-to-orient latency is computed
- **THEN** the pair is excluded and the exclusion is counted in the report

#### Scenario: Legacy events form one declared bucket

- **GIVEN** events written before identity stamping, carrying no session id
- **WHEN** an interval metric is computed
- **THEN** they are treated as a single implicit session under `unknown`, never paired with an identified event, and the report states that this bucket's internal boundaries are unknown

#### Scenario: An empty sample is disclosed

- **GIVEN** no session containing both event kinds
- **WHEN** the metric is computed
- **THEN** the report states that the metric has no qualifying pair, rather than showing a value derived from cross-session events
