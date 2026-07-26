# verifier spec delta

## ADDED Requirements

### Requirement: SpecGroundingIsCheckedDeterministicallyAgainstTheGraph

The system SHALL provide a deterministic spec-grounding check requiring no LLM, no API key, and
no network. For each requirement in the spec corpus it SHALL resolve every cited symbol against
the call graph and assign exactly one verdict: `grounded`, `partially-grounded`, `ungrounded`,
`ambiguous`, `unresolved-boundary`, `not-assessed`, or `uncited`.

`ungrounded` SHALL be reserved for a citation the check can **positively assert** the graph does
not contain. `uncited`, `ambiguous`, `unresolved-boundary`, and `not-assessed` SHALL each be
reported as distinct verdicts, SHALL NEVER be aggregated into or counted with `ungrounded`, and
SHALL NOT emit a finding. The denominator of any reported rate SHALL be the full requirement set,
and requirements excluded from a category SHALL be reported rather than dropped.

**Resolution.** A citation SHALL resolve exactly against the graph's canonical symbol id — never
by substring or fuzzy match. The written form is `<symbol>::<path>`, where `<symbol>` is exactly
the id's symbol part (`Class.method` for a method, the scope-qualified form for a nested
function) and `<path>` the repo-relative file path. A citation matching more than one symbol — a
collapsed overload set, or a bare name written without a path — SHALL be reported `ambiguous`
with the candidates named, never resolved by picking one.

**Boundaries are disclosed, never converted into accusations.** A citation into a file whose
language the graph does not extract symbols for, into a file disclosed by parse-health as a lower
bound, or resolved against an index staler than the working tree SHALL be reported `not-assessed`
with the boundary named. The report SHALL name the languages and files excluded on this basis.

**Renames.** A citation whose symbol was renamed or moved SHALL be re-resolved through the
existing symbol-identity continuity map where one is available, with the carry-forward disclosed.
Where continuity is unavailable — no pre-rebuild snapshot, an ambiguous move, or a language
without normalized body extraction — the citation SHALL be `unresolved-boundary`, never
`ungrounded`, and the report SHALL name which boundary applied.

**The check is read-only.** It SHALL NOT rewrite, delete, or reorder any requirement, and SHALL
NOT write to any store: re-pointing is computed at read time from the graph and the continuity
map.

**Ceiling.** The report SHALL state that a `grounded` verdict asserts only that the cited symbols
exist and were in the slice the requirement was generated from. It does not assert that they are
the symbols the requirement is about, nor that the prose is accurate. Grounding SHALL NEVER be
rendered as a spec-quality score.

Findings SHALL be emitted as the registered code `spec-requirement-ungrounded` with
`defaultClass: 'advisory'`; the emitted severity SHALL play no part in classing it. This finding
SHALL NOT supersede the shipped corpus lint, which continues to fail the build on the
corpus-corruption classes it already gates.

#### Scenario: A requirement citing a deleted symbol is caught with no API key

- **GIVEN** a requirement citing a symbol no longer in the repository, in an extracted language,
  against a fresh index, and no configured LLM provider
- **WHEN** the grounding check runs
- **THEN** the requirement is `ungrounded`, the unresolved citation is named, and a
  `spec-requirement-ungrounded` finding is emitted advisorily

#### Scenario: An unextracted language is not accused

- **GIVEN** a requirement citing a symbol in a file whose language the graph extracts no symbols
  for
- **WHEN** the grounding check runs
- **THEN** the verdict is `not-assessed` naming the language boundary, it is not counted as
  `ungrounded`, and no finding is emitted

#### Scenario: Hand-written requirements are not accused

- **GIVEN** a corpus of 40 requirements, 25 hand-written with no citations
- **WHEN** the check runs
- **THEN** the 25 are `uncited`, are not counted as `ungrounded`, and the reported rate discloses
  the full denominator

#### Scenario: An unbridgeable rename is a boundary, not an accusation

- **GIVEN** a `grounded` requirement whose cited symbol is renamed, analyzed on a fresh clone
  with no pre-rebuild snapshot
- **WHEN** the check runs
- **THEN** the verdict is `unresolved-boundary` naming the missing-snapshot cause, not
  `ungrounded`

#### Scenario: An ambiguous citation is never silently resolved

- **GIVEN** a citation written as a bare name matching three symbols
- **WHEN** the check runs
- **THEN** the verdict is `ambiguous`, all three candidates are named, and no single one is
  chosen

#### Scenario: Grounding does not claim correctness

- **GIVEN** a requirement citing live symbols but describing their behavior incorrectly
- **WHEN** the check runs
- **THEN** the verdict is `grounded`, and the output states that grounding establishes existence
  of the cited code, not the accuracy of the description

## MODIFIED Requirements

### Requirement: LlmJudgedScoresCarryProvenance

The existing requirement is extended with a no-provider clause: when no LLM provider is
configured, the deterministic grounding report SHALL still be produced in full, and the absence
of LLM-judged scores SHALL be **stated** rather than rendered as a zero, an omission, or a
default. The existing obligations — the `llm-judged` label, the judging model's id, and the
prohibition on blending an LLM-judged value into a deterministic one — are unchanged and are not
restated here.

#### Scenario: No key still yields a quality signal

- **GIVEN** a repository with no API key configured
- **WHEN** spec quality is checked
- **THEN** the full grounding report is produced, and the report states that LLM-judged scores
  were not computed because no provider is configured
