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
- [ ] Cross-shard frontier = THREE classes, not one. (1) stored edges touching a recomputed shard
      (incl. external-leaf callees); (2) outside files with a previously-external call site whose
      name the recompute ADDS; (3) outside files with a name-only call site whose name's
      definition MULTIPLICITY the recompute changes (unique→ambiguous or back). (2) and (3) are
      derived from the added/removed symbol-name diff — they are NOT expressible from the stored
      edge set. Reuse the watcher's Class-P closure machinery (`mcp-watcher.ts:576-612`)
- [ ] Non-destructive write path: today `artifact-generator.ts:1589` calls `store.clearAll()`
      UNCONDITIONALLY (`edge-store.ts:1104-1106` drops nodes/edges/classes/fts/file_hashes/cfg/
      stale_files). A partial analyze needs the watcher's per-file deletion primitives
      (`deleteNodesForFile`, `VectorIndex.updateFiles`, `refreshAttestationCounts`) under the
      analyze lock — and note `writeEdgesToSQLite` currently sits OUTSIDE `withAnalysisLock`
- [ ] Reconcile with `harden-analyze-rebuild-atomicity` (one full rebuild at a time) — N partial
      writers into one store must not reintroduce the interleaving that change removes
- [ ] Repo-wide artifact policy (digest, repo-structure, llm-context, dep graph, parse-health,
      bm25 corpus, vocabulary lexicon, dynamic-boundary sidecar, vector index, text-line index):
      re-aggregate from the PERSISTED graph or retain-and-report — never rebuild from shard-local
      input. Note `VectorIndex.build` uses `mode:'overwrite'` on the whole table
- [ ] Attestation: recompute or explicitly invalidate the whole-graph digest after a partial
      write; a narrowed graph must never reconcile as `healthy`
- [ ] Per-shard freshness: do NOT write the repo-wide fingerprint
      (`mcp-handlers/utils.ts:572-590`) after a scoped run; a retained shard reports its own state
- [ ] Root shard for files matching no package root; assignment is total; shards apply AFTER
      include/exclude patterns
- [ ] `--shard` honesty: unknown name → fatal with candidates; no index → full analyze, disclosed;
      `--shard` + force defined and reported
- [ ] Shared stale-composition module: this is a SECOND producer of stale regions (today
      `mcp-watcher.ts:647` is the only one) — reuse `prioritize-incremental-closure-budget`'s
      composition rather than reporting a bare count
- [ ] Converge-or-flag at shard granularity: anything unreconciled is marked explicitly stale via
      the existing stale-region machinery (never left divergent, never silently narrowed)
- [ ] Per-shard attestation + freshness in the store (no `openlore status` surface — that command
      is not on `main`; PR #224 never landed)
- [ ] Scoped-analyze report: shards recomputed / retained, frontier size, stale regions
- [ ] `pass1-fact-cache.ts`: export/import; key MUST also cover runtime layout (source vs. dist —
      the stamp digests extractor bytes, so these differ at the same version), Node ABI, and
      platform triple, else CI silently gets a 0% hit rate or, worse, a divergence
- [ ] Redact secrets on EXPORT (docstrings/signatures/identifiers leave the machine for the first
      time; `secret-redaction.ts` is currently wired only to telemetry/LLM/error paths)
- [ ] Gate: an unsigned imported cache is bypassed by any analyze feeding a blocking enforcement
      decision; import path does not ship before bundle signature verification ships
- [ ] `openlore cache export|import` CLI (+ `--json`), with accepted/rejected counts and reasons
- [ ] CI recipe in `docs/ci-cd.md` restoring the archive as an ordinary build-cache artifact

## Verification

- [ ] Detection tests per ecosystem, incl. nested/overlapping roots and the most-specific rule
- [ ] Single-package equivalence: byte-identical graph and artifacts vs. the pre-change build
- [ ] **Shard equivalence (the central test), asserted over the WHOLE graph** modulo the marked
      stale set — scoping it to "that shard and its frontier" makes it vacuously satisfiable by a
      buggy frontier. Includes the added-symbol rebind case and the ambiguity-flip case where
      NEITHER endpoint is in the recomputed shard
- [ ] Non-amputation test: symbols and edges of un-recomputed shards survive; no cross-shard call
      is downgraded to `external::` merely because the callee's shard was not recomputed
- [ ] Unreconcilable-frontier test: the region is marked stale, reported, and non-authoritative in
      freshness verdicts
- [ ] Cache portability: export → import on a second workspace ⇒ output matches what THAT
      installation's own extraction produces (byte-identity with a cold analyze is NOT claimable —
      grammar loadability is a process property no hash can see); accepted/rejected counts and the
      zero-hit cause are reported
- [ ] Trust tests: mismatched purity stamp, mismatched schema version, corrupt archive,
      hash-mismatched entry — each ignored-and-recomputed, never served, never fatal
- [ ] Bypass test: the existing fact-cache bypasses also bypass an imported cache
- [ ] Scale measurement: analyze wall-clock on a large multi-package fixture, full vs. one-shard
      vs. warm-cache, recorded in `scripts/BENCHMARKS.md` (measured, not asserted)
- [ ] Full suite green; docs updated (`cli-reference.md`, `ci-cd.md`, `configuration.md`)
