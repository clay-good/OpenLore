# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PeerFootprintsAreSharedAcrossWorktrees

The system SHALL keep a board of live agent footprints in the clone's git common directory, so every
worktree of one clone reads the same entries with no network service. `declare_footprint` SHALL
record an entry (actor, worktree, branch, write-set and read-set resolved to symbols with their
content hashes, a title of at most 120 characters) and SHALL return the hazards between it and every
live peer entry, using the existing footprint and hazard classifier plus a `duplicate-intent` class
for two write-sets that create the same symbol name or file. `map_in_flight_conflicts` SHALL treat
live entries as agent task descriptors, and `fleet_status` SHALL list them. An entry SHALL end when
released, when its branch is merged or deleted, or when it is not refreshed within the session
expiry rule. Entry titles SHALL be redacted and withheld when instruction-shaped, and every peer field
SHALL be served as `local-unreviewed` data. Hazards SHALL be advisory unless `enforcement.policy`
names them blocking.

#### Scenario: Sibling worktrees see each other

- **GIVEN** two worktrees of one clone, where the agent in the first declares a write-set containing
  `parseConfig`
- **WHEN** the agent in the second declares a write-set containing `parseConfig`
- **THEN** the response reports a write-write hazard naming the first agent's worktree and branch

#### Scenario: Two agents about to write the same new function

- **GIVEN** a live entry whose write-set creates `normalizeUrl` in `src/url.ts`
- **WHEN** another agent declares a write-set creating `normalizeUrl` anywhere in the repository
- **THEN** a `duplicate-intent` hazard names both entries

#### Scenario: A landed branch leaves the board

- **GIVEN** a live entry for branch `feat-a`
- **WHEN** `feat-a` is merged and any agent reads the board
- **THEN** the entry is no longer live
