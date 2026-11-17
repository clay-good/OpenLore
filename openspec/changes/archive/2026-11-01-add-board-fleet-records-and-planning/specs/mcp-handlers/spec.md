# mcp-handlers spec delta

## ADDED Requirements

### Requirement: FleetRecordsAndPlansUseTheBoard

Fleet verification records SHALL live next to the peer board in the git common directory so every
worktree of the clone reads them; a legacy per-worktree record SHALL still be read, and is folded
into the shared file on the next write. Records are written by any worktree: only well-formed ones
are read, their text is screened before it is served, a file that cannot be read is never written
over, and a record from another worktree is listed as `other-worktree`, not checked against this
worktree's code. `plan_parallel_work` SHALL offer an option that adds live board entries from other
worktrees to the planned tasks, named `board:<actorId>`; this directory's own entries are not added.

#### Scenario: A fleet verdict is shared

- **GIVEN** a fleet verification record proved in worktree A
- **WHEN** worktree B reads fleet status
- **THEN** the record is visible

#### Scenario: Board entries join a plan

- **GIVEN** a live board entry for agent B, and the board option set
- **WHEN** agent A calls `plan_parallel_work` with its own task
- **THEN** the plan includes agent B's entry as a task
