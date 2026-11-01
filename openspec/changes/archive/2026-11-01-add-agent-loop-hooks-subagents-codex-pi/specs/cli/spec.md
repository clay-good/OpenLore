# cli spec delta

## ADDED Requirements

### Requirement: SubagentsStartWithATaskScopedBriefing

For Claude Code, `openlore install` SHALL wire a `before-subagent` moment on the parent's `Agent`
or `Task` tool call that queues the sub-agent's task and prints nothing, and a `subagent-start`
moment on `SubagentStart` that gives the starting sub-agent the task-scoped `orient` briefing for
its own task and the live peers of other worktrees on the footprint board. A queued task SHALL be
given only when it is the one live task of the sub-agent's session and agent type (ambiguity gives
no task briefing, never another agent's task), taken once, kept only under `.openlore/` with
credentials redacted, not stored when sub-agent briefings or injection are off, and dropped after
two minutes.

#### Scenario: A sub-agent gets its own task's briefing

- **GIVEN** a parent that calls `Agent` with the prompt "Find where parseConfig is called"
- **WHEN** the `Explore` sub-agent starts
- **THEN** its context holds the task-scoped briefing for that prompt, and the parent's tool call
  printed nothing

#### Scenario: Ambiguous parallel sub-agents get no task briefing

- **GIVEN** two `Explore` calls and one `Plan` call queued in one turn
- **WHEN** the three sub-agents start
- **THEN** the `Plan` sub-agent gets the plan task, and the two `Explore` sub-agents get no task
  briefing rather than each other's task
