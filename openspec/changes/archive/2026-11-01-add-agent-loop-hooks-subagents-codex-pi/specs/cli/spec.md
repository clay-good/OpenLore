# cli spec delta

## ADDED Requirements

### Requirement: SubagentsStartWithATaskScopedBriefing

For Claude Code, `openlore install` SHALL wire a `before-subagent` moment on the parent's `Agent`
or `Task` tool call that queues the sub-agent's task and prints nothing, and a `subagent-start`
moment on `SubagentStart` that gives the starting sub-agent the task-scoped `orient` briefing for
its own task and the live peers of other worktrees on the footprint board. A queued task SHALL be
matched by session and agent type, oldest first, taken once, kept only under `.openlore/` with
credentials redacted, and dropped after ten minutes.

#### Scenario: A sub-agent gets its own task's briefing

- **GIVEN** a parent that calls `Agent` with the prompt "Find where parseConfig is called"
- **WHEN** the `Explore` sub-agent starts
- **THEN** its context holds the task-scoped briefing for that prompt, and the parent's tool call
  printed nothing

#### Scenario: Parallel sub-agents are matched by type and order

- **GIVEN** two `Explore` calls and one `Plan` call queued in one turn
- **WHEN** the three sub-agents start
- **THEN** the `Plan` sub-agent gets the plan task and the two `Explore` sub-agents get their tasks
  in the order they were queued
