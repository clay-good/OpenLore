# cli spec delta

## ADDED Requirements

### Requirement: TaskCreationReceivesAConflictReceiptOnlyWhenBlocking

The `openlore hook` command SHALL offer a `task-created` moment for Claude Code that compares a new
team task's description with the live peer board and names a conflict with the existing
`parallel-work-conflict` finding code. `openlore install` SHALL wire the moment only when the
repository's enforcement policy makes that code blocking. When the task description resolves to no
unique symbol, the moment SHALL print nothing.

#### Scenario: A blocking policy stops a colliding task

- **GIVEN** a repository whose `enforcement.policy` makes `parallel-work-conflict` blocking
- **WHEN** a team task is created whose symbols a live peer declared in its write-set
- **THEN** the receipt names the peer, the shared symbols and the hazard class, and blocks the task

#### Scenario: The default install is silent

- **GIVEN** a repository with no enforcement policy
- **WHEN** `openlore install` runs and a team task is later created
- **THEN** no task-creation hook is wired and nothing is printed
