# mcp-quality spec delta

## ADDED Requirements

### Requirement: RemediationFirstGovernanceFindings

A governance finding MAY carry an optional `remediation`: a source-declared, deterministic,
per-code template registered alongside the code's default class and description, instantiated
with the finding's `subject`. Remediation text SHALL be a static template with subject
interpolation — no LLM, no inference — and a code without a declared template SHALL render
exactly as today: a remediation is never invented. Every finding renderer (agent-hook, git hook,
review output) SHALL print the remediation first when present, so the message tells the consuming
agent what to do, not only what is wrong.

#### Scenario: A registered template yields an actionable finding

- **GIVEN** a finding code whose registry entry declares the template
  "Layer violation: {subject}; route through the declared interface layer"
- **WHEN** a finding with subject `billing → db` fires
- **THEN** the finding carries the instantiated remediation and renderers print it before the
  descriptive message

#### Scenario: No template means no invented advice

- **GIVEN** a finding code with no declared remediation template
- **WHEN** a finding with that code fires
- **THEN** the finding carries no `remediation` field and renders exactly as before this change

#### Scenario: Remediation is deterministic

- **GIVEN** the same finding fired twice on the same subject
- **WHEN** the remediation is instantiated
- **THEN** the two remediation strings are byte-identical
