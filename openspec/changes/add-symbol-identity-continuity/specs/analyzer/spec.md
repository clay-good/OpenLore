# analyzer spec delta

## ADDED Requirements

### Requirement: DeterministicRenameMoveContinuityMap

Between two adjacent indexed states of a repository, the system SHALL compute a deterministic
**continuity map** of `(oldSymbol → newSymbol)` pairs identifying symbols that were renamed and/or moved
rather than deleted and re-added. A pair SHALL be admitted only on unambiguous evidence: an identical
content hash (`exact-body`) or an identical normalized signature and structural shape
(`exact-signature`), AND only when the match is one-to-one — exactly one disappeared candidate and one
appeared candidate satisfy it. Git rename detection MAY corroborate a file move but SHALL NOT be
sufficient on its own. Each pair SHALL record its reason (`renamed` | `moved` | `renamed-and-moved`) and
its basis (`exact-body` | `exact-signature`). The continuity map SHALL be a pure function of the two
indexed states and the diff between them — byte-identical for a fixed pair of states — and SHALL be
bounded to adjacent states, not a full git-history reconstruction.

#### Scenario: An identical-body rename is detected as continuity

- **GIVEN** a function present in the prior state and, in the new state, a function with a different name
  but a byte-identical body, with no other candidate competing for the match
- **WHEN** continuity is computed
- **THEN** the two are paired `oldSymbol → newSymbol` with reason `renamed` and basis `exact-body`

#### Scenario: A file move with an unchanged body is detected

- **GIVEN** a function moved to a different file with an unchanged body
- **WHEN** continuity is computed
- **THEN** the two are paired with reason `moved` (or `renamed-and-moved` if the name also changed)

#### Scenario: Ambiguous matches produce no pair

- **GIVEN** a disappeared symbol for which two appeared symbols both satisfy the match basis
- **WHEN** continuity is computed
- **THEN** no continuity pair is emitted for that symbol, and the candidate destinations are recorded for
  disclosure rather than one being chosen

#### Scenario: A renamed-and-rewritten symbol is not paired

- **GIVEN** a symbol whose name changed AND whose body was meaningfully rewritten (neither content hash
  nor normalized signature matches any appeared symbol)
- **WHEN** continuity is computed
- **THEN** it is treated as a delete plus an add — no continuity pair — because its identity is genuinely
  uncertain
