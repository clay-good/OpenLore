# cli spec delta

## ADDED Requirements

### Requirement: InstallWiresEveryFutureRepoByDefault

Bare `openlore install` SHALL, by default and with no flags, register the MCP server, the
orientation hooks, and the agent-instruction block at the *user* scope for every adapter that
supports one — selected by that CAPABILITY, not by whether the adapter's markers happen to be
present in the current directory — using the same managed, marker-identified entries as
per-repo install; an explicit `--agent`/`--agents` SHALL narrow both scopes, on install and on
uninstall alike. When run inside a git repository it SHALL additionally wire and index that
repository immediately. After one install, opening any git repository with a wired agent SHALL reach
the MCP server and trigger the existing background cold-start bootstrap without any further
command, ever. An adapter with no user scope SHALL fall back to per-repo wiring with an
honest note, never a failure. `--repo-only` SHALL confine wiring to the current repository, and
`--uninstall` SHALL remove only OpenLore-managed entries from both scopes. Where both scopes
are wired, the agent's own resolution decides what runs — for Claude Code, one MCP server by
name, but BOTH scopes' hooks and instruction blocks — and the documentation SHALL state that
plainly rather than implying the repo scope supersedes the user scope.

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

#### Scenario: A user-scope config OpenLore does not own is never lost

- **GIVEN** a user-scope configuration file that another agent owns and writes
- **WHEN** install would write it, and it does not parse as JSON, is a symbolic link, or has
  changed since OpenLore read it
- **THEN** OpenLore refuses that write, names the cause, leaves the file exactly as it was, and
  writes no instruction block claiming a registration it did not make — and the command still
  wires the current repository and exits 0

#### Scenario: Unsupported adapter degrades honestly

- **GIVEN** an adapter with no user-scope configuration surface
- **WHEN** the user runs bare `openlore install`
- **THEN** the summary lists that adapter as wired per-repo only (or skipped outside a
  repo) with one explanatory line, and the command exits 0

### Requirement: AutoInitIsConsentGuarded

Background auto-initialization SHALL apply only to git work trees; SHALL be suppressible per
repo (`autoInit: false` in `.openlore/config.json`) and per environment
(`OPENLORE_NO_AUTO_ANALYZE`); SHALL disclose its first run in a repo with a single
non-blocking notice naming what was built, where it landed, and how to opt out; and SHALL
degrade to a signatures/keyword-only build with an explicit degradation disclosure above a
file-count ceiling. Auto-init SHALL never block a tool call, never write outside the repo's
`.openlore` directory and the user-level cache, and never run twice concurrently for one repo.
Auto-init SHALL NOT install a git hook: writing executable repository configuration into a
repository the user has run no command in is a different consent class from building a local
index, and a one-line disclosure in a tool response is not consent for it. The commit gate is
wired by an explicit `openlore install` only.

#### Scenario: Non-repo directory is never indexed

- **GIVEN** a directory-bearing tool call whose directory is not inside a git work tree
- **WHEN** the cold-start bootstrap evaluates it
- **THEN** no analysis is started and the response carries the ordinary not-ready guidance

#### Scenario: Opted-out repo stays untouched

- **GIVEN** a repo whose `.openlore/config.json` sets `autoInit: false`
- **WHEN** any tool call arrives before an index exists
- **THEN** no background build starts and the not-ready conclusion names the opt-out as the
  reason with the one manual command to build

#### Scenario: Auto-init installs no git hook

- **GIVEN** a git repository the user has run no OpenLore command in
- **WHEN** background auto-init builds its index
- **THEN** no pre-commit or post-commit hook is written; the decision trail is wired only by an
  explicit `openlore install` in that repository

## MODIFIED Requirements

### Requirement: ZeroInteractionOnboarding

The onboarding path SHALL reach a working setup with no required user interaction and without modifying
the user's project on package install. Installing the package (`npm install`) SHALL NOT analyze, write
configuration, or modify any project file; it MAY print a single non-interactive next-step hint, and
that hint SHALL be suppressed in CI, in non-interactive (non-TTY) contexts, when opted out via
`OPENLORE_SKIP_POSTINSTALL`, and when the package is installed as a transitive dependency. The
post-install step SHALL always exit 0 and SHALL never fail an install.

The setup commands SHALL offer a fully non-interactive path: `openlore install` SHALL auto-detect agent
surfaces and wire them with no prompt, and `openlore connect --yes` SHALL wire every detected agent
without the interactive picker. These wiring operations SHALL remain idempotent and SHALL preserve
user-authored content (merge, not clobber).

The zero-interaction path SHALL further extend from "one command per repo" to "one command per
user": the postinstall hint SHALL stay exactly `openlore install` (which now wires the user
scope by default), and every EXPLICIT repo wiring SHALL include the decisions pre-commit hook,
so the single entrypoint yields structural navigation and the governance trail with no
additional command or flag. Autopilot (non-blocking, trail-only) mode SHALL be set only when
install wires a gate for the FIRST time in a repository: an absent `governance.autopilot` means
blocking review, so a repository that already carries an OpenLore commit gate SHALL keep the
mode it was configured with, and an explicit `governance.autopilot: false` SHALL never be
flipped. Install SHALL skip the gate entirely, with a stated reason and without failing, when
OpenLore resolves inside the repository — a commit gate must not execute code the repository
can change.

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

#### Scenario: Wiring preserves user-authored content

- **GIVEN** a project whose `CLAUDE.md`, `.mcp.json`, or `.claude/settings.json` already holds
  content OpenLore did not write
- **WHEN** `openlore install` runs, at either scope, once or repeatedly
- **THEN** only OpenLore-managed entries are added or updated, everything else is preserved
  byte-for-byte, and a re-run with nothing to change writes nothing

#### Scenario: One entrypoint yields navigation and a decision trail

- **GIVEN** a repo with no OpenLore state
- **WHEN** the user runs `openlore install`
- **THEN** agents are wired, the index builds, and the decisions hook is installed in
  autopilot mode — and no subsequent commit is blocked by default

#### Scenario: An existing commit gate keeps its mode

- **GIVEN** a repository that already carries an OpenLore decisions commit gate, configured
  for blocking human review
- **WHEN** `openlore install` runs there again for any reason
- **THEN** the gate is refreshed but its mode is unchanged, and the run says so
