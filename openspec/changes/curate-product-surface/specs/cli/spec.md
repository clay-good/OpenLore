# cli spec delta

## ADDED Requirements

### Requirement: SkillsHaveOneSourceOfTruth

Each skill SHALL have one source file in the repository, `skills/<name>/SKILL.md`. The root of
`skills/` SHALL hold only skill folders. `openlore setup` and the Pi package entry SHALL read
skills from that folder only.

#### Scenario: A loose file beside the folders

- **WHEN** a Markdown file is added at the root of `skills/`
- **THEN** the skill guard test fails and names the file

#### Scenario: A second copy under examples

- **WHEN** a `SKILL.md` is added under `examples/opencode-skills/` or `examples/mistral-vibe/skills/`
- **THEN** the skill guard test fails

#### Scenario: Setup is unchanged

- **WHEN** a user runs `openlore setup` for Claude Code, OpenCode or Mistral Vibe
- **THEN** the same 10 skills are installed from `skills/<name>/SKILL.md`

### Requirement: PublishedPackageShipsOnlyReferencedFiles

The published npm package SHALL contain an `examples/` folder only when `openlore setup` installs
from it or a page under `docs/` names it. The package SHALL NOT contain test files from
`examples/`.

#### Scenario: An unreferenced example folder

- **WHEN** an example folder that no installer and no doc names is added to the package file list
- **THEN** the pack-list audit fails and names the folder

#### Scenario: Example tests stay in the repository

- **WHEN** the package is packed
- **THEN** no file that matches `examples/**/*.test.*` is in the pack list

### Requirement: PlumbingCommandsAreHiddenFromTopLevelHelp

Commands that only a harness hook or a status line runs SHALL NOT appear in `openlore --help`.
They SHALL stay registered, SHALL run as before, and SHALL answer `openlore <name> --help`. Every
other registered command SHALL appear under a named job group.

#### Scenario: Top-level help

- **WHEN** a user runs `openlore --help`
- **THEN** `hook`, `statusline`, `check-edit`, `panic-check` and `panic-level` are not listed
- **AND** `status`, `mapping` and `handoff` are listed under a job group, not under "Other"

#### Scenario: A hidden command still runs

- **WHEN** an installed hook runs `openlore hook before-edit`
- **THEN** the command runs and exits as it did before it was hidden

#### Scenario: A new command without a group

- **WHEN** a command is registered that is in no job group and not in the hidden list
- **THEN** the help guard test fails and names the command

### Requirement: RemovalsNameTheirReplacement

A change that removes a shipped skill, example, or documentation page SHALL name the replacement
in the changelog. A tracked Markdown link in the README, `docs/`, `examples/` or `skills/` SHALL
NOT point at a file that does not exist.

#### Scenario: A removed doc is still linked

- **WHEN** a documentation page is deleted and another page still links it
- **THEN** the link check test fails and names the file and the broken link

#### Scenario: A removed skill copy

- **WHEN** the skill copies under `examples/` are removed
- **THEN** the changelog entry and a `README.md` in each former folder name `skills/<name>/SKILL.md`
