# cli spec delta

## ADDED Requirements

### Requirement: InstallWiresEveryFutureRepoByDefault

Bare `openlore install` SHALL, by default and with no flags, register the MCP server, the
orientation hooks, and the agent-instruction block at the *user* scope for every adapter that
supports one, using the same managed, marker-identified entries as per-repo install — and,
when run inside a git repository, SHALL additionally wire and index that repository
immediately. After one install, opening any git repository with a wired agent SHALL reach
the MCP server and trigger the existing background cold-start bootstrap without any further
command, ever. An adapter with no user scope SHALL fall back to per-repo wiring with an
honest note, never a failure. `--repo-only` SHALL confine wiring to the current repository;
repo-scope managed entries SHALL take precedence over user-scope entries where both exist;
and `--uninstall` SHALL remove only OpenLore-managed entries from both scopes.

#### Scenario: One command, then every repo just works

- **GIVEN** a user who ran bare `openlore install` once, anywhere
- **AND** a git repository that has never seen an OpenLore command
- **WHEN** the agent opens that repository and issues its first directory-bearing tool call
- **THEN** the MCP server is reachable and the cold-start bootstrap builds the index in the
  background, and the first response carries a one-line first-touch disclosure

#### Scenario: Scope control remains for those who want it

- **GIVEN** a user who runs `openlore install --repo-only` in a repository
- **WHEN** the command completes
- **THEN** only that repository is wired, no user-scope entry is written, and the summary
  says so

#### Scenario: Unsupported adapter degrades honestly

- **GIVEN** an adapter with no user-scope configuration surface
- **WHEN** the user runs bare `openlore install`
- **THEN** the summary lists that adapter as wired per-repo only (or skipped outside a
  repo) with one explanatory line, and the command exits 0

### Requirement: AutoInitIsConsentGuarded

Background auto-initialization SHALL apply only to git work trees; SHALL be suppressible per
repo (`autoInit: false` in `.openlore/config.json`) and per environment
(`OPENLORE_NO_AUTO_ANALYZE`); SHALL disclose its first run in a repo with a single
non-blocking notice naming what was built and how to opt out; and SHALL degrade to a
signatures/keyword-only build with an explicit degradation disclosure above a file-count
ceiling. Auto-init SHALL never block a tool call, never write outside the repo's `.openlore`
directory and the user-level cache, and never run twice concurrently for one repo.

#### Scenario: Non-repo directory is never indexed

- **GIVEN** a directory-bearing tool call whose directory is not inside a git work tree
- **WHEN** the cold-start bootstrap evaluates it
- **THEN** no analysis is started and the response carries the ordinary not-ready guidance

#### Scenario: Opted-out repo stays untouched

- **GIVEN** a repo whose `.openlore/config.json` sets `autoInit: false`
- **WHEN** any tool call arrives before an index exists
- **THEN** no background build starts and the not-ready conclusion names the opt-out as the
  reason with the one manual command to build

## MODIFIED Requirements

### Requirement: ZeroInteractionOnboarding

The zero-interaction path SHALL extend from "one command per repo" to "one command per
user": the postinstall hint SHALL stay exactly `openlore install` (which now wires the user
scope by default), and every repo wiring — explicit or auto-init — SHALL include the
decisions pre-commit hook in autopilot (non-blocking, trail-only) mode once decision
autopilot exists, so the single entrypoint yields both the navigation face and the
governance trail with no additional command or flag. Blocking review mode SHALL remain an
explicit opt-in. All existing zero-interaction behavior (CI/TTY-guarded postinstall,
non-blocking cold-start build, `connect --yes`, passive update notifier) is unchanged.

#### Scenario: Installing the package does not touch the project

- **GIVEN** a user runs `npm install -g openlore` (or `npm install openlore`)
- **WHEN** the install completes
- **THEN** no project file is created or modified and no index is built by the install itself
- **AND** at most a single next-step hint is printed, suppressed in CI / non-TTY / opt-out / dependency contexts
- **AND** the post-install step exits 0 regardless

#### Scenario: Connect is non-interactive with --yes

- **GIVEN** a project with a detectable agent and no TTY picker desired
- **WHEN** `openlore connect --yes` runs
- **THEN** every detected agent is wired with no prompt, idempotently, preserving existing content

#### Scenario: One entrypoint yields both faces

- **GIVEN** a repo with no OpenLore state
- **WHEN** the user runs `openlore install`
- **THEN** agents are wired, the index builds, and the decisions hook is installed in
  autopilot mode — and no subsequent commit is blocked by default
