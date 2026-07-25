# Fix artifact output determinism: no Math.random, no completion-order bytes

> Status: PROPOSED (2026-07-08, e2e audit fifth pass). Determinism doctrine violations in
> artifact/inventory generation — the spec's own byte-determinism rule ("a pure function of
> the input"), violated at four verified sites: `Math.random()`-sampled content embedded in
> `llm-context.json`, three aggregators whose output order is I/O-completion order (the
> exact hazard one of the same files documents as forbidden — and fixes — 400 lines above),
> and a digest that emits spec domains in raw `readdir` order while labeling a
> mixed-population edge count "internal". The doctrine is load-bearing: `.olbundle` export
> digests and snapshot oracles depend on stable bytes.

## The defect(s)

- **(a) `llm-context.json` embeds randomly sampled content.**
  `src/core/analyzer/artifact-generator.ts:1102-1108` picks phase-3 validation files with a
  `Math.random()` Fisher-Yates shuffle (`const j = Math.floor(Math.random() * (i + 1))`,
  `:1105`), then embeds their content slices in the artifact (`:1110-1123`). Two analyzes
  of an identical tree produce different bytes beyond timestamps — different bundle
  digests, artifact churn if committed.
- **(b) Three completion-order-nondeterministic aggregators — the documented forbidden
  hazard.** `http-route-parser.ts:1241-1256` (`buildRouteInventory`) does
  `await Promise.all(filePaths.map(async fp => { … allRoutes.push(…) }))` — so
  `get_route_inventory` order is I/O-completion order — while the SAME FILE's
  `extractAllHttpEdges` (`:834-861`) documents this precise pattern as "a latent
  byte-determinism hazard the spec forbids (and the shareable-bundle digest relies on)"
  (`:838-839`) and implements the per-file-then-flatten fix 400 lines above. Likewise
  `call-graph.ts:3639-3645` (`synthesizeRouteHandlerEdges`) pushes into a shared `routes`
  array inside `Promise.all`, so synthesized route-handler edge order varies run to run —
  serialized graph bytes are not a pure function of the input. And
  `env-extractor.ts:156-206` (`extractEnvVars`) upserts from concurrent callbacks: the
  final var list is name-sorted (`:208`), but each var's `files[]` push order (`:159`) and
  its winning description (first-wins, `:162`) are completion-order dependent.
- **(c) Digest ordering + a mixed-population label.** `codebase-digest.ts:233-241` emits
  spec domains in raw `readdir` order (platform-dependent, unsorted). And the digest's
  "internal call edges" figure (`:109`) is `cg.stats.totalEdges`, which counts ALL `calls`
  edges (`call-graph.ts:4644`, `edges.filter(e => !e.kind || e.kind === 'calls')`) —
  including test-caller and external-callee edges — while the adjacent function count
  (`codebase-digest.ts:106-108`) filters to `!n.isTest && !n.isExternal` (as does
  `internalNodes` for the averages, `call-graph.ts:4489`). Two populations under one
  "internal" label: the ratio a reader computes from the digest is wrong by construction.

## What changes

1. **Seeded sampling.** The phase-3 shuffle uses a deterministic PRNG seeded from a hash of
   the sorted candidate file list — the sampling intent (spread across leaves) is
   preserved, and identical input trees produce identical `llm-context.json` bytes. No new
   tuning constant: the seed is derived, not chosen.
2. **Per-file-then-flatten at all three aggregators** — the in-file precedent
   (`http-route-parser.ts:840-863`) applied to `buildRouteInventory`,
   `synthesizeRouteHandlerEdges`, and `extractEnvVars`: map each file to its own result
   array inside `Promise.all` (which resolves in INPUT order regardless of completion
   order), then flatten/upsert sequentially in `filePaths` order. Env-var `files[]` order
   and description first-wins become input-order deterministic; concurrency of the I/O
   itself is unchanged.
3. **Digest hygiene.** Spec domains sort before emission (`codebase-digest.ts:233-241`);
   the edge figure either switches to an internal-only edge count (both endpoints
   non-test, non-external — matching the node population) or the label changes to name the
   true population. One figure, one population, one label.

## Why this is in scope

Byte-determinism is not cosmetics here: `.olbundle` export digests attest content, snapshot
oracles (the modularize-call-graph recipe) diff serialized graphs, and committed artifacts
churn diffs when bytes wander. The substrate's claim (decision `c6d1ad07`) is deterministic,
locally-computed structural context; an artifact that differs across identical runs is that
claim violated at the output boundary. Every fix reuses an in-repo precedent — the
per-file-then-flatten pattern and the derived-seed discipline — no new constants, no LLM,
and the mixed-population label fix is the honest-boundaries rule applied to our own digest.

## Impact

- Files: `src/core/analyzer/artifact-generator.ts` (seeded shuffle),
  `src/core/analyzer/http-route-parser.ts` (`buildRouteInventory`),
  `src/core/analyzer/call-graph.ts` (`synthesizeRouteHandlerEdges`),
  `src/core/analyzer/env-extractor.ts` (`extractEnvVars`),
  `src/core/analyzer/codebase-digest.ts` (domain sort, edge figure/label).
- Specs: `analyzer` — 2 ADDED requirements (ArtifactBytesAreAPureFunctionOfInput,
  ConcurrentExtractorsAggregateInInputOrder); `architecture` — 1 ADDED requirement
  (DigestFiguresUseOnePopulationPerLabel).
- Tool surface: unchanged (`get_route_inventory`/`get_env_vars` outputs gain stable order;
  no new tool, no payload-budget impact).
- Risk: low. Order changes are one-time diffs in committed artifacts (disclosed by this
  change); the digest edge-count fix changes a headline number — CODEBASE.md regenerates
  with the corrected figure and the change notes why it moved.
