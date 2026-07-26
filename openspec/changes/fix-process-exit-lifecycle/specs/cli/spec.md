# cli spec delta

## ADDED Requirements

### Requirement: StdioServerLifetimeIsBoundToStdin

The MCP stdio server's lifetime SHALL be its stdin. On stdin `end` or `close` the server SHALL run
its shutdown path — stopping the file watcher, closing the graph store, clearing timers — and exit,
regardless of which tool calls preceded it. Shutdown SHALL be idempotent and SHALL be the same path
used by `SIGINT` and `SIGTERM`, so no signal implements a partial teardown of its own. No resource
acquired during tool dispatch SHALL, by itself, keep the process alive after its transport closes.

#### Scenario: EOF ends the server after a watcher-starting tool call

- **GIVEN** an MCP stdio server that has served an `orient` call and started its file watcher
- **WHEN** the client closes stdin
- **THEN** the server stops the watcher, releases the graph store, and the process exits within a
  bounded shutdown window

#### Scenario: EOF ends the server before any tool call

- **GIVEN** an MCP stdio server that has completed `initialize` and served no tools
- **WHEN** the client closes stdin
- **THEN** the process exits — the behavior is the same whether or not a watcher was ever started

#### Scenario: An agent session leaves no zombie

- **GIVEN** a client that spawns the stdio server, issues several tool calls, and exits
- **WHEN** the client's process ends and its pipe closes
- **THEN** no OpenLore server process for that repository remains running

#### Scenario: Signals and EOF converge on one teardown

- **GIVEN** a running stdio server with a watcher and an open graph store
- **WHEN** it is shut down by stdin EOF, by `SIGINT`, or by `SIGTERM`
- **THEN** the same teardown runs in each case and running it twice is harmless

### Requirement: AFailedCommandExitsWithoutWaitingOutItsTimeout

A command that has reported a fatal error SHALL release its in-flight resources and exit promptly.
It SHALL NOT remain alive until an unrelated request timeout expires. The delay between the error
being reported and the process exiting SHALL be bounded and unrelated to the configured request
timeout.

#### Scenario: Generate exits after an unreachable provider

- **GIVEN** `openlore generate` configured with a request timeout of 120 seconds and a provider it
  cannot reach
- **WHEN** it reports `Failed to connect to LLM API`
- **THEN** the process exits non-zero promptly after that message rather than at the 120-second mark

#### Scenario: The exit delay does not track the timeout setting

- **GIVEN** the same failure
- **WHEN** the command is run with a larger configured request timeout
- **THEN** the time from the error message to process exit is unchanged
