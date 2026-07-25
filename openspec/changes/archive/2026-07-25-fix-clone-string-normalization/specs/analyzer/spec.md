# analyzer spec delta

## ADDED Requirements

### Requirement: StringLiteralSafeCloneNormalization

Clone-detection normalization SHALL NOT alter string-literal contents when stripping comments:
comment rules SHALL be evaluated against a length-preserving string-masked view so a comment
marker inside a literal (`//` in a URL, `#` in a hex color or anchor, Ruby `#{...}`
interpolation, JS `#private` access) never truncates the literal; the `#` line-comment rule
SHALL apply only to languages where `#` is a comment; and a reported clone-group similarity
SHALL be what was computed — an all-pairs group floor, or a value explicitly labeled
seed-relative — never a seed-relative number presented as group-wide.

#### Scenario: Functions differing only in a URL are not identical clones

- **GIVEN** two TypeScript functions identical except for the host and path inside a string
  literal `"https://..."`
- **WHEN** clone detection runs
- **THEN** the pair is not reported as an exact or structural clone at similarity 1.0
- **AND** any reported similarity reflects the literal difference

#### Scenario: Functions differing only in constants are not identical clones

- **GIVEN** two Python functions identical except for hex-color string constants (`"#ff0000"`
  vs `"#00ff00"`)
- **WHEN** clone detection runs
- **THEN** the pair is not reported as an exact or structural clone at similarity 1.0

#### Scenario: The hash-comment rule is language-selected

- **GIVEN** a TypeScript function whose string literals contain `#`
- **WHEN** normalization strips comments
- **THEN** no text is removed by the `#` rule and the literals survive intact

#### Scenario: True clones are still detected

- **GIVEN** two copy-pasted functions that differ only in their comments
- **WHEN** clone detection runs
- **THEN** the pair is reported as an exact clone at similarity 1.0

#### Scenario: Group similarity is honest

- **GIVEN** a near-clone group whose members are 0.85-similar to the seed but less similar to
  each other
- **WHEN** the group's similarity is reported
- **THEN** the number is either the all-pairs minimum or is explicitly labeled seed-relative
