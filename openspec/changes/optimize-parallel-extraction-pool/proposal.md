# Pass 1 parses the whole corpus on one core while the other N−1 sit idle

> Status: PROPOSED (2026-07-23, competitive substrate sweep). The dominant cost of `openlore
> analyze` — per-file tree-sitter parsing and fact extraction — runs as a strictly serial,
> synchronous loop on the main thread. Parsing is embarrassingly parallel per file (no file's
> extraction reads another file's state), so an M-core machine leaves roughly (M−1)/M of the
> available parse throughput unused. Prior art: every fast indexer in the current
> code-intelligence field parallelizes the parse phase across cores; tree-sitter-based analyzers
> report ~1M LOC in under 10s when parallelized. Deterministic output is non-negotiable and is
> guarded by the existing analyze-twice byte-diff oracle (change
> `fix-artifact-output-determinism`).

## The gap

- **Pass 1 is a serial `for…of` with `await` per file.** `CallGraphBuilder.build` iterates
  `for (const file of files)` and awaits `dispatchFileExtract(file)` one file at a time
  (`src/core/analyzer/call-graph.ts:3979-4034`); `dispatchFileExtract` (`:4827-4843`) routes to
  per-language extractors whose parse is synchronous CPU work —
  `const tree = (parser as Parser).parse(content)` (`:616`, `:801`, `:955`, `:1047`, `:1158`,
  `:1364`, `:1495`, `:1630`, `:1790`, `:1854`). The `async` wrapper yields only at grammar
  `import()`, never during parsing.
- **No worker exists anywhere in the pipeline.** A repo-wide search for `new Worker` /
  `workerData` / `parentPort` in non-test source finds nothing; the only `worker_threads`
  mention is a string in the Node-builtin import classifier
  (`src/core/analyzer/import-parser.ts:89`, `:99`).
- **Parsers are process-global singletons** (`call-graph.ts:139-151`, grammar cache `:1761`),
  consistent with — and currently requiring — the single-threaded loop.
- **The per-file output is already plain data.** Extraction returns serializable facts —
  `FunctionNode`/`RawEdge` (`src/core/analyzer/call-graph-types.ts:47-55`, `:81-83`) and the
  CFG overlay is explicitly "pure data, no AST nodes retained"
  (`src/core/analyzer/cfg.ts:66-76`) — so results cross a worker boundary without any tree
  marshalling.

## What changes

1. **A worker-pool lane for Pass 1.** A fixed-size pool of `worker_threads` (size
   `min(availableParallelism − 1, EXTRACTION_POOL_MAX)`) receives the build's own **file records**
   — path, language, and the content the build was handed. Each worker holds its own per-language
   parser singletons (the module-level cache is per-thread for free), parses, extracts, and
   returns the plain fact objects. The Lua/Dart WASM grammars (`call-graph.ts:2095`, `:2167`) load
   per-worker with the same isolated-module discipline already required on the main thread
   (`:1828-1835`).

   > Revised during implementation: this originally said workers would receive paths and read
   > their own files. That is wrong for correctness, not just for I/O — `build`'s input content is
   > authoritative and is not always what is on disk (HTML pages arrive inline-script-blanked at
   > `artifact-generator.ts:1288`, the incremental path passes in-memory content, and test builds
   > pass synthetic files with no on-disk twin). Sending content keeps the two lanes provably
   > identical.
2. **Deterministic merge.** Results are assembled strictly in input order (the
   significance-sorted order `RepositoryMapper` already produces,
   `src/core/analyzer/repository-mapper.ts:780`, `:828`) regardless of completion order, so
   Pass 2+ sees byte-identical input to the serial path. The acceptance oracle is
   pool-vs-serial artifact byte-equality, reusing the analyze-twice byte-diff technique.
3. **Fail-soft, never fail-different.** A worker crash re-runs that file on the main-thread
   serial path; an environment where workers cannot start (or `OPENLORE_NO_WORKERS=1`) falls
   back to today's serial loop wholesale, disclosed in the analyze summary. Parse-health
   accounting is identical in both lanes.
4. **Pass 1 only.** Global passes (resolution, synthesis, communities — `call-graph.ts:4036`
   onward) stay single-threaded; they are cross-file and not the dominant cost (their pass-count
   reduction is the sibling `optimize-analyze-pipeline-passes`).

**Deliberately NOT borrowed** from the parallel-indexer field: no work-stealing scheduler, no
shared-memory arena, no native-addon rewrite. A fixed pool with input-order merge captures the
core speedup at a fraction of the complexity, and keeps the serial lane alive as the reference
implementation (the rust-analyzer lesson: never let the cold path rot).

## Why this is in scope

Parse throughput is the substrate's admission price — every claim OpenLore makes ("re-orient
after significant refactors", zero-interaction onboarding, the self-healing rebuild) is bounded
below by how fast analyze runs. This is the largest single wall-clock lever available (near-M×
on the dominant phase) with zero conclusion-shape impact and a mechanical determinism proof.

## Impact

- Files: `src/core/analyzer/call-graph.ts` (Pass 1 dispatch → pool lane, per-worker parser
  cache), a new small worker module (worker entry: read → parse → extract → post facts),
  `src/core/analyzer/artifact-generator.ts:1299-1300` (unchanged call site), `src/constants.ts`
  (pool cap).
- Specs: `analyzer` — 1 ADDED requirement (ExtractionPoolPreservesDeterministicOutput).
- No new tool; no output change of any kind. Risk: medium — worker-boundary serialization bugs
  and per-worker grammar state are the hazards; both are pinned by the byte-equality oracle and
  a worker-crash fail-soft test. Coordinate with `optimize-hash-keyed-analyze` (the pool is the
  re-extract lane for changed files) and `optimize-analyze-pipeline-passes` (tree reuse happens
  inside a worker's own file scope, so the two compose).
