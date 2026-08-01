# analyzer spec delta

## ADDED Requirements

### Requirement: NeutralityIsProvenNeverGuessed

The system SHALL classify a changed symbol `provably-neutral` if and only if the normalized
syntax trees of its before and after spans are byte-identical under a closed, per-language,
disclosed normalization vocabulary (initially: comment removal and whitespace normalization);
every other outcome — any tree difference, a parse failure on either side, an unloaded grammar,
a changed string-literal — SHALL be classified `not-proven-neutral`, which asserts nothing about
behavior. The vocabulary SHALL be closed and disclosed with every verdict: no normalization may
be applied that is not named in the output, and additions to the vocabulary require per-language
conformance fixtures. Classification SHALL be deterministic: identical inputs produce
byte-identical verdicts.

#### Scenario: A reformat proves neutral

- **GIVEN** a symbol whose only changes are re-indentation and comment edits
- **WHEN** the verdict is computed
- **THEN** it is `provably-neutral` with the applied normalizations named

#### Scenario: One real token defeats the proof

- **GIVEN** a reformatted symbol that also changes one operator
- **WHEN** the verdict is computed
- **THEN** it is `not-proven-neutral`

#### Scenario: What cannot be parsed cannot be proven

- **GIVEN** a changed symbol whose after-span fails to parse, or whose language has no loaded
  grammar
- **WHEN** the verdict is computed
- **THEN** it is `not-proven-neutral` with the failure or unsupported language disclosed

#### Scenario: String contents are behavior

- **GIVEN** a change only to the inside of a string literal
- **WHEN** the verdict is computed
- **THEN** it is `not-proven-neutral`
