# cli spec delta

## ADDED Requirements

### Requirement: PortableGraphArtifactExportImport

The system SHALL provide CLI verbs to export the persisted graph index as a single portable,
self-describing artifact and to import that artifact into another checkout without re-analyzing. The
exported artifact SHALL bundle the graph together with its integrity attestation — the index schema
version, the source commit it was built from, the committed artifact counts, and the content digest —
so a consumer can validate it before relying on it. Export SHALL be a byte-stable function of the index
it serializes: exporting the same index twice produces an identical artifact. Export and import SHALL be
local, offline, and deterministic, requiring no network service or registry. Default single-machine
operation SHALL be unchanged; sharing is opt-in.

#### Scenario: A clean checkout bootstraps from a shared artifact

- **GIVEN** a graph artifact exported at commit C and a fresh checkout of the same repository at commit C
- **WHEN** the artifact is imported
- **THEN** the local index is materialized without re-analyzing, and it is identical to the index a
  fresh local analyze at commit C would produce

### Requirement: ValidateOrRebuildOnArtifactImport

Import SHALL be safe by construction: the consumer SHALL validate an artifact before trusting it and
SHALL NOT serve a stale, schema-mismatched, or tampered artifact as current. Validation SHALL reject an
artifact whose index schema version is incompatible with this OpenLore (`mismatched`), and reject an
artifact whose content digest does not match its bundled attestation (corrupt or hand-edited). When the
artifact's source commit matches the working tree, it SHALL be imported as-is; when it is stale (built
at an ancestor commit), the consumer SHALL either incrementally update only the files changed since or
fall back to a full local rebuild — never serve the stale artifact as if current. Any validation
failure SHALL degrade transparently to a local rebuild, so import never leaves the consumer worse off
than having no artifact.

#### Scenario: A stale artifact is updated, not served as current

- **GIVEN** an artifact built at an ancestor commit and a working tree several commits ahead
- **WHEN** the artifact is imported
- **THEN** the index is brought current by incrementally updating the changed files (or by a full
  rebuild), and the resulting index matches a fresh analyze at the working-tree commit — the stale graph
  is never served as current

#### Scenario: A schema-incompatible or tampered artifact is rejected

- **GIVEN** an artifact whose schema version is incompatible, or whose content digest does not match its
  attestation
- **WHEN** it is imported
- **THEN** import rejects it as `mismatched` and falls back to a local rebuild rather than loading it

### Requirement: ConflictFreeGeneratedArtifactDiscipline

When a team commits the graph artifact to share it, the artifact SHALL be treated as a generated,
regenerate-on-divergence file rather than a hand-mergeable one. The change SHALL document and
tooling-support a git attribute that prevents line-merging the artifact, and the canonical resolution
for a divergence SHALL be re-exporting at the merge commit, never a manual merge. A hand-merged artifact
SHALL NOT be trusted: the import-time integrity check SHALL reject it as `mismatched` on the basis of its
content digest, independent of how the divergence was produced.

#### Scenario: A divergent artifact is regenerated, not line-merged

- **GIVEN** two branches that each re-exported the committed graph artifact, producing a git divergence
- **WHEN** the branches are merged following the documented discipline
- **THEN** the resolution is to re-export the artifact at the merge commit, and git does not attempt a
  line-by-line merge of the generated artifact

#### Scenario: A hand-merged artifact fails the integrity check

- **GIVEN** an artifact that was manually line-merged
- **WHEN** it is imported
- **THEN** its content digest does not match its attestation and it is rejected as `mismatched`, falling
  back to a local rebuild
