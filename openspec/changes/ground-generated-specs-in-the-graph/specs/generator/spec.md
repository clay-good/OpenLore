# generator spec delta

## ADDED Requirements

### Requirement: ImplementationAnchorsAreParserSafeAndCoverSubComponents

The generator SHALL write a requirement's implementation anchor (`- **Implementation**: \`name::path\``)
**after** the requirement's normative text, never between the heading and that text, so a parser
that recovers a requirement's description from the lines following its heading reads the normative
sentence.

A sub-component requirement (`#### Requirement:`) whose anchor proposal was verified against the
graph SHALL carry its anchor exactly as a top-level requirement does.

The deterministic spec link index SHALL recover requirements at both the `### Requirement:` and the
nested `#### Requirement:` heading levels, so no requirement is absent from its denominator.

#### Scenario: The anchor follows the normative text

- **GIVEN** a generated requirement with a verified implementation anchor
- **WHEN** the spec is written
- **THEN** the anchor line appears after the `The system SHALL …` line

#### Scenario: A sub-component requirement is anchored and indexed

- **GIVEN** an orchestrator service whose sub-component operation has a verified anchor
- **WHEN** the spec is written and the link index is built
- **THEN** the `#### Requirement:` block carries its anchor and is counted and resolved by the index

### Requirement: SpecLinkAbsenceIsClaimedOnlyWhereAssessable

The spec link index SHALL report an anchor whose cited symbol is absent from the export inventory as
`not-assessed`, naming its boundary, rather than `stale`, when the cited file is one whose exports
the analysis cannot vouch for:

- `language-not-extracted` — exports are never extracted for the file's language;
- `parse-health-lower-bound` — the file parsed with errors or was excluded;
- `file-not-analyzed` — the file exists but the analysis did not cover it.

An anchor that names no file SHALL remain `stale` when absent, and a file that neither exists nor is
analyzed SHALL NOT be a boundary, so absence is still claimed wherever it is evidence. A requirement
SHALL be `not-assessed` when any anchor is `not-assessed` and none is `stale` or `ambiguous`; it
SHALL be counted in its own statistic, SHALL be listed by the refresh command with each boundary, and
SHALL NOT be reported as an orphan requirement. The persisted index SHALL carry a new schema version
so a cache built under the previous meaning is rebuilt.

#### Scenario: An unextracted language is not accused

- **GIVEN** a requirement anchored to `Run::src/job.go` and an analysis that extracts no Go exports
- **WHEN** the link index is built
- **THEN** the anchor and the requirement are `not-assessed` with boundary `language-not-extracted`,
  and no requirement is counted `stale`

#### Scenario: A genuinely removed symbol is still stale

- **GIVEN** a requirement anchored to `gone::src/a.ts`, where `src/a.ts` is analyzed, healthy, and
  exports no `gone`
- **WHEN** the link index is built
- **THEN** the requirement is `stale`
