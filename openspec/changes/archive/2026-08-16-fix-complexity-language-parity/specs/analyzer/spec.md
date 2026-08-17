# analyzer spec delta

## ADDED Requirements

### Requirement: PerLanguageComplexityEstimation

Cyclomatic-complexity estimation SHALL use a decision-point pattern matched to each supported
language's grammar (paren-required patterns only for paren-required grammars; keyword patterns
for Go, Rust, Swift, Ruby, Elixir), and the set of complexity-supported languages SHALL be
disclosed through the per-language capability registry, derived from the pattern table. A
language with no pattern SHALL report no complexity value — never a silent constant — so a quiet
number is always a measurement, not a coverage artifact.

#### Scenario: Go decisions are counted

- **GIVEN** a Go function body containing 3 `if err != nil {` branches, 1 `for i := 0; ...`
  loop, and 1 `case` arm
- **WHEN** cyclomatic complexity is computed
- **THEN** the result equals the complexity of the identically shaped paren-style (TS) body

#### Scenario: Ruby keyword forms are decisions

- **GIVEN** a Ruby method with `if`, `elsif`, and `while` branches
- **WHEN** cyclomatic complexity is computed
- **THEN** each branch contributes a decision point (CC greater than 1)

#### Scenario: An unlisted language is honestly null

- **GIVEN** a function in a language with no complexity pattern
- **WHEN** the call graph's complexity pass runs
- **THEN** the node carries no cyclomatic-complexity value
- **AND** the capability matrix reports complexity unsupported for that language

#### Scenario: Patterns grow only with fixtures

- **GIVEN** a new language added to the complexity pattern table
- **WHEN** the conformance suite runs
- **THEN** a shape fixture for that language exists asserting its decision keywords are counted,
  or the suite fails
