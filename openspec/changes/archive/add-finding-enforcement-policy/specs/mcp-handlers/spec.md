# mcp-handlers spec delta

## ADDED Requirements

### Requirement: GovernanceFindingsCarryStableCodeAndIntrinsicSeverity

Every governance finding source (the decisions gate, the pre-flight blast-radius guard, the change impact
certificate, and the stale-decision-reference check below) SHALL emit each finding carrying a stable,
documented `code` and an intrinsic `severity`. The `code` SHALL be stable across releases so a declared
`enforcement.policy` can name it; the `severity` SHALL be owned by the emitting source and SHALL NOT be
overridden by the enforcement policy. Findings SHALL be shaped so a single enforcement-class resolver can
govern findings from all sources uniformly.

#### Scenario: A finding exposes the fields the policy needs

- **GIVEN** any governance finding emitted by any source
- **WHEN** the finding is inspected
- **THEN** it carries a stable `code` and an intrinsic `severity`, sufficient for the enforcement-class
  resolver to classify it without consulting the source

#### Scenario: Existing per-surface block sugar maps onto the unified policy

- **GIVEN** a repository that previously expressed opt-in blocking through a per-surface `block: [...]`
  config
- **WHEN** the unified enforcement policy resolves that surface's finding codes
- **THEN** the resolved classes match the prior `block: [...]` intent, so the per-surface sugar is a thin
  equivalent of, and is superseded by, the unified policy

### Requirement: StaleDecisionReferenceFinding

The system SHALL deterministically detect when a *live, authoritative* artifact references a decision
that has been **superseded** or otherwise retired, and SHALL emit it as a finding with the stable code
`stale-decision-reference`. A live, authoritative artifact is an approved decision, a non-orphaned
anchored memory, or a spec requirement that names the retired decision. The finding SHALL name both the
referencing artifact and the retired target decision, and SHALL report the superseding decision when one
exists. The supersession edge that performed the retirement SHALL be exempt — a decision that supersedes
another is expected to reference the retired one and SHALL NOT itself produce this finding. The detection
SHALL be a pure walk of the decision graph and anchored references, with no LLM.

#### Scenario: A live decision still cites a superseded decision

- **GIVEN** decision A (approved) whose rationale references decision B, and decision B has since been
  superseded by decision C
- **WHEN** the stale-decision-reference check runs
- **THEN** it emits one `stale-decision-reference` finding naming A as the referencing artifact, B as the
  retired target, and C as the superseding decision

#### Scenario: The superseding decision is not flagged for its own supersedes edge

- **GIVEN** decision C whose `supersedes` field points at the retired decision B
- **WHEN** the stale-decision-reference check runs
- **THEN** C's `supersedes` reference to B produces no finding

#### Scenario: A reference to a live decision is clean

- **GIVEN** an anchored memory that references decision C, which is approved and not retired
- **WHEN** the stale-decision-reference check runs
- **THEN** no `stale-decision-reference` finding is emitted for that reference

#### Scenario: An orphaned memory is not treated as authoritative

- **GIVEN** an anchored memory whose anchor symbol no longer exists (orphaned), which references a
  superseded decision
- **WHEN** the stale-decision-reference check runs
- **THEN** no `stale-decision-reference` finding is emitted, because an orphaned memory is not served as
  authoritative

### Requirement: StaleDecisionReferenceSurfacedThroughExistingTools

The `stale-decision-reference` finding SHALL be surfaced through existing surfaces without adding a new
MCP tool: `recall` SHALL flag, in its freshness verdict, when a returned authoritative memory references
a retired decision; `verify_claim` SHALL treat a claim resting on a retired decision as not authoritative
in its receipt; and the finding SHALL be contributed to the gate so it can be governed by the enforcement
policy. The finding SHALL NOT be served as a silent pass.

#### Scenario: Recall flags an authoritative memory resting on a retired decision

- **GIVEN** an authoritative anchored memory that references a superseded decision
- **WHEN** `recall` returns that memory
- **THEN** its freshness verdict carries the `stale-decision-reference` signal naming the retired target,
  rather than presenting the memory as cleanly fresh
