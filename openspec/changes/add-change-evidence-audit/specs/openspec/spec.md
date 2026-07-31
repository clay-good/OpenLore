# openspec spec delta

## ADDED Requirements

### Requirement: ChangeEvidenceAuditDelegatesLifecycle

The change evidence audit SHALL delegate validation and all lifecycle actions to the `openspec`
CLI: a change's `validates` signal comes from invoking `openspec validate`, never from a
reimplementation, and the audit SHALL never archive a change — an `archivable-candidate` label
(verdict built and validates) is a report, not an action. Requirement-presence matching SHALL
use the corpus's own key — requirement name within the target domain — so identical names in
different domains never cross-match.

#### Scenario: Validation is delegated

- **GIVEN** a change whose delta violates the spec schema
- **WHEN** the audit computes its signals
- **THEN** the `validates` signal reflects the `openspec validate` result, and no OpenLore-side
  validation reimplementation is consulted

#### Scenario: Archivable is a label, not an action

- **GIVEN** a change with verdict `built` that passes validation
- **WHEN** the audit reports it
- **THEN** it is labeled `archivable-candidate` and the changes directory is unmodified
