# mcp-handlers spec delta

## ADDED Requirements

### Requirement: HandoffBriefingComposesExistingConclusions

`get_handoff_briefing` SHALL compose the in-flight state from existing substrate lookups into
one token-budgeted briefing: touched symbols with callers from the working-tree diff; fresh
in-scope anchored memories and decisions (orphaned withheld, drifted flagged, per the recall
discipline); drifted specs and open change directories referencing touched paths with their
unchecked task lines; reaching tests for the touched set; and unfinished-signal receipts
(uncommitted files, staged/unstaged split, stale certificate lease). Every truncated or
summarized element SHALL carry a re-fetch identifier naming the tool call that expands it, and
budget truncation SHALL be peripheral-first with per-section omission receipts. The tool SHALL
be a `conclusion` in family `change`, available only in the `full` preset, cross-referencing
`blast_radius` (diff for review), `briefing_since` (catch-up), and `orient` (session start) as
adjacent siblings.

#### Scenario: A successor resumes from the briefing alone

- **GIVEN** a session that edited a hub function, left a task unchecked in an open change, and
  drifted a spec
- **WHEN** `get_handoff_briefing` runs in a fresh session
- **THEN** the briefing names the touched symbol with callers, quotes the unchecked task,
  flags the drifted spec, lists the reaching tests, and each element carries its re-fetch
  identifier

#### Scenario: Freshness discipline survives succession

- **GIVEN** an anchored memory in scope whose anchor was orphaned by the in-flight edits
- **WHEN** the briefing is composed
- **THEN** the orphaned memory is withheld from the authoritative section per the recall
  discipline, and the withholding is disclosed
