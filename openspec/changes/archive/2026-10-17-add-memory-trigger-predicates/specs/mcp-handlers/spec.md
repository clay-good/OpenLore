# mcp-handlers spec delta

## MODIFIED Requirements

### Requirement: ProactiveIntentBriefing

`orient` SHALL, for the symbols and files in a task's scope, proactively surface relevant prior
decisions and `remember` notes as part of orientation — without the agent having to ask for history
it is unaware of. Surfaced intent SHALL include records authored by any agent or human (not only the
current session) and SHALL carry a freshness verdict per the authoritative-recall invariant: orphaned
intent is withheld from the authoritative set (segregated as stale), drifted intent is flagged to
verify. In addition to anchor-scope overlap, a note whose deterministic trigger predicate matches
the task's touched set, and any note marked `pinned`, SHALL be pushed into the briefing as content
(not only as a contradiction or reversal signal); `blast_radius` and `working_set_context` SHALL
evaluate the same predicates against their own touched sets. Every briefing that injected memories
SHALL carry an accessed-knowledge receipt naming each injected memory, the predicate that fired
(or `pinned`), and its freshness verdict. Pinned and triggered items participate in the briefing's
existing token budget and bounded-with-disclosure discipline; injection SHALL never add an
unbounded or undisclosed section. (Realized by orient's `pendingDecisions` / `staleDecisions` /
`unreconciledMemories` briefing plus the `injectedMemories` push-and-receipt surface.)

#### Scenario: Orientation surfaces an in-scope constraint with its verdict

- **GIVEN** a decision anchored to a function in the task's scope
- **WHEN** `orient` runs for that task
- **THEN** the decision is surfaced in the briefing with its freshness verdict

#### Scenario: A triggered gotcha reaches an agent that never asked

- **GIVEN** a note recorded with trigger `fileGlob: "src/routes/**"` and a task touching a file
  under `src/routes/`
- **WHEN** `orient` runs for that task
- **THEN** the note's content appears in the briefing and the receipt names the note id and the
  fileGlob predicate that fired

## ADDED Requirements

### Requirement: MemoryTriggerPredicates

`remember` SHALL accept one optional trigger — file glob, symbol pattern, spec domain, or
anchor within N call hops of a touched symbol — and an optional `pinned` flag (pushed, within the bound, into
orient's full briefing). Evaluation SHALL be deterministic set membership and depth-capped
reachability, with no LLM. A pushed memory SHALL carry its freshness verdict; an orphaned one SHALL
never be pushed as authoritative. A malformed trigger SHALL be rejected at record time.

#### Scenario: A malformed trigger is rejected, not stored

- **GIVEN** a `remember` call whose trigger names two predicates, or none from the closed union
- **WHEN** the memory is recorded
- **THEN** the call returns an error naming the closed union and nothing is stored

#### Scenario: A call-hop trigger fires on structural proximity

- **GIVEN** a note anchored to `EdgeStore.open` with trigger `withinHops: 2`
- **WHEN** a briefing tool runs for a task touching a function that reaches `EdgeStore.open` in
  two call hops
- **THEN** the note is pushed with its verdict and a receipt citing the withinHops predicate

#### Scenario: A trigger never launders a stale memory

- **GIVEN** an orphaned note whose trigger matches the current task
- **WHEN** the briefing is assembled
- **THEN** the note is not injected as authoritative; at most it appears segregated as stale,
  exactly as recall would serve it

#### Scenario: Pinned stays budgeted and disclosed

- **GIVEN** more pinned notes than the briefing budget accommodates
- **WHEN** `orient` runs
- **THEN** the included subset is deterministic, the omitted count is disclosed, and each
  included item carries a `pinned` receipt
