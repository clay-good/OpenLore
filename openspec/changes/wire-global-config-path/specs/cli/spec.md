# cli spec delta

## ADDED Requirements

### Requirement: ExplicitConfigPathIsHonored

When the user passes the global `--config <path>` option on the command line, OpenLore SHALL read
(and, for commands that persist config, write) the current project's configuration from that path,
not from the default `<root>/.openlore/config.json`. The redirection applies only to the config
file for the primary invocation root; the `.openlore/` artifact directory is unchanged, and reads of
other repositories' configs (federation / spec-store peers) are never redirected. When `--config` is
not passed, resolution is byte-identical to the default.

#### Scenario: An explicit config path is read

- **GIVEN** a readable config file at `/elsewhere/config.json` and a project whose
  `.openlore/config.json` differs (or is absent)
- **WHEN** a command runs with `openlore --config /elsewhere/config.json …`
- **THEN** the command reads its configuration from `/elsewhere/config.json`

#### Scenario: The default is unchanged

- **GIVEN** no `--config` on the command line
- **WHEN** any command resolves configuration
- **THEN** it reads `<root>/.openlore/config.json` exactly as before

#### Scenario: Peer configs are not redirected

- **GIVEN** an explicit `--config` for the primary root
- **WHEN** a federation or spec-store operation reads a *different* repository's config
- **THEN** that peer read resolves to the peer's own `.openlore/config.json`, unaffected by the flag
