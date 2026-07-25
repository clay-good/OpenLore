# architecture spec delta

## ADDED Requirements

### Requirement: ReadPathsNeverDestroyTheIndex

Opening the persisted graph store on a read path SHALL never mutate or destroy it. A schema-version
mismatch encountered by a read SHALL yield a typed not-ready conclusion — disclosing that the index
was built by a different OpenLore version and naming the recovery command (`openlore analyze`) —
which consuming tools SHALL surface to the user rather than serving an empty graph. Destructive
schema migration (drop-and-rebuild) SHALL be permitted only on analyze/write paths that repopulate
the store in the same operation. A store reset or version mismatch SHALL be surfaced proactively
(doctor, and a one-line notice on the next tool call), not merely recorded in an internal flag.

#### Scenario: Upgrade followed by a read command preserves the index

- **GIVEN** an index built under a previous SCHEMA_VERSION
- **WHEN** the user runs a read command (orient, search, any MCP query) after upgrading OpenLore
- **THEN** the on-disk store is not modified
- **AND** the command returns the not-ready conclusion naming `openlore analyze`, never an empty
  result presented as current fact

#### Scenario: Analyze still rebuilds on schema bump

- **GIVEN** the same version-mismatched store
- **WHEN** `openlore analyze` runs
- **THEN** the store is dropped, rebuilt at the current schema, and repopulated in that operation

#### Scenario: The reset is disclosed before the user has to ask

- **GIVEN** a store in the not-ready (version-mismatch or quarantined) state
- **WHEN** the user runs `openlore doctor` or any MCP tool
- **THEN** doctor reports the state with the recovery command, and the tool response carries a
  one-line notice of it

### Requirement: CorruptGraphStoreQuarantineParity

A graph-store database that fails to open (corrupt, truncated, or otherwise unreadable) SHALL be
handled with the same discipline `CorruptStoreQuarantineNotSilentEmpty` mandates for the decision
store: the unreadable file (with its WAL/SHM siblings) is moved aside to a quarantine path
(`*.corrupt-<n>`, suffix derived from the next free on-disk index, claimed atomically so concurrent
loaders cannot overwrite each other's quarantine) and a recoverable signal is emitted. The caller
SHALL receive the same honest not-ready conclusion as a schema mismatch — never an uncaught crash,
and never a silently recreated empty store presented as a healthy index.

#### Scenario: A corrupt database is quarantined, not crashed on

- **GIVEN** a truncated or corrupt `call-graph.db`
- **WHEN** any command opens the graph store
- **THEN** the file is moved to the next free `*.corrupt-<n>` path and a recoverable signal is
  emitted
- **AND** the command returns the not-ready conclusion instead of throwing

#### Scenario: Concurrent loaders cannot lose preserved bytes

- **GIVEN** two processes opening the same corrupt store concurrently
- **WHEN** both attempt quarantine
- **THEN** exactly one atomic claim on the quarantine path succeeds and the corrupt bytes are
  preserved once; the other process observes the existing quarantine and returns not-ready

#### Scenario: No silent empty substitute

- **GIVEN** a quarantined graph store
- **WHEN** a read command runs before the next analyze
- **THEN** the result is the disclosed not-ready conclusion, never an empty graph served as if the
  codebase had no functions
