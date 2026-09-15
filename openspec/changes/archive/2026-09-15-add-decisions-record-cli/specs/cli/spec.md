## ADDED Requirements

### Requirement: DecisionsCanBeRecordedFromTheCli

`openlore decisions record` SHALL record a draft architectural decision for the repository in the
current directory, with the same behavior as the `record_decision` MCP tool: the same decision id,
the same scope inference, the same anchors, the same "already decided" verdict for a decision that
consolidation has decided, and the same background consolidation. The command SHALL accept
`--title` and `--rationale` (both required), and `--consequences`, `--files` (comma-separated
paths), `--supersedes`, `--scope` (`local`, `component`, `cross-domain`, or `system`),
`--constraints-file` (a JSON constraint block), and `--json`. The command SHALL work whatever MCP
preset is wired. When the input is not valid or the handler returns an error, the command SHALL
write no draft and SHALL exit with a non-zero code.

Every CLI message that tells the user how to record a decision SHALL name
`openlore decisions record`. When `record_decision` is not part of the wired preset, the generated
agent guidance SHALL name `openlore decisions record` as the way to record a decision.

#### Scenario: Record a draft with default settings

- **GIVEN** a repository wired with the default MCP preset
- **WHEN** the user runs `openlore decisions record --title "Use UUIDs" --rationale "Collision-free ids"`
- **THEN** a draft decision is stored with that title and rationale
- **AND** the output names the draft id and the command that reads its verdict

#### Scenario: JSON output matches the MCP result

- **WHEN** the user runs the command with `--json`
- **THEN** stdout is one JSON object with the same fields the `record_decision` tool returns

#### Scenario: Missing rationale

- **WHEN** the user runs the command without `--rationale`
- **THEN** no draft is stored
- **AND** the command exits with a non-zero code and names the missing option

#### Scenario: Invalid scope or constraint file

- **WHEN** the user passes `--scope wide`, or a `--constraints-file` that is not valid JSON
- **THEN** no draft is stored and the command exits with a non-zero code

#### Scenario: Re-recording a decided decision

- **GIVEN** a decision that consolidation has already promoted, merged, or rejected
- **WHEN** the user records the same decision again
- **THEN** the output reports that verdict and no new draft is created

#### Scenario: Gate message names the command

- **WHEN** the decisions gate blocks a commit for an undocumented change
- **THEN** its message names `openlore decisions record`
- **AND** no CLI message names `openlore decisions --record`

#### Scenario: Guidance without the MCP tool

- **GIVEN** a repository whose wired preset does not include `record_decision`
- **WHEN** agent guidance is generated
- **THEN** the decisions section names `openlore decisions record`
