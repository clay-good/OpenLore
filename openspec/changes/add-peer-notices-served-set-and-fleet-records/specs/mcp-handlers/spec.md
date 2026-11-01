# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PeersAreToldWhenAServedSymbolChanges

When a live peer changes a symbol this session was served (by `orient` or `recall`), the next
`after-tools` receipt SHALL name the symbol, the peer, and when it was served. Fleet verification
records SHALL live in the board directory so every worktree of the clone reads them.

#### Scenario: A peer changes what I was served

- **GIVEN** a session that was served `parseConfig`, and a peer that then changes its body
- **WHEN** the session's next after-tools hook runs
- **THEN** the receipt names `parseConfig`, the peer, and the time it was served

#### Scenario: A fleet verdict is shared

- **GIVEN** a fleet verification record proved in worktree A
- **WHEN** worktree B reads fleet status
- **THEN** the record is visible
