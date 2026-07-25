# architecture spec delta

## ADDED Requirements

### Requirement: DigestFiguresUseOnePopulationPerLabel

Every figure in the generated codebase digest SHALL be computed over the population its
label names, and adjacent figures presented as a coherent overview SHALL share one
population definition: a count labeled "internal" SHALL exclude exactly what the adjacent
internal counts exclude (test and external nodes/edges), or the label SHALL name the true
population. List-shaped digest sections (e.g. spec domains) SHALL be emitted in a sorted,
platform-independent order, never raw directory-enumeration order.

#### Scenario: The edge count matches its label

- **GIVEN** a call graph containing production, test-caller, and external-callee edges
- **WHEN** the digest renders the "internal call edges" figure next to the
  production-function count
- **THEN** either the edge figure counts only edges between non-test, non-external nodes,
  or its label names the wider population it actually counts — the two adjacent figures
  are never mixed populations under one qualifier

#### Scenario: Spec domains render platform-independently

- **GIVEN** the same spec directory enumerated on two platforms with different readdir
  ordering
- **WHEN** the digest is generated on each
- **THEN** the spec-domain list is identical (sorted), keeping the digest bytes stable
  across platforms

#### Scenario: A regenerated digest explains a moved headline number

- **GIVEN** a digest regenerated after the edge-population fix
- **WHEN** the "internal call edges" figure changes
- **THEN** the change is attributable to the corrected population, with both the old and
  new definitions stated in the change that moved it
