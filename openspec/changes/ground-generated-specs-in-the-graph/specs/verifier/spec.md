# verifier spec delta

## ADDED Requirements

### Requirement: SpecGroundingIsCheckedDeterministicallyAgainstTheGraph

The system SHALL provide a deterministic spec-grounding check that requires no LLM, no API key,
and no network. For each requirement in the spec corpus it SHALL resolve every cited symbol
against the call graph and assign exactly one verdict:

- `grounded` — every cited symbol resolves to a symbol present in the graph;
- `partially-grounded` — at least one citation resolves and at least one does not, with the
  unresolved citations named;
- `ungrounded` — the requirement carries citations and none of them resolve;
- `uncited` — the requirement carries no citation.

`uncited` SHALL be reported as a distinct verdict and SHALL NEVER be reported as, aggregated
into, or counted with `ungrounded`: the absence of a citation is not evidence that a requirement
is false. The denominator of any reported grounding rate SHALL be the full requirement set, and
requirements excluded from a category SHALL be reported rather than dropped.

A citation whose symbol was renamed or moved SHALL be carried forward through the existing
symbol-identity continuity mechanism and resolved against its current identity, with the
carry-forward disclosed — a refactor SHALL NOT be reported as ungrounding.

The check SHALL be read-only: it SHALL NOT rewrite, delete, or reorder any requirement. Its
findings SHALL be emitted as the registered governance finding `spec-requirement-ungrounded` with
a source-declared severity, advisory by default and blockable only through an operator's
enforcement policy.

Grounding SHALL be stated as an existence proof and never as a correctness proof: a `grounded`
verdict asserts only that the requirement concerns symbols the repository contains.

#### Scenario: A requirement citing a deleted symbol is caught with no API key

- **GIVEN** a spec requirement citing `parseLegacyConfig::src/config.ts`, a symbol no longer in
  the repository, and no configured LLM provider
- **WHEN** the grounding check runs
- **THEN** the requirement is reported `ungrounded`, the unresolved citation is named, and a
  `spec-requirement-ungrounded` finding is emitted advisorily

#### Scenario: Hand-written requirements are not accused

- **GIVEN** a corpus of 40 requirements, 25 of them hand-written with no citations
- **WHEN** the grounding check runs
- **THEN** the 25 are reported `uncited`, they are not counted as `ungrounded`, and the reported
  grounding rate discloses the full denominator

#### Scenario: A rename does not unground a requirement

- **GIVEN** a `grounded` requirement whose cited symbol is renamed in a later commit
- **WHEN** the repository is re-analyzed and the grounding check runs
- **THEN** the citation resolves to the renamed symbol via identity continuity, the verdict stays
  `grounded`, and the carry-forward is disclosed

#### Scenario: Grounding does not claim correctness

- **GIVEN** a requirement that cites live symbols but describes their behavior incorrectly
- **WHEN** the grounding check runs
- **THEN** the verdict is `grounded`, and the report states that grounding establishes existence
  of the cited code, not the accuracy of the description

### Requirement: LlmJudgedScoresAreLabeledAndNeverAuthoritative

Where spec verification uses a language model to score how well a spec describes a file, those
scores SHALL be labeled as LLM-judged wherever they are surfaced, and SHALL be reported alongside
the deterministic grounding verdict rather than merged into it. No composite score SHALL blend an
LLM-judged value with a deterministic one, and no LLM-judged value SHALL be presented as the
system's verdict on spec quality.

When no LLM provider is configured, the deterministic grounding report SHALL still be produced in
full, and its absence of LLM-judged scores SHALL be stated rather than rendered as a zero or an
omission.

#### Scenario: The two signals stay separated

- **GIVEN** a verification run with a configured provider
- **WHEN** the report is rendered
- **THEN** the grounding verdict and the LLM-judged accuracy score appear as distinct, labeled
  fields, and no field combines them

#### Scenario: No key still yields a quality signal

- **GIVEN** a repository with no API key configured
- **WHEN** spec quality is checked
- **THEN** the full grounding report is produced, and the report states that LLM-judged scores
  were not computed because no provider is configured
