# mcp-handlers spec delta

## ADDED Requirements

### Requirement: FleetRecordsAndPlansUseTheBoard

Fleet verification records SHALL live in the board directory so every worktree of the clone reads
them. `plan_parallel_work` SHALL offer an option that adds live board entries to the planned tasks.

#### Scenario: A fleet verdict is shared

- **GIVEN** a fleet verification record proved in worktree A
- **WHEN** worktree B reads fleet status
- **THEN** the record is visible

#### Scenario: Board entries join a plan

- **GIVEN** a live board entry for agent B, and the board option set
- **WHEN** agent A calls `plan_parallel_work` with its own task
- **THEN** the plan includes agent B's entry as a task
