# cli spec delta

## ADDED Requirements

### Requirement: SessionStartsWithACatchUpWhenSomethingNotableChanged

On the first prompt of a harness session, `orient --inject` SHALL print at most 6 lines on what
changed since the previous session in the repository. The base SHALL be the head where the previous
session last wrote its record, kept after older records are pruned. It SHALL name only changed
symbols in the `surprising-change`, `hub-change`, or `chokepoint-change` tiers, decision status
changes, memories that went stale, and live peers.

#### Scenario: A hub changed since the last session

- **GIVEN** a previous session that ended at commit A, and a merged commit after A that changes a
  function classified `hub-change`
- **WHEN** the first prompt of a new session is submitted
- **THEN** the output names commit A, the commit count, and the hub's name and file

### Requirement: CatchUpIsQuietOrSaysNotAssessed

The catch-up SHALL print nothing when it has no notable fact or no previous session. When the base
is not an ancestor of HEAD, it SHALL print one "not assessed" line with the reason and no symbols.

#### Scenario: Only ordinary changes

- **GIVEN** commits after the base that change only `ordinary-change` symbols, and no decision,
  memory, or peer change
- **WHEN** the first prompt of a new session is submitted
- **THEN** no catch-up is printed

#### Scenario: A later prompt is quiet

- **WHEN** a second prompt is submitted in the same session
- **THEN** no catch-up is printed

#### Scenario: The base is gone

- **GIVEN** a previous session's head that is not an ancestor of HEAD
- **WHEN** the first prompt of a new session is submitted
- **THEN** one line says the catch-up is not assessed and why, and no symbol is listed

#### Scenario: First session in a repository

- **GIVEN** no other session record in the repository
- **WHEN** the first prompt is submitted
- **THEN** no catch-up is printed
