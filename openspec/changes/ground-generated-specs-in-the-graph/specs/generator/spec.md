# generator spec delta

## ADDED Requirements

### Requirement: ImplementationAnchorsFollowNormativeText

The generator SHALL write a requirement's implementation anchor (`- **Implementation**: \`name::path\``)
**after** the requirement's normative text, never between the heading and that text, so a parser
that recovers a requirement's description from the lines following its heading reads the normative
sentence.

When two requirements the generator emits share an anchor key and their proposals disagree — they
name different symbols, or one names a symbol that does not resolve — the generator SHALL write no
anchor for that key rather than letting either proposal's anchor land on both requirements.

Requirements SHALL continue to be recognized at the `### Requirement:` level only, the level the
OpenSpec format counts; a `#### Requirement:` sub-component heading SHALL NOT enter the link index.

#### Scenario: The anchor follows the normative text

- **GIVEN** a generated requirement with a verified implementation anchor
- **WHEN** the spec is written
- **THEN** the anchor line appears after the `The system SHALL …` line

#### Scenario: Colliding proposals write no anchor

- **GIVEN** a top-level operation `run` proposing `runAll` and a sub-component operation `Run`
  proposing `runStep`
- **WHEN** anchor proposals are verified
- **THEN** no anchor is written for that key

### Requirement: SpecLinkAbsenceIsClaimedOnlyWhereAssessable

The spec link index SHALL report an anchor whose cited symbol is absent from the export inventory as
`not-assessed`, naming its boundary, rather than `stale`, when the cited file is one whose exports
the analysis cannot vouch for:

- `language-not-extracted` — exports are never extracted for the file's language;
- `file-not-analyzed` — the file exists but the analysis did not cover it.

Parse health SHALL NOT be a boundary: its error regions come from a different extractor than the
export inventory and are no evidence that inventory is incomplete.

A boundary SHALL be named only for a file that exists as a regular file, resolved to its real
spelling (symlinks, and letter case on a case-insensitive volume); an anchor SHALL match exports by
that real spelling, so an existing symbol cited under another spelling of its file is `linked`. An anchor that names no
file, and an anchor naming a file that exists nowhere or is not a regular file, SHALL remain `stale`
when its symbol is absent, so absence is still claimed wherever it is evidence.

A requirement SHALL be `not-assessed` when any anchor is `not-assessed` and none is `stale` or
`ambiguous`; it SHALL be counted in its own statistic, SHALL be listed by the refresh command with each
boundary, and SHALL NOT be reported as an orphan requirement. The persisted index SHALL carry a new
schema version, SHALL accept the new state when read back, and SHALL NOT be served from cache when
re-assessing any cited file behind a `stale` or `not-assessed` anchor gives a different result.

#### Scenario: An unextracted language is not accused

- **GIVEN** a requirement anchored to `Run::src/job.go`, where `src/job.go` is analyzed and Go exports
  are not extracted
- **WHEN** the link index is built
- **THEN** the anchor and the requirement are `not-assessed` with boundary `language-not-extracted`,
  and no requirement is counted `stale`

#### Scenario: A deleted file is still stale

- **GIVEN** a requirement anchored to `Run::src/deleted.go`, a file that is neither analyzed nor on disk
- **WHEN** the link index is built
- **THEN** the requirement is `stale`

#### Scenario: A cached accusation is re-assessed

- **GIVEN** a persisted index in which `gone::src/new.ts` is `stale` because `src/new.ts` exists nowhere
- **WHEN** `src/new.ts` is then created, without re-analysis, and the index is resolved
- **THEN** the cache is not served, and the requirement is `not-assessed` with boundary
  `file-not-analyzed`
