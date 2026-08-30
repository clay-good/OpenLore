# Tasks — scale-analyze-to-workspace-shards

## Implementation

- [x] Detect npm/yarn/pnpm, Cargo, Go, Python, Gradle, and Maven shard roots deterministically.
- [x] Support `workspace.shards` as a schema-validated override.
- [x] Assign the filtered corpus totally; most-specific root wins and unmatched files use `root`.
- [x] Preserve the legacy single-root full-analysis path and artifact set.
- [x] Add repeatable `analyze --shard <name>` with fatal unknown-name candidates.
- [x] Recompute stored-edge, external-name, and name-multiplicity frontier classes.
- [x] Seed resolution with retained internal nodes so unselected callees remain internal.
- [x] Replace selected/frontier SQLite rows under the analysis lock without `clearAll()`.
- [x] Mark budgeted-out or unreadable frontier files in the existing stale-region store.
- [x] Retain repo-wide artifacts and the full fingerprint during scoped runs.
- [x] Recompute the whole-graph attestation after scoped publication.
- [x] Persist per-shard timestamps, fingerprints, freshness, frontier, and stale receipts.
- [x] Disclose no-index and `--force` full-rebuild behavior.
- [x] Document CLI, configuration, CI, and known-limitations behavior.

## Verification

- [x] Detection tests cover every ecosystem, overlaps, configured overrides, root assignment, and
      outside-root refusal.
- [x] External-name rebinding pulls an outside consumer into the frontier.
- [x] A unique-to-ambiguous name flip matches a whole-repository cold rebuild.
- [x] Untouched shard nodes survive a scoped update.
- [x] A bounded-out frontier is marked stale and reported.
- [x] Core integration proves repo-wide JSON artifacts and the full fingerprint remain byte-identical.
- [x] No-index shard selection performs and discloses a full build.
- [x] Full unit/integration suite, lint, typecheck, build, strict OpenSpec validation.
