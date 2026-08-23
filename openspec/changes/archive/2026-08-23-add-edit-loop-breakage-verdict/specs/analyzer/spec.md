# analyzer spec delta

## ADDED Requirements

### Requirement: CallSitesCarryArgumentCounts

Call-edge extraction SHALL capture the argument count at each call site alongside the existing
call-site line, for the languages whose extractors read the call node's argument list
(TypeScript/JavaScript/Python at minimum); a language or call shape where the count cannot be
read from the AST SHALL leave the field absent — never zero, never estimated. Spread/splat
arguments SHALL mark the count as a disclosed lower bound, not an exact count.

#### Scenario: An exact count is stored where the AST provides it

- **GIVEN** a TypeScript call `f(a, b, c)`
- **WHEN** the edge is extracted
- **THEN** it carries `argCount: 3` (exact) and the call-site line

#### Scenario: A spread never claims exactness

- **GIVEN** a call `f(a, ...rest)`
- **WHEN** the edge is extracted
- **THEN** the stored count is marked a lower bound, and no consumer may treat it as exact
