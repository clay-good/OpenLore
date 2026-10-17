## ADDED Requirements

### Requirement: SubprocessesNeverSurfaceAConsoleWindow

Every subprocess spawned from `src/` SHALL set `windowsHide: true`, unless it inherits the parent's
console (`stdio: 'inherit'`). On Windows a console program spawned from a process that has no
console of its own — the `serve`/`mcp` daemon, a Git hook or agent hook invocation, an editor
extension host — is given a brand new visible console window, one per spawn; a path that shells out
per file turns that into a continuous flash that makes the tool unusable for real work.

The exemption is exact rather than incidental: an inheriting child is by construction attached to a
console its parent already has, so no window is created, and suppressing one would cut the user's
own interactive command off from the terminal it is writing to.

Spawning `git` SHALL additionally route through a single shared helper, so that `windowsHide` — and
any future cross-cutting concern on git subprocesses — is applied in one place instead of being
re-remembered at every call site.

An automated guard SHALL enforce both invariants on every platform, by reading the source rather
than by running it: a headless Windows runner cannot observe a window flashing, so no behavioural
test on any runner can fail when the option is dropped. The guard SHALL resolve which local
identifiers are bound to the process-spawning module, so that it neither reports method calls that
merely share a name (`regex.exec`, `db.exec`) nor misses a spawn imported under an alias, and it
SHALL scope its exemptions to individual call sites rather than to whole files.

#### Scenario: A new spawn on a daemon path omits the option

- **GIVEN** a contributor adds a subprocess spawn that does not inherit a console
- **WHEN** the guard test runs in CI, on any platform
- **THEN** it fails, naming the offending file and line, and states both remedies — set
  `windowsHide: true`, or route a `git` spawn through the shared helper

#### Scenario: A migrated file grows a second, raw git spawn

- **GIVEN** a file that already calls the shared git helper under a local alias
- **WHEN** a new raw `node:child_process` spawn of `git` is added beside it
- **THEN** the guard fails on the new site, and does not treat the file's existing use of the helper
  as blanket permission

#### Scenario: An interactive command keeps its console

- **GIVEN** a command that re-executes the user's own invocation with `stdio: 'inherit'`
- **WHEN** the guard test runs
- **THEN** it passes without `windowsHide`, because the child writes to the console it inherited

#### Scenario: A stopping daemon whose teardown fails still exits

- **GIVEN** a daemon asked to stop, whose teardown rejects
- **WHEN** the shutdown path settles
- **THEN** the process still exits, rather than leaving a live OS process behind after the client
  has been told the stop succeeded
