# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SubSymbolSpanAnchors

`remember` SHALL optionally anchor a memory to an exact text span WITHIN a symbol, in addition to
the symbol- and file-level anchors. A span anchor keeps the symbol's identity fields and records
a span-level content baseline. Freshness SHALL re-locate the span by exact-text match within the
symbol's current body: a unique match (at the same or a new position) is `fresh`; no match is
`drifted`; multiple matches are ambiguous and the anchor SHALL orphan with candidate locations,
never be silently re-attached to a guess. After a continuity carry-forward re-points the symbol,
the span SHALL be re-located inside the new body by the same exact-text rule. Span matching SHALL
use no similarity score, threshold, or model. A span that cannot be located at record time SHALL
be recorded at symbol level with disclosure, never silently span-less.

- **Implementation**: `anchorFreshness::src/core/decisions/anchor.ts`

#### Scenario: An unrelated edit no longer drifts a line-specific memory

- **GIVEN** a memory span-anchored to one statement inside a large function
- **WHEN** a comment elsewhere in that function is edited and the index updates
- **THEN** the span re-locates exactly and the memory stays `fresh`, where a whole-symbol anchor
  would have reported `drifted`

#### Scenario: An ambiguous span orphans with candidates

- **GIVEN** an edit that duplicates the anchored text so it appears twice in the symbol's body
- **WHEN** freshness is computed
- **THEN** the anchor is `orphaned` with both candidate locations disclosed, and the memory is
  withheld from the authoritative set

### Requirement: AnchorLossIsAnActionableWorkItem

Recall's per-anchor verdicts SHALL carry an additive tri-state outcome label mapped from existing
freshness states: `silently-carried` (anchor byte-identical or exact-relocated),
`re-pointed-with-provenance` (carried across a rename/move with `carriedAcross` provenance), and
`needs-human-reselection` (anchor lost or ambiguous). The third state SHALL be emitted as a
registered `memory-anchor-lost` governance finding (advisory by default; blocking only via
`enforcement.policy`) in the unified GovernanceFinding shape, so `openlore enforce` and CI can
track lost anchors as a burndown. Authoritative filtering SHALL be unchanged: a
needs-human-reselection memory is never served as authoritative. A continuity gap the adjacent-
states matcher cannot bridge (e.g. a rename that occurred across multiple unindexed states) SHALL
land in `needs-human-reselection` with that reason disclosed, never in a guessed re-attachment.

- **Implementation**: `anchorOutcome::src/core/decisions/anchor.ts`

#### Scenario: A lost anchor becomes a trackable finding

- **GIVEN** a memory whose anchored symbol was deleted with no unambiguous successor
- **WHEN** recall or `openlore enforce` evaluates the store
- **THEN** the memory is labeled `needs-human-reselection` and a `memory-anchor-lost` finding is
  emitted with the memory id as subject — advisory, not blocking, by default

#### Scenario: A clean rename is work-free and says why

- **GIVEN** a memory whose anchor was carried across an unambiguous rename
- **WHEN** recall evaluates it
- **THEN** its outcome is `re-pointed-with-provenance` citing the carry, no finding is emitted,
  and the memory remains authoritative
