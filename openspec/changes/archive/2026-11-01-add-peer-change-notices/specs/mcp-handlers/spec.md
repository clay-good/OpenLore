# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PeersAreToldWhenASymbolTheyReadChanges

When a live peer on the footprint board changes a symbol in the read-set this worktree's agent
declared (`declare_footprint`), the next `after-tools` receipt SHALL name the symbol, its file, the
peer's actor, branch, and worktree, and when the read-set was declared, as a neutral fact, once per
session. The change SHALL be computed from the board and the peer's working tree, with no message
transport: the declared text no longer holds in the peer's tree, and the peer's base commit at
declaration still held it, so a peer that only branched from an older version is not blamed. An
edit to a symbol outside the declared read-set SHALL produce no notice.

#### Scenario: A peer changes what I read

- **GIVEN** an agent that declared reading `parseConfig`, and a peer in another worktree that then
  changes `parseConfig`'s body
- **WHEN** the agent's next after-tools hook runs
- **THEN** the receipt names `parseConfig`, its file, the peer's actor, branch, and worktree, and
  the declaration time

#### Scenario: Unrelated peer work is quiet

- **GIVEN** a peer that edits only symbols this agent did not declare reading
- **WHEN** the agent's next after-tools hook runs
- **THEN** no peer notice is printed

#### Scenario: An older base is not a change

- **GIVEN** a peer whose base commit predates this agent's version of a declared symbol, and who has
  not edited it
- **WHEN** the agent's next after-tools hook runs
- **THEN** no peer notice is printed
