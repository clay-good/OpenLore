# analyzer spec delta

## ADDED Requirements

### Requirement: BulkChangesFallBackToOneRebuild

The incremental watcher SHALL load the internal node table at most once per batch (not once per
changed file) and SHALL fall back to a single full rebuild when a batch exceeds the bulk
threshold, disclosing the mode switch. Files whose closures are not incrementally recomputed
SHALL be marked stale (converge-or-flag preserved) — a bulk change SHALL NOT be left silently
under-analyzed, and SHALL NOT be processed file-by-file at a cost far exceeding a full analyze.

#### Scenario: A branch switch coalesces into one rebuild

- **GIVEN** a checkout that changes thousands of files
- **WHEN** the watcher processes the batch
- **THEN** it loads the node table at most once, delegates to a single full rebuild above the
  threshold, discloses the switch, and leaves no file silently stale
