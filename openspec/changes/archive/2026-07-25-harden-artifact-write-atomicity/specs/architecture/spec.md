# architecture spec delta

## ADDED Requirements

### Requirement: ArtifactWritesAreAtomic

Every persisted analysis artifact (the JSON/Markdown/Mermaid set under the analysis output
directory, including `llm-context.json`) SHALL be written via a single shared atomic-write
discipline: write to a temp file in the same directory, then rename over the destination. At no
observable moment SHALL an artifact exist on disk in a truncated or partially written state — a
crash or kill mid-write leaves either the previous complete artifact or the new complete one.
The discipline SHALL have one implementation adopted by all writers (the analyze artifact
generator and the watcher's persist path alike), replacing per-site inline variants.

#### Scenario: A crash mid-write cannot tear the artifact

- **GIVEN** a writer persisting `llm-context.json` is killed partway through
- **WHEN** a reader (MCP cache load, CLI command) next opens the artifact
- **THEN** it parses a complete artifact — the previous or the new version — and never falls back
  to "re-run analyze" because of a truncated file

#### Scenario: One atomic-write implementation, all writers

- **GIVEN** the analyze artifact generator and the watcher both persist artifacts
- **WHEN** either writes any artifact in the set
- **THEN** the write goes through the shared same-directory temp + rename helper, not a bare
  `writeFile`

### Requirement: ConcurrentArtifactWritersSerialize

Concurrent writers of the analysis artifact set (a running watcher's persist and a full `analyze`
— including the watcher's own self-heal spawn) SHALL serialize their artifact-write critical
sections behind a cross-process advisory lock reusing the decision store's established lock shape
(exclusive-create lock file, stale-lock steal, bounded wait, best-effort proceed on timeout) with
its existing constants — no new locking mechanism and no new tuning values. A lost update between
the two writers is a defect; overlap resolves to one writer's complete output followed by the
other's.

#### Scenario: Watcher self-heal does not race the watcher

- **GIVEN** a watcher that has spawned a detached `analyze --force` while continuing to serve and
  persist
- **WHEN** both processes reach their artifact-write sections
- **THEN** the lock serializes them; the final on-disk artifact set is one writer's complete,
  self-consistent output — never an interleaving of the two

#### Scenario: A crashed lock holder does not wedge analysis

- **GIVEN** a writer that died holding the analysis lock
- **WHEN** the next writer arrives after the stale threshold
- **THEN** it steals the lock and proceeds, matching the decision store's documented recovery
  behavior
