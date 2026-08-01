# openspec spec delta

## ADDED Requirements

### Requirement: MergeNeverDeletesHumanContent

In `writeMode: 'merge'`, the writer SHALL back up the file before writing (honoring
`createBackups`) and SHALL preserve human-authored content outside the generated section,
using a bounded generated-section boundary — it SHALL NOT truncate everything from the
generated marker to end-of-file.

#### Scenario: Appended notes survive a re-merge

- **GIVEN** a merged spec with human notes appended below the generated section
- **WHEN** the writer re-merges the spec
- **THEN** the appended notes are preserved and a backup of the prior file exists

### Requirement: DomainFilterDoesNotAuthorizeDeletion

A domain filter SHALL scope which specs are written, not authorize removing the domains it
excludes. Stale-domain cleanup SHALL be suppressed whenever a domain filter is active, and the
CLI `--force` behavior SHALL match its documented meaning.

#### Scenario: A scoped generate leaves other domains intact

- **GIVEN** a repo with many domains
- **WHEN** generation runs scoped to one domain with `force`
- **THEN** the other domain directories are left in place, not removed

### Requirement: StaleDomainCleanupIsRecursiveAndComplete

When stale-domain cleanup does run, its pre-removal backup SHALL be recursive so a domain
directory containing subdirectories is backed up completely, and a backup failure SHALL NOT be
silently swallowed as a missing-directory case leaving cleanup half-applied.

#### Scenario: A nested domain directory backs up fully

- **GIVEN** a stale domain directory that contains a subdirectory
- **WHEN** cleanup backs it up before removal
- **THEN** the whole directory is backed up and cleanup completes (or reports its failure),
  never half-aborting silently
