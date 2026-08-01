# Analyzer — CFG overlay memory buffering

## ADDED Requirements

### Requirement: CfgOverlayBuffersInMemoryAndOverflowsToDiskPastAThreshold

The CFG/def-use overlay produced during the call-graph build SHALL accumulate in memory and spill to
a file ONLY once its accumulated size exceeds a fixed threshold. Below the threshold no file is
created, so a repository whose overlay fits in memory pays no disk round-trip; past it, peak
residency is bounded to the threshold plus one write batch. The rows drained into `cfg_overlay` SHALL
be byte-identical whether the overlay stayed in memory or overflowed to disk.

#### Scenario: A small overlay never touches the disk

- **WHEN** a build's overlay stays under the overflow threshold
- **THEN** no spill file is created under the output directory
- **AND** the overlay is drained into `cfg_overlay` directly from memory

#### Scenario: A large overlay overflows and stays bounded

- **WHEN** a build's overlay exceeds the overflow threshold
- **THEN** the buffered rows are written to a file and every subsequent row streams to that file
- **AND** the overlay is drained back from the file, holding no more than one read chunk at a time

#### Scenario: The two paths agree byte-for-byte

- **WHEN** the same set of function CFGs is spilled entirely in memory and, separately, forced to
  overflow to disk
- **THEN** the rows drained from each path are identical in order and content

### Requirement: CfgOverlayOverflowFailsClosedAndAtMostOnce

An overflow that cannot be written SHALL fail closed rather than fail the analysis: the overlay is an
optional precision refinement, so a spill that cannot reach the disk degrades to a disclosed
function-granularity answer. The overflow SHALL be attempted at most once — a failed overflow latches
an inert state and no subsequent write reopens the file — and any partially written file SHALL be
removed so no truncated spill is left for the drain or the bundle exporter to find.

#### Scenario: An unwritable directory does not fail the build

- **WHEN** the overlay overflows but the file cannot be opened or written
- **THEN** the spill latches a failed state without throwing
- **AND** the overlay is skipped by the consumer, which reports the disclosed fallback

#### Scenario: A failed overflow is never retried

- **WHEN** an overflow has already failed
- **THEN** further writes are inert and do not reopen the file or accumulate rows
