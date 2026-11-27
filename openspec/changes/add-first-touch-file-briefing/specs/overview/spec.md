# overview spec delta

## MODIFIED Requirements

### Requirement: NorthStarIsADeterministicStructuralContextSubstrateForCodingAgents

The system SHALL provide deterministic, locally-computed structural context as a substrate for coding agents, grounding all capabilities in static analysis rather than LLM inference.

The system SHALL deliver that context to the agent as evidence at five moments: when a prompt is
submitted, at the first touch of a file in a session, before an edit, after an edit, and before
the agent stops. Every pushed fact SHALL be exact or SHALL say it is not assessed and why. Every
finding SHALL carry proof (a file and line, a graph edge, or a receipt) and SHALL lead to one of
three actions: the agent fixes it; the agent decides and records the decision with a link to the
proof; or, only when the evidence warrants it, the agent raises it to a human in its own final
message or pull-request body. The system SHALL stay quiet unless a finding is new and real.

> Decision recorded: c6d1ad07, refined by 35c3f807 (ADR-0038)
> Date: 2026-11-27

#### Scenario: Capabilities are grounded in static analysis

- **WHEN** any capability serves structural context to an agent
- **THEN** the answer is computed deterministically and locally from static analysis, with no LLM in the retrieval or guardrail path

#### Scenario: A finding carries proof and one action

- **WHEN** a moment gives the agent a finding
- **THEN** the finding names its proof and exactly one of the actions fix, decide, or raise

#### Scenario: Nothing new means nothing said

- **WHEN** a moment runs and no finding is new and real
- **THEN** the system gives the agent no finding

#### Scenario: The first touch of a file is a moment

- **WHEN** the agent reads a file for the first time in a session
- **THEN** the system may push evidence about that file, and says nothing when it has none
