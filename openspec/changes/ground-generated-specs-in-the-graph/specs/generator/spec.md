# generator spec delta

## ADDED Requirements

### Requirement: SliceBackedRequirementsCiteTheirSymbolsThroughTheExistingAnchor

A requirement generated from a model response **over a supplied symbol slice** SHALL cite the
concrete symbols it describes, drawn from that slice and written in the repository's canonical
symbol-id form.

The citation SHALL extend the **existing** implementation-provenance line to carry every cited
symbol rather than only the single best-scoring one. A second provenance line type SHALL NOT be
introduced: a requirement carries one anchor, so a reader and a parser are never asked to
disambiguate two.

Requirements the generator emits from a template, or from a model response with no symbol slice —
the overview's capability and data-flow requirements, the domain-overview and endpoint fallbacks,
and entity-validation requirements — SHALL be written without a citation and reported as
**uncited-by-construction**, distinguished in the report from a citation a model declined to
supply.

The slice supplied for a requirement SHALL be recorded, and the writer SHALL drop any cited
symbol not present in that slice **before** the provenance line is written, so an out-of-slice
citation is never persisted and can never later be graded. Relevance beyond slice membership is
NOT deterministically checkable and SHALL NOT be claimed.

A response missing the citation field SHALL be handled by the existing schema-guarded parse path;
the requirement is written uncited and the omission reported. No citation SHALL be fabricated and
no run SHALL be aborted.

#### Scenario: A slice-backed requirement carries every cited symbol

- **GIVEN** a generation run over a domain whose slice contains three functions the requirement
  describes
- **WHEN** the requirement is generated
- **THEN** its provenance line names all three in canonical id form, through the existing
  implementation-provenance line rather than a second line type

#### Scenario: A template requirement is uncited by construction

- **GIVEN** a domain-overview fallback requirement, emitted from a template with no model
  response and no slice
- **WHEN** the spec is written
- **THEN** it carries no provenance line and is reported uncited-by-construction, distinct from a
  declined citation

#### Scenario: An out-of-slice citation is dropped before it is written

- **GIVEN** a model response citing a high-fan-in symbol that was not in the requirement's slice
- **WHEN** the spec is written
- **THEN** that symbol does not appear in the provenance line, so it can never be graded as
  grounding

### Requirement: ProvenanceIsPlacedBelowNormativeTextAndIsParserSafe

The provenance line SHALL be emitted **after** the requirement's normative text, matching the
placement the decision syncer already uses, so a parser that recovers a requirement's description
from the lines following its heading is unaffected.

The requirement parser SHALL skip `>`-prefixed provenance lines when recovering a description,
and SHALL recover requirements at both the `### Requirement:` and the nested `#### Requirement:`
(sub-component) heading levels, so no requirement is absent from a grounding denominator that is
required to be the full requirement set.

Provenance lines are **regenerated**, not preserved: the writer replaces the generated section
wholesale, so a re-generation producing the same cited symbols SHALL produce a byte-identical
provenance line, and a re-generation yielding no citation for a requirement that previously
carried one SHALL be reported as a citation regression rather than silently written. Content
outside the generated section, including hand-written requirements, is governed by the existing
merge-fidelity requirement in the `openspec` domain and is out of scope here.

#### Scenario: The description is the requirement text, not the provenance

- **GIVEN** a generated requirement carrying a provenance line
- **WHEN** the requirement is parsed
- **THEN** its recovered description is its `The system SHALL …` text, and the provenance line is
  skipped

#### Scenario: Sub-component requirements are counted

- **GIVEN** a spec containing requirements at both heading levels
- **WHEN** the corpus is enumerated for grounding
- **THEN** both levels appear in the denominator

#### Scenario: A lost citation is reported, not silently dropped

- **GIVEN** a requirement that carried a citation in a prior generation and receives none in the
  next
- **WHEN** the spec is regenerated
- **THEN** the loss is reported as a citation regression
