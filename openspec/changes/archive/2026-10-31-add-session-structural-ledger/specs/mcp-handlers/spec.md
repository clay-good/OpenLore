# mcp-handlers spec delta

## ADDED Requirements

### Requirement: LeaseNamesBackgroundChangesToServedSymbols

A session SHALL be one MCP server process. Hook commands, which run as separate processes, SHALL
read the ledger of the single live server for their worktree and SHALL withhold ledger facts, with
the reason in `openlore status`, when there is no such server or more than one.

The system SHALL record, per MCP server session, the address and normalized content hash of each
symbol it serves through `orient`, `get_function_skeleton`, `get_subgraph`, and the top hits of
`search_code`, and of each spec file a briefing names. An edit SHALL count as the agent's own when
the harness's after-edit hook reported its file to the worktree's agent-edit log after the symbol
was served. When a served symbol's current content hash differs from its served hash and the change
is not the agent's own, the next tool response SHALL carry a neutral factual note naming at most
three such symbols (address, file, and the time it was served) and counting the rest, each change
stated once. The note SHALL follow the existing lease placement and neutral-wording rules and SHALL
NOT block or instruct the agent. When no after-edit hook has reported an edit in the session, the
agent's own edits cannot be told apart, so the note SHALL be withheld and `openlore status` SHALL
state the reason. A symbol that cannot be hashed SHALL be counted as untracked, never reported as
unchanged. Only addresses and hashes SHALL be stored, never file contents.

#### Scenario: Another process edits a symbol the agent read

- **GIVEN** a session that was served `parseConfig` by `orient`, and a second process that then
  changes `parseConfig`'s body
- **WHEN** the agent makes its next tool call
- **THEN** the response carries a factual note naming `parseConfig`, its file, and when it was served

#### Scenario: The agent's own edit is not reported as background

- **GIVEN** a session that was served `parseConfig` and then edited it, with the after-edit hook
  reporting the edited file
- **WHEN** the agent makes its next tool call
- **THEN** no background-change note names `parseConfig`

#### Scenario: A reformat is not a change

- **GIVEN** a served symbol whose file is only re-indented by another process
- **WHEN** the agent makes its next tool call
- **THEN** no note names the symbol

### Requirement: EditOscillationIsObservedFromContentHashes

The system SHALL keep, per session, the sequence of normalized content hashes each symbol takes
in files the watcher re-indexes (or, when the watcher runs in another process, at each tool call,
disclosed as sampled), and SHALL report an edit oscillation when a symbol takes, for the
second time in the session, a hash it already had earlier in that session (A → B → A → B is two
returns and is reported; A → B → A is one and is not). The report SHALL name
the symbols and the hash cycle, SHALL be stated as a neutral fact in the freshness note, SHALL be
an input to the panic layer, and SHALL be exposed as data in `openlore status --json` and the
`panic-check` hook output. No weighted score SHALL be introduced, and only the existing opt-in
blocking mode may act on the signal.

#### Scenario: A modify-revert loop is reported

- **GIVEN** a symbol edited from version A to B, back to A, and to B again in one session
- **WHEN** the watcher records the last edit
- **THEN** the freshness note states the symbol returned to an earlier version twice, and the
  status output lists it with its hash cycle

#### Scenario: Forward progress is not a loop

- **GIVEN** a symbol edited A → B → C → D
- **WHEN** the watcher records each edit
- **THEN** no oscillation is reported
