# Tasks — add-build-graph-ingest

## Implementation
- [ ] Normalized target-graph model (`src/core/analyzer/build-graph/`): targets (id, source
      files/roots, tool of origin, generation commit if recorded) + declared edges
- [ ] Format adapters: nx `graph.json`, `turbo query` output, bazel `streamed_jsonproto`,
      bazel-diff hash map, `pants peek`; explicit per-format detection; unknown/unparseable →
      explicit unsupported error, graph unchanged
- [ ] `openlore ingest --build-graph <file> [--check] [--json]`: overlay with `declared::`
      provenance at target granularity (never merged into call reachability); ingest report
      (targets, edges, unresolved-file count)
- [ ] Staleness: generation commit vs HEAD in the freshness-lease vocabulary (current / stale
      disclosed / currency UNVERIFIED when unrecorded) — the `import.ts` currency-ladder precedent
- [ ] Cross-check (`--check`): OpenLore file-level affected set vs build-tool target-level
      affected set; both disagreement directions emitted as `build-graph-disagreement`
      `GovernanceFinding`s (register in `FINDING_CODE_REGISTRY`, defaultClass `advisory`) with
      witnessing files/targets as receipts
- [ ] Target scoping: `select_tests` / `blast_radius` optionally express the reaching-test set as
      covering targets when an ingested build graph is present (absent → no target fields, no
      inference)
- [ ] Expose declared target boundaries to the architecture rule engine as matchable scopes
      (consumed by `widen-architecture-rule-vocabulary`'s rules; that change is not modified here)
- [ ] Addendum 2026-10-31: zero-config tier reading npm/yarn/pnpm workspaces, Nx `project.json`,
      Cargo `[workspace]`, `go.work` into `declared::` package nodes; exported artifact wins when present

## Verification
- [ ] Per-format fixtures: a checked-in artifact per tool ingests to the same normalized graph;
      a truncated/foreign file → explicit unsupported, index byte-identical
- [ ] Provenance test: no `declared::` edge ever appears in call-graph reachability, dead-code,
      or error-propagation results
- [ ] Staleness fixtures: artifact-commit == HEAD → trusted; ancestor → disclosed stale;
      no commit → UNVERIFIED disclosure
- [ ] Cross-check fixtures: an import edge with no declared edge → undeclared-dependency finding;
      a declared edge with no code path → coarser-than-reality finding; agreement → no finding
- [ ] Target-scoping fixture: with an ingested graph, `select_tests` names covering targets;
      without one, no target fields appear
- [ ] tools/list payload budgets re-asserted if any tool description changed (`mcp-presets.test.ts`)
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD BuildGraphIngestCarriesDeclaredProvenance
- [ ] `architecture` delta: ADD DeclaredTargetCrossCheckIsARegisteredFinding
