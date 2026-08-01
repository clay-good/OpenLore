# mcp-handlers spec delta

## ADDED Requirements

### Requirement: TeamMemoryIsPromotedThroughReview

The system SHALL support a repo-tracked team memory store of one canonical-JSON file per memory,
written only by an explicit local promote operation that copies a local memory verbatim — stable
id, anchors, and content hash unchanged — and never commits on the user's behalf: the human gate
is the repository's own review process. The promote operation SHALL run the secret-redaction scan
over the memory content and refuse promotion on findings, with the findings disclosed. The
`recall` tool SHALL merge the local and team stores, label every served memory's tier, and apply
identical freshness verdicts, orphan handling, and rename carry-forward to both tiers. A local
and a team memory in contradiction on the same anchor SHALL surface through the existing
unreconciled disclosure with both tiers named, never resolved silently. A malformed team-store
file SHALL be skipped with disclosure, never crash the read path or silently shrink the store.

#### Scenario: Promotion is verbatim and idempotent

- **GIVEN** a local memory with id M
- **WHEN** it is promoted twice
- **THEN** the team store contains exactly one file for M, byte-identical across both runs, with
  id, anchors, and content hash equal to the local record
- **AND** no git commit was made by the tool

#### Scenario: A secret blocks promotion

- **GIVEN** a local memory whose content contains a value the redaction scanner flags
- **WHEN** promote runs
- **THEN** promotion is refused and the finding is disclosed; the team store is unchanged

#### Scenario: Recall serves both tiers with honest arbitration

- **GIVEN** a team memory and a contradicting local memory anchored to the same symbol
- **WHEN** `recall` runs
- **THEN** both are surfaced as unreconciled with their tiers labeled, and neither is served as
  the silently authoritative one

#### Scenario: A teammate's clone inherits the memory with live freshness

- **GIVEN** a fresh clone containing the team store and no local store
- **WHEN** the repo is analyzed and `recall` runs
- **THEN** team memories are served with tier `team` and current anchor-freshness verdicts, and a
  renamed anchor is carried across with its provenance disclosed
