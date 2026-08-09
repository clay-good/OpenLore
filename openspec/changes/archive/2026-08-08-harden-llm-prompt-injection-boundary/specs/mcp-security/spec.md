# mcp-security spec delta

## ADDED Requirements

### Requirement: LlmDerivedTextIsUntrustedUntilHumanApproval

Free-text fields produced by an LLM (proposed requirement text, decision title/rationale,
drift suggestion reason) and LLM-supplied supersession targets SHALL be treated as
untrusted until a human approves them. A supersession SHALL be applied only when its target
id is already known to the decision store; LLM-authored text written toward a durable
trusted surface (spec requirements, the commit-gate approval prompt) SHALL be marked as
LLM-extracted so a reviewer approves content, not a rubber stamp.

#### Scenario: An injected supersession does not retire a real decision

- **GIVEN** an LLM consolidation output whose `supersededIds` names a genuine existing
  decision the diff wanted retired
- **WHEN** consolidation applies supersessions
- **THEN** the supersession is applied only through the known-id path and the injected
  target does not silently retire the real decision

#### Scenario: A spec requirement carries its LLM provenance to the approver

- **GIVEN** a proposed requirement extracted by the LLM from a diff
- **WHEN** the commit gate presents it for approval
- **THEN** it is marked as LLM-extracted from a diff, so the human approves the content
  deliberately
