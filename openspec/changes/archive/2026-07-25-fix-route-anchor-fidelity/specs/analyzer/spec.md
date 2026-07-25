# analyzer spec delta

## ADDED Requirements

### Requirement: RouteLineFidelityIsLengthPreserving

TS/JS route extraction SHALL compute every route's line number against text that is byte-aligned
with the original file: comment masking MUST be length-preserving (blanked, newlines kept),
never line-removing, so that `route.line` consumed by original-byte consumers — enclosing-function
anchoring for route-handler edge synthesis, dead-code liveness roots, the route inventory, and
the registration-line handler lookup — is exact, not approximate. Masking SHALL still prevent
route patterns inside comments from matching as real routes.

#### Scenario: Comments above a route do not drift its line

- **GIVEN** a TS file with a multi-line copyright block, a line comment, and a log line above a
  function containing `app.get('/users', listUsers)`
- **WHEN** route definitions are extracted
- **THEN** the route's reported line equals its actual line in the original file

#### Scenario: The route-handler edge anchors to the true enclosing function

- **GIVEN** the same fixture, with `listUsers` defined in the repo
- **WHEN** route-handler edges are synthesized
- **THEN** an edge from the function enclosing the registration to `listUsers` exists
- **AND** the edge is neither silently dropped nor attributed to a preceding function

#### Scenario: A framework-invoked handler is never a false dead-code candidate

- **GIVEN** a handler referenced only by a route registration preceded by long comments
- **WHEN** dead-code reachability runs with synthesized routes included
- **THEN** the handler is a liveness root and is not reported as a dead-code candidate

#### Scenario: Commented-out routes still do not match

- **GIVEN** a comment line containing `app.get('/example', handler)`
- **WHEN** route definitions are extracted
- **THEN** no route is produced for the commented pattern
