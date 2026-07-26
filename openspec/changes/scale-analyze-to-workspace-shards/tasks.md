# Tasks — scale-analyze-to-workspace-shards

> Sequencing: land after the pipeline-cost work (`optimize-parallel-extraction-pool` shipped,
> `optimize-analyze-pipeline-passes`, `optimize-incremental-and-coldstart-scale`). Those reduce
> the cost per file; this reduces the file count and amortizes the rest.

## Implementation

- [ ] `src/core/analyzer/workspace-shards.ts`: manifest-only shard detection (npm/pnpm/yarn
      `workspaces`, Cargo `members`, Go modules, `pyproject.toml`, Gradle/Maven modules);
      deterministic membership + ordering; most-specific-root wins for overlaps
- [ ] `workspace.shards` config override + schema-validator field entry; report whether shards
      were detected or configured
- [ ] Single-shard fallback: no manifests ⇒ one shard ⇒ today's exact code path
- [ ] File walker + analyze pipeline take a shard selection; `openlore analyze --shard <name>`
      (repeatable) and diff-derived automatic shard selection
- [ ] Cross-shard frontier re-resolution in the call-graph builder: recompute edges whose caller
      or callee lies in a recomputed shard; retain everything else untouched
- [ ] Converge-or-flag at shard granularity: anything unreconciled is marked explicitly stale via
      the existing stale-region machinery (never left divergent, never silently narrowed)
- [ ] Per-shard attestation + freshness in the store; `openlore status` shows per-shard state
- [ ] Scoped-analyze report: shards recomputed / retained, frontier size, stale regions
- [ ] `pass1-fact-cache.ts`: export/import of the content-addressed entries into one archive;
      validate content-hash key + extractor-purity stamp + schema version per entry, ignoring and
      recomputing anything that fails (reuse the `.olbundle` validate-or-rebuild trust posture)
- [ ] `openlore cache export|import` CLI (+ `--json`), with accepted/rejected counts and reasons
- [ ] CI recipe in `docs/ci-cd.md` restoring the archive as an ordinary build-cache artifact

## Verification

- [ ] Detection tests per ecosystem, incl. nested/overlapping roots and the most-specific rule
- [ ] Single-package equivalence: byte-identical graph and artifacts vs. the pre-change build
- [ ] **Shard equivalence (the central test):** multi-package fixture, change confined to one
      package; the shard-scoped graph over that shard and its frontier equals the
      `analyze --force` graph
- [ ] Non-amputation test: symbols and edges of un-recomputed shards survive; no cross-shard call
      is downgraded to `external::` merely because the callee's shard was not recomputed
- [ ] Unreconcilable-frontier test: the region is marked stale, reported, and non-authoritative in
      freshness verdicts
- [ ] Cache portability: export → import on a second workspace ⇒ analyze output byte-identical to
      cold; accepted/rejected counts reported
- [ ] Trust tests: mismatched purity stamp, mismatched schema version, corrupt archive,
      hash-mismatched entry — each ignored-and-recomputed, never served, never fatal
- [ ] Bypass test: the existing fact-cache bypasses also bypass an imported cache
- [ ] Scale measurement: analyze wall-clock on a large multi-package fixture, full vs. one-shard
      vs. warm-cache, recorded in `scripts/BENCHMARKS.md` (measured, not asserted)
- [ ] Full suite green; docs updated (`cli-reference.md`, `ci-cd.md`, `configuration.md`)
