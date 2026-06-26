# analyzer spec delta

## ADDED Requirements

### Requirement: DeterministicRenameMoveContinuityMap

Between two adjacent indexed states of a repository, the system SHALL compute a deterministic
**continuity map** of `(oldSymbol → newSymbol)` pairs identifying symbols that were renamed and/or moved
rather than deleted and re-added. A pair SHALL be admitted only on unambiguous evidence:

- `exact-body` — the new symbol's source span is byte-identical to the old one (a pure move; the name
  did not change), OR
- `exact-signature` — the new span is identical to the old one EXCEPT the symbol's own name changed (a
  rename). This SHALL be verified by substituting the candidate's new name back to the old name and
  confirming the result hashes to the old baseline span — a true body-identity-modulo-name check, NOT a
  mere parameter-shape match. A symbol that only shares a parameter shape with the old one (e.g. an
  unrelated newcomer that appeared the same run the old symbol was deleted) SHALL NOT be matched, so a
  genuinely deleted symbol is never re-anchored onto an unrelated symbol. Identifier substitution SHALL use
  Unicode-aware whole-word boundaries (a name adjacent to a non-ASCII identifier character is not a match),
  and SHALL be rejected when the OLD name already appears as a whole-word token in the new span — the
  newcomer references the old symbol (e.g. an unrelated function that merely calls the deleted one), so a
  substitution could spuriously reconstruct the old span. A genuine full rename removes every occurrence of
  the old name, so this guard never rejects a real rename.

A pair SHALL be admitted only when the match is one-to-one — exactly one disappeared candidate and one
appeared candidate satisfy it — AND, for `exact-signature`, only when the name-independent body is not
shared by any other new symbol (an identical-body clone elsewhere makes the body non-identifying, so no
pair is emitted). Git rename detection MAY corroborate a file move but SHALL NOT be sufficient on its
own. Each pair SHALL record its reason (`renamed` | `moved` | `renamed-and-moved`) and its basis
(`exact-body` | `exact-signature`). The continuity map SHALL be a pure function of the two indexed states
— byte-identical for a fixed pair of states — and SHALL be bounded to adjacent states, not a full
git-history reconstruction.

#### Scenario: A pure rename (same body, new name) is detected as continuity

- **GIVEN** a function present in the prior state and, in the new state, a function with a different name
  whose body is otherwise identical, with no other candidate competing for the match
- **WHEN** continuity is computed
- **THEN** the two are paired `oldSymbol → newSymbol` with reason `renamed` and basis `exact-signature`

#### Scenario: A file move with an unchanged body is detected

- **GIVEN** a function moved to a different file with a byte-identical body
- **WHEN** continuity is computed
- **THEN** the two are paired with reason `moved` and basis `exact-body`

#### Scenario: A deleted symbol is NOT matched to an unrelated same-shape newcomer

- **GIVEN** an anchored symbol is deleted and, the same re-analysis, an unrelated symbol with the same
  parameter shape but a DIFFERENT body appears
- **WHEN** continuity is computed
- **THEN** no continuity pair is emitted — the bodies differ beyond the name — and the deleted symbol's
  anchor stays orphaned rather than being carried onto the unrelated newcomer

#### Scenario: A newcomer that references the deleted symbol is NOT matched

- **GIVEN** an anchored symbol `a` is deleted and, the same re-analysis, an unrelated symbol whose body
  contains a whole-word reference to `a` appears (so substituting its name back to `a` could spuriously
  reconstruct `a`'s body)
- **WHEN** continuity is computed
- **THEN** no continuity pair is emitted — the old name is present in the new span — and `a`'s anchor stays
  orphaned

#### Scenario: Ambiguous matches produce no pair

- **GIVEN** a disappeared symbol for which two appeared symbols both satisfy the match basis
- **WHEN** continuity is computed
- **THEN** no continuity pair is emitted for that symbol, and the candidate destinations are recorded for
  disclosure rather than one being chosen

#### Scenario: A renamed-and-rewritten symbol is not paired

- **GIVEN** a symbol whose name changed AND whose body was meaningfully rewritten (the body is not
  identical to any appeared symbol's body modulo the name)
- **WHEN** continuity is computed
- **THEN** it is treated as a delete plus an add — no continuity pair — because its identity is genuinely
  uncertain
