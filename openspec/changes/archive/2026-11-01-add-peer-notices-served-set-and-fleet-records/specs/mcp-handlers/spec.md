# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PeersAreToldWhenAServedSymbolChanges

When a live peer on the footprint board changes a function that `orient` or `recall` served under
the hook's analysis root (in any session) within the board's live window, the next `after-tools`
receipt SHALL name the function, the peer, and when it was served, once per session per peer and
symbol, with the same attribution rule as a declared read: the peer's bases at declaration and now
still hold the served text. A symbol both declared and served SHALL be named once, as declared.

#### Scenario: A peer changes what I was served

- **GIVEN** a worktree where `orient` served `parseConfig`, and a peer that then changes its body
- **WHEN** the next after-tools hook runs in that worktree
- **THEN** the receipt names `parseConfig`, the peer, and the time it was served

#### Scenario: An old serve is quiet

- **GIVEN** a function served longer ago than a board entry lives without a refresh
- **WHEN** a peer changes it
- **THEN** no peer notice is printed
