# Tasks — fix artifact output determinism

## Implementation
- [x] Seeded phase-3 sampling (artifact-generator.ts): deterministic PRNG (mulberry32)
      seeded from a sha1 hash of the sorted candidate file list; Fisher-Yates unchanged
      otherwise; sampling intent preserved, bytes stable across identical trees
- [x] `buildRouteInventory` (http-route-parser.ts): per-file-then-flatten (the
      extractAllHttpEdges precedent) — each file maps to its own routes array,
      flattened in filePaths order
- [x] `synthesizeRouteHandlerEdges` (call-graph.ts): same pattern for the shared
      `routes` array; synthesized edge order becomes a pure function of the file list
- [x] `extractEnvVars` (env-extractor.ts): collect per-file upsert ops inside
      Promise.all, apply them sequentially in filePaths order — `files[]` order
      and description first-wins become input-order deterministic
- [x] Digest: sort spec domains before emission (codebase-digest.ts); fix the
      "internal call edges" figure — count only edges whose BOTH endpoints are
      production nodes (non-test, non-external), matching the adjacent
      "functions analyzed" (prodNodes) count

## Verification
- [x] Double-run byte test: two analyzes of an identical fixture tree produce byte-identical
      llm-context.json (timestamps normalized), route inventory, and env-var inventory.
      Also verified at repo scale: OpenLore's own 11.2 MB llm-context.json is byte-identical
      across two full `analyze --force` runs.
- [x] Adversarial-latency test: per-file extractors stubbed with reversed-completion
      delays → aggregated order still equals input order for buildRouteInventory and
      extractEnvVars (artifact-output-determinism.test.ts)
- [x] Digest test: spec domains emitted sorted; the edge figure's population matches its
      label (fixture graph containing test and external edges → internal-only count)
- [x] Regenerated CODEBASE.md once: the "internal call edges" figure dropped from
      16969 (all `calls` edges, incl. test-caller + external-callee) to 6132
      (production→production only), matching the 2997 production-function count — the
      old figure mixed two populations under one "internal" label.
- [x] Full suite green (6120 passed, 2 skipped)

## Spec
- [x] `analyzer` delta: ADD ArtifactBytesAreAPureFunctionOfInput,
      ConcurrentExtractorsAggregateInInputOrder
- [x] `architecture` delta: ADD DigestFiguresUseOnePopulationPerLabel
