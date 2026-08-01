# cli spec delta

## ADDED Requirements

### Requirement: AdaptiveHeapSizing

The `openlore` CLI SHALL size its own V8 heap to the machine so that a large repository analyzes
without the user setting any Node flag. When the default heap is smaller than a generous fraction of
the memory available to the process, the CLI SHALL re-execute itself once with
`--max-old-space-size` set to that fraction, then continue normally.

"Available memory" SHALL be the container/cgroup memory limit when the process runs under one, and
`os.totalmem()` otherwise — so a CI or container job sizes to its own limit rather than the host's,
and is not OOM-killed for over-allocating.

Re-execution SHALL be safe and quiet: it happens at most once (a marker prevents any loop), it is
skipped when the user has already set the heap (via `--max-old-space-size`, `NODE_OPTIONS`, or the
opt-out below), it preserves argv, environment, exit code, and the stdio streams unchanged (so the
stdio MCP server and any piped output are unaffected), and it emits a single line naming the chosen
heap so the behavior is observable rather than hidden.

#### Scenario: A large repository analyzes with no flag

- **GIVEN** a repository whose graph needs more heap than Node's default
- **AND** the user runs `openlore analyze` (or `install`) with no memory flag
- **WHEN** the CLI starts
- **THEN** it re-executes once with a heap sized to the available memory, the analysis completes, and
  a single line discloses the heap it chose

#### Scenario: The user's own heap choice is respected

- **GIVEN** the user has set `--max-old-space-size` or `NODE_OPTIONS`, or set the opt-out variable
- **WHEN** the CLI starts
- **THEN** it does not re-execute and does not override the user's choice

#### Scenario: Re-execution never loops

- **GIVEN** any invocation that re-executes to raise the heap
- **WHEN** the re-executed process starts
- **THEN** it sees the marker and does not re-execute again, regardless of outcome

#### Scenario: Container memory limit is honored

- **GIVEN** the process runs under a cgroup/container memory limit smaller than host RAM
- **WHEN** the CLI sizes its heap
- **THEN** it sizes to the container limit, not host RAM, so the container does not OOM-kill it

### Requirement: MemoryScalingIsObservableAndOverridable

The CLI SHALL expose a single documented escape hatch to disable adaptive heap sizing, and SHALL make
the active choice observable. Disabling it SHALL fall back to the current behavior (Node's default or
whatever the user set), unchanged.

#### Scenario: Adaptive sizing can be turned off

- **GIVEN** the documented opt-out is set
- **WHEN** the CLI runs
- **THEN** it does not re-execute or resize, and behaves exactly as it does today
