# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConsumersSubtractProvenNeutralChangesDisclosed

Change-shaped conclusions that consume a changed-symbol set (structural diff, diff-seeded blast
radius and test selection, the change-significance briefing) SHALL exclude or de-tier symbols
classified `provably-neutral`, and SHALL disclose the subtraction — the count excluded and the
verdict basis — in the same response. A `not-proven-neutral` symbol SHALL be treated exactly as a
changed symbol is today. No consumer may subtract silently, and no consumer may treat
`not-proven-neutral` as evidence of behavioral change beyond what the underlying diff already
establishes.

#### Scenario: Blast radius de-noises a reformat commit

- **GIVEN** a diff of 30 changed symbols of which 14 are proven neutral
- **WHEN** blast radius is computed for the diff
- **THEN** the radius is seeded by the 16 remaining symbols and the response states that 14
  proven-neutral symbols were excluded

#### Scenario: The briefing labels rather than tiers a neutral hub change

- **GIVEN** a high-fan-in hub changed only by a comment sweep
- **WHEN** the change-significance briefing is computed
- **THEN** the hub appears labeled proven-neutral instead of occupying a change tier

#### Scenario: No silent subtraction

- **GIVEN** any consumer that excluded proven-neutral symbols
- **WHEN** its response is rendered
- **THEN** the exclusion count and basis are present in the response
