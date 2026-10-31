# openspec spec delta

## ADDED Requirements

### Requirement: ProposalIntentPreservesUserDecisions

When an OpenSpec `propose` workflow is invoked through a supported OpenLore agent integration, the
agent SHALL derive a concise brief containing the user's requested outcome, explicitly accepted
decisions, constraints, and unresolved questions. Questions, exploration, and assistant suggestions
SHALL NOT be treated as accepted requirements without user assent.

#### Scenario: A short propose prompt follows a clear request

- **GIVEN** the conversation contains a concrete user request and accepted constraints
- **WHEN** the user invokes the OpenSpec `propose` workflow with a short prompt such as “propose it”
- **THEN** the agent summarizes the request, accepted decisions, constraints, and open questions
- **AND** preserves the request, accepted constraints, and unresolved questions in its brief

#### Scenario: Alternatives remain unresolved

- **GIVEN** the conversation has discussed multiple approaches without explicit user selection
- **WHEN** the agent prepares an OpenSpec proposal
- **THEN** it records the alternatives as unresolved questions or options
- **AND** it does not present any option as a user-approved decision

### Requirement: ProposalOrientationPrecedesAuthoring

When the conversation contains an actionable user request, the agent SHALL call OpenLore `orient()`
with the proposal brief before authoring proposal artifacts. Structural evidence SHALL inform the
proposal's repository scope and impact, but SHALL NOT decide unresolved product questions or
override explicit user constraints. If orientation is unavailable, the agent SHALL disclose that
limitation and may proceed from the conversation brief.

#### Scenario: A short propose prompt follows a clear request

- **GIVEN** the conversation contains a concrete user request and accepted constraints
- **WHEN** the user invokes the OpenSpec `propose` workflow with a short prompt such as “propose it”
- **THEN** the agent calls `orient()` with the brief before authoring proposal artifacts
- **AND** uses the returned structural evidence to describe affected repository areas

#### Scenario: Structural orientation is unavailable

- **GIVEN** the request is actionable but the repository has no usable OpenLore analysis index
- **WHEN** the agent prepares the proposal
- **THEN** it proceeds from the conversation brief without structural evidence
- **AND** discloses that orientation was unavailable

### Requirement: ProposalWithoutActionableRequestRequiresClarification

When the conversation contains only exploration, questions, or unaccepted suggestions, the agent
SHALL ask a focused clarification and SHALL NOT create OpenSpec proposal artifacts until an
actionable user request is established.

#### Scenario: Explore is followed by propose without a concrete request

- **GIVEN** the conversation contains only exploration, questions, or unaccepted suggestions
- **WHEN** the user invokes the OpenSpec `propose` workflow
- **THEN** the agent asks a focused clarification
- **AND** does not create proposal artifacts until an actionable request is established

### Requirement: ProposalPreparationIsScopedToProposeInvocation

OpenLore SHALL apply proposal-specific preparation only when an OpenSpec `propose` workflow is
invoked through a supported integration. Other prompts SHALL retain their existing handling.

#### Scenario: A non-proposal prompt is submitted

- **GIVEN** the user has not invoked an OpenSpec `propose` workflow
- **WHEN** a prompt is submitted through a supported OpenLore integration
- **THEN** proposal-specific preparation does not block or alter that prompt's handling
