# Batch analyze is all-or-nothing: one changed file re-parses the entire repo

> Status: PROPOSED (2026-07-23, competitive substrate sweep). `openlore analyze` has exactly two
> speeds: skip everything (project fingerprint unchanged) or re-parse everything. The per-file
> content-hash table that would let it re-extract only the diff already exists — the watcher
> uses it — but batch analyze never reads it. The convergent design across the fast-indexer
> field (and the incremental-computation literature: Salsa/rust-analyzer, build-system change
> detection) is content-hash-keyed memoization of per-file derived facts, making re-index cost
> proportional to the diff, not the repo. OpenLore's own determinism guarantee (change
> `fix-artifact-output-determinism`: artifacts are a pure function of the input) is precisely
> what makes this memoization sound. Distinct from `add-incremental-early-cutoff` (the WATCHER's
> cascade cutoff after a single-file re-parse) and `add-symbol-content-hashes` (symbol-level
> changed-sets between revisions): this change makes the BATCH pipeline itself O(diff).

## The gap

- **The freshness check is whole-run, not per-file.** `analyze.ts:412`
  `if (analysisAge !== null && !opts.force)` skips the *entire* analysis when the project
  fingerprint (path+mtime+size over all files, written at `analyze.ts:239-244`) is unchanged;
  any other state re-parses the full corpus — `graphBuilder.build(repoMap.allFiles)`
  (`analyze.ts:159`) and `builder.build(callGraphFiles)`
  (`src/core/analyzer/artifact-generator.ts:1300`) always receive the full file set, and Pass 1
  re-parses each file unconditionally (`src/core/analyzer/call-graph.ts:3980`).
- **The per-file hash cache exists but only the watcher uses it.** `file_hashes`
  (`src/core/services/edge-store.ts:233-237`, API `:927-940`) is read/written solely by
  `mcp-watcher.ts:551`/`:639` (and a freshness read in `symbol-span.ts:184`); `analyze.ts` and
  `artifact-generator.ts` never call it.
- **Rebuild wipes instead of patching.** `clearAll` deletes every table including `file_hashes`
  (`edge-store.ts:989`), so even the hashes that could seed a diff are discarded on each batch
  run.
- Net effect: a one-line edit after a week of daemon-less work, a CI run on a shallow diff, and
  a post-pull `analyze` all pay the full-corpus price that `optimize-parallel-extraction-pool`
  can only divide by core count — this change removes the work instead.

## What changes

1. **Persist per-file extraction facts keyed by content hash + extractor stamp.** Pass 1's
   output for each file — nodes, raw edges, CFG overlay, import facts, parse-health entries
   (all already plain data, `call-graph-types.ts:47-55`, `cfg.ts:66-76`) — is stored in the
   EdgeStore keyed by `(file_path, content_hash, extractor_version_stamp)`. The stamp follows
   the tokenizer-version-stamp precedent (`fix-bm25-identifier-tokenization`) and shares its
   digest/stamp module with `add-incremental-early-cutoff` — one implementation, two consumers.
2. **Analyze becomes: hash-diff → re-extract the diff → merge → global passes.** Hash every
   walked file; files whose `(hash, stamp)` matches the cache reuse their stored facts;
   changed/new files re-extract (through the worker pool when present); deleted files' facts
   drop. Global passes (Pass 2 resolution onward, `call-graph.ts:4036+`) run over the merged
   fact set exactly as today — they are cross-file and stay whole-graph.
3. **`clearAll` stops destroying the memo.** Ordinary rebuilds patch; only a schema bump, a
   stamp bump, or `--force` invalidates the fact cache (`--force` keeps today's semantics:
   re-extract everything, then repopulate the cache).
4. **The mode is disclosed, never silent.** The analyze summary reports
   `re-extracted N files, reused M cached` — an operator can always see which lane ran, and
   `--force` output remains the reference the reused lane is verified against.

**Deliberately NOT borrowed:** no daemon-resident dependency graph of queries (the Salsa
red-green runtime) and no cross-machine cache sharing. Facts are memoized at exactly one
boundary — per-file extraction — because that is where OpenLore's cost lives and where purity
is already proven; global passes stay simple whole-graph functions.

## Why this is in scope

O(diff) re-index is the difference between "analyze after every pull" being free and being a
coffee break; it compounds with the worker pool (parallelize what remains) and directly serves
the north star's "no re-reading the repository file by file" promise at the pipeline level. The
determinism guarantee makes it provably safe: same facts in, byte-identical artifacts out.

## Impact

- Files: `src/cli/commands/analyze.ts` (hash-diff gate replacing the all-or-nothing check),
  `src/core/analyzer/call-graph.ts` (Pass 1 accepts pre-supplied cached facts),
  `src/core/analyzer/artifact-generator.ts`, `src/core/services/edge-store.ts` (fact-cache
  table + stamp; `clearAll` scope change), shared digest/stamp module with
  `add-incremental-early-cutoff`.
- Specs: `analyzer` — 1 ADDED requirement (AnalyzeCostScalesWithTheDiff).
- No new tool. Risk: medium-high — a stale-fact bug would silently corrupt the graph; mitigated
  by the byte-equality oracle (cached-lane output vs `--force` output after any edit sequence),
  the stamp invalidation rule, and `--force` as the always-available escape. Coordinate with
  `optimize-parallel-extraction-pool` (re-extract lane) and `optimize-analyze-pipeline-passes`
  (fewer global passes over the merged facts).
