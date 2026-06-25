# architecture spec delta

## ADDED Requirements

### Requirement: AnchorCarryForwardAcrossContinuity

When the analyzer's rename/move continuity map pairs `oldSymbol → newSymbol`, the system SHALL carry
forward the code anchors pinned to `oldSymbol` — memories, decisions, and spec links — by re-anchoring
them to `newSymbol`, so durable knowledge survives a benign rename or move instead of orphaning. Each
carried anchor SHALL record provenance (`carriedAcross: { from, to, reason, atCommit }`), making the
move auditable and reversible. After carry-forward, the freshness verdict for such a memory SHALL be
`fresh` when the body is unchanged, or `drifted` when the body changed, annotated as carried — never
`orphaned` solely because the name or file changed. Carry-forward SHALL be additive: it adds optional
provenance to existing anchor records and changes no anchor schema field's meaning, so stores written
before this change load without migration.

#### Scenario: A renamed symbol's memory recalls as fresh, not orphaned

- **GIVEN** a memory anchored to `computeTax`, and a continuity pair `computeTax → calculateTax`
  (basis `exact-body`)
- **WHEN** the memory is recalled after the rename
- **THEN** it resolves to `calculateTax`, returns a `fresh` verdict annotated as carried across the
  rename, and carries provenance recording the prior anchor — rather than returning `orphaned`

#### Scenario: Carry-forward across a move preserves a decision's anchor

- **GIVEN** a decision anchored to a function that moved to a new file with an unchanged body
- **WHEN** the decision's anchor freshness is evaluated after the move
- **THEN** the anchor points at the function's new location with carried provenance, and is not reported
  as anchored to a deleted symbol

### Requirement: NoCarryForwardOnAmbiguousContinuity

The system SHALL NOT re-anchor a memory, decision, or spec link onto a guessed target. When continuity
is ambiguous (no one-to-one exact-body or exact-signature match), the anchor SHALL remain `orphaned` and
the candidate destination symbols SHALL be surfaced as a disclosure (e.g. `possiblyMovedTo: [...]`) for a
human or agent to reconcile. This preserves the authoritative-recall invariant: an orphaned memory is
never silently served against a symbol the system is not certain is the same one.

#### Scenario: An ambiguous move leaves the anchor orphaned but points at candidates

- **GIVEN** a memory anchored to a symbol whose continuity is ambiguous (two plausible destinations)
- **WHEN** the memory is recalled
- **THEN** it returns an `orphaned` verdict (not served as authoritative) together with the candidate
  destination symbols, rather than being re-anchored to either candidate
