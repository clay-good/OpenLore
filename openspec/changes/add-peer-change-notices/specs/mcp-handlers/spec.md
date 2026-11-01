# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PeersAreToldWhenASymbolTheyReadChanges

Each session SHALL publish the content hashes of symbols it edits to the board. When a peer's edit
changes a symbol in this session's declared read-set or served set, the next after-tools receipt
SHALL name the symbol, the peer's worktree, and when this session read it, as a neutral fact. An edit
to a symbol outside both sets SHALL produce no notice.

#### Scenario: A peer changes what I read

- **GIVEN** a session that was served `parseConfig`, and a peer in another worktree that then changes
  `parseConfig`'s body
- **WHEN** the session's next after-tools hook runs
- **THEN** the receipt names `parseConfig`, the peer's worktree, and the time it was served

#### Scenario: Unrelated peer work is quiet

- **GIVEN** a peer that edits only symbols this session never read or declared
- **WHEN** the session's next after-tools hook runs
- **THEN** no peer notice is printed
