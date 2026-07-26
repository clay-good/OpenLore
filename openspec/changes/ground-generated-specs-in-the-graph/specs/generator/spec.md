# generator spec delta

## ADDED Requirements

### Requirement: GeneratedRequirementsCiteTheSymbolsTheyDescribe

Every requirement produced by spec generation SHALL cite the concrete symbols it describes, drawn
from the graph slice supplied to the generator and expressed as stable `name::path` identifiers.
The citation SHALL be emitted into the spec file as a machine-readable provenance line
immediately beneath the requirement heading, in the same style the corpus already uses for
decision provenance, so that it is valid OpenSpec markdown, legible to a human reader, and
recoverable by a parser without ambiguity.

The output contract SHALL be schema-checked: a response missing the citation field SHALL be
handled by the existing schema-guarded parse path rather than crashing or silently producing a
citation-free requirement without a record. A requirement the model declines to cite SHALL be
written without a provenance line and SHALL be treated downstream as uncited — never as a
fabricated citation.

The generator SHALL NOT invent a citation for a symbol absent from the slice it was given, and
SHALL NOT emit a citation the requirement's text does not concern.

#### Scenario: A generated requirement carries its symbols

- **GIVEN** a generation run over a domain whose slice contains `EdgeStore.open` and
  `EdgeStore.dbPath`
- **WHEN** a requirement describing store opening is generated
- **THEN** the written requirement is followed by a provenance line naming those symbols as
  `name::path` identifiers

#### Scenario: A missing citation degrades, never fails

- **GIVEN** a model response that omits the citation field for one requirement
- **WHEN** the response is parsed and written
- **THEN** the requirement is written without a provenance line, the run completes, and the
  omission is reported — no citation is fabricated and no run is aborted

### Requirement: CitationsSurviveWriteAndMerge

The spec writer SHALL preserve requirement provenance lines across every write mode. A merge
SHALL NOT drop, reorder, or duplicate a provenance line; a regeneration that produces the same
requirement with the same citations SHALL produce a byte-identical provenance line; and the
corpus structure check SHALL accept the provenance line as valid content rather than reporting it
as malformed.

Hand-written requirements without a provenance line SHALL be left exactly as they are.

#### Scenario: Merge preserves provenance

- **GIVEN** a spec file containing generated requirements with provenance lines and human-written
  requirements without them
- **WHEN** the spec is regenerated in merge mode
- **THEN** every provenance line is preserved for requirements that remain, and no provenance
  line is added to the human-written requirements

#### Scenario: Provenance is deterministic

- **GIVEN** two generation runs producing the same requirement with the same cited symbols
- **WHEN** the outputs are compared
- **THEN** the provenance lines are byte-identical, including symbol order
