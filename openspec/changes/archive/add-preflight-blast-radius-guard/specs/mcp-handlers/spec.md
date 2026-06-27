# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PreflightStructuralBriefing

The system SHALL provide a pre-flight capability that, given a staged or working diff, returns a
deterministic conclusion-shaped briefing of the change's structural blast radius: affected callers and
layers crossed, the tests to run, the anchored memories and decisions the diff will turn `drifted` or
`orphaned`, the specs it will make stale, and (under federation) the cross-repo consumers of any
changed published interface. The briefing SHALL compose existing deterministic analyses only, with no
LLM and no new structural computation, and SHALL be a briefing (counts and named risks), never a graph.

#### Scenario: A hub change is briefed before commit

- **GIVEN** a working diff that modifies a function with many callers and an anchored decision
- **WHEN** the pre-flight briefing is requested
- **THEN** it reports the caller count and layers, the tests to run, and that the anchored decision
  will drift — as a single conclusion-shaped briefing

### Requirement: AdvisoryByDefault

The pre-flight guard SHALL be non-blocking by default: surfaced on demand or via an advisory git hook
that does not fail a commit. A repository MAY opt into blocking for specific high-risk patterns (for
example, orphaning an anchored decision) via configuration, but blocking SHALL never be the default
posture.

#### Scenario: Default hook is advisory

- **GIVEN** the pre-flight git hook installed with default configuration
- **WHEN** a commit is made for a high-blast-radius diff
- **THEN** the briefing is emitted and the commit is not blocked

#### Scenario: Opt-in blocking fires only on its pattern

- **GIVEN** a repository configured to block when a commit orphans an anchored decision
- **WHEN** a commit would orphan an anchored decision
- **THEN** the hook blocks; and for any other high-blast-radius diff it remains advisory
