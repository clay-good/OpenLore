# mcp-quality spec delta

## ADDED Requirements

### Requirement: TrustEvidenceIsConclusionShaped

Grounding certificates, the `verified-current` marker, and budgeted tiers SHALL be conclusion-shaped
fields attached to existing `recall` / `orient` responses — never a node-and-edge graph for the agent
to traverse, and never a new tool added to the minimal or first-run default surface. The trust-economy
capability SHALL ride existing tool outputs and optional parameters, preserving the flat default
surface required by the minimize-tool-surface rule.

#### Scenario: No new default tool is introduced

- **GIVEN** `openlore mcp` started with no flag (or `--minimal`)
- **WHEN** the active tool set is selected
- **THEN** no new tool is registered for the trust-economy capability; it is delivered via existing
  `recall` / `orient` response fields and optional parameters

### Requirement: NoSilentTruncationUnderBudget

When a token budget truncates a response, the system SHALL report what was withheld (a count, and the
tier or category dropped). A bounded response SHALL NOT read as a complete one. This preserves the
honesty contract: a caller can always tell the difference between "this is everything" and "this is
everything that fit."

#### Scenario: Budget truncation is disclosed

- **GIVEN** a budgeted response whose tail was dropped to fit the budget
- **WHEN** the response is produced
- **THEN** it explicitly reports the withheld count and which tier/category was truncated
