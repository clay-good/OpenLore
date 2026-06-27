# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ProactiveIntentBriefing

`orient` and a dedicated `recall` mode SHALL, for the symbols and files in a task's scope, proactively
surface relevant prior decisions and constraints as a conclusion-shaped intent briefing — without
requiring the agent to explicitly ask for history. The briefing SHALL include memories and decisions
recorded by any agent or human (not only the current session) that anchor to in-scope code, each
carrying its freshness verdict per the authoritative-recall invariant: orphaned intent is withheld,
drifted intent is flagged to verify. The briefing SHALL be token-budgeted and surface only fresh,
in-scope intent, never a full history dump.

#### Scenario: Orientation surfaces an in-scope constraint

- **GIVEN** a decision anchored to a function in the task's scope
- **WHEN** `orient` runs for that task
- **THEN** the decision is surfaced in the intent briefing with its freshness verdict

#### Scenario: Orphaned intent is never briefed as current

- **GIVEN** a prior decision whose anchor symbol no longer exists
- **WHEN** the intent briefing is produced
- **THEN** that decision does not appear as current; it is withheld or labeled unverifiable

### Requirement: ReversalAwareness

When a decision in scope was superseded or reverted, the intent briefing SHALL surface it as an
explicit do-not-repeat warning naming the commit it was retired as of and the recorded reason, reading the
bitemporal supersession record. The system SHALL NOT silently omit reverted history, because the
absence of a do-not-repeat signal is what lets an agent re-introduce a deliberately removed approach.

#### Scenario: A reverted approach is surfaced as do-not-repeat

- **GIVEN** an approach recorded and later retired as of commit Y with a reason
- **WHEN** an agent orients on the code that approach touched
- **THEN** the briefing warns "do not re-attempt; retired as of commit Y — reason," rather than omitting it
