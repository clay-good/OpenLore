# openspec spec delta

## ADDED Requirements

### Requirement: SyncedDecisionRequirementsAreSchemaValid

Every requirement block the decision syncer writes into a main spec SHALL be valid against the
OpenSpec requirement schema at the moment it is written: a `### Requirement:` heading, a
normative statement containing SHALL or MUST with a coherent subject (no blind prefixing that
produces a double modal), and at least one `#### Scenario:` block. A cross-domain reference SHALL
be emitted as a normative deferral to the canonical decision plus a pointer scenario, never as a
bare prose stub. The syncer SHALL verify its own emitted block against these rules and fail the
sync with a named error rather than persist an invalid spec. The `> Decision recorded: <id>`
dedupe key SHALL be preserved so previously synced requirements are never rewritten.

#### Scenario: A synced decision produces a valid requirement

- **GIVEN** an approved decision with a proposed requirement phrased "The orient command SHALL …"
- **WHEN** `openlore decisions --sync` writes it into the owning domain spec
- **THEN** the emitted block passes `openspec validate` for that spec: no double "The system
  SHALL The orient command SHALL" prefix, and at least one scenario is present

#### Scenario: A cross-domain reference is a valid deferral

- **GIVEN** a decision whose canonical statement lives in another domain
- **WHEN** the syncer writes the cross-reference into a non-owning domain
- **THEN** the block contains the normative deferral sentence naming the decision id and owning
  domain, plus a pointer scenario, and passes validation

#### Scenario: An invalid emission never persists

- **GIVEN** a decision whose proposed requirement cannot be rendered into a valid block
- **WHEN** the syncer's self-check fails
- **THEN** the target spec file is left unchanged and the sync reports a named error for that
  decision
