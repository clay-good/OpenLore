# Tasks — align-api-layer-with-cli-core

## Implementation
- [x] Extract the analysis core the CLI owns (config include/exclude merge,
      fingerprint.json write, Phase-3 inventory extractors, VectorIndex + SpecVectorIndex)
      behind a progress adapter; openloreAnalyze/openloreRun call it
- [x] Extract the generation post-write core (mapping artifact, RAG manifest, spec snapshot)
      and the shared resolveLLMProvider(openloreConfig); openloreRun == init+analyze+generate
- [x] One freshness predicate for both entry points (content-hash); add `fromCache: boolean`
      to results; replace the fabricated empty graph with a disclosed missing/degraded field
- [x] Thread a quiet/logger option (or route core logging through onProgress); correct the
      "no side effects" header claims to match reality
- [x] Typed errors: throw OpenLoreError with codes (no-config, no-analysis, no-api-key,
      pipeline-failed carrying cause); guard audit.ts bare JSON.parse + writeFile-into-missing-dir
- [x] Result-shape fixes: pipelineResult optional / {dryRun:true} discriminant; real package
      version; separate config-schema version; honor or remove BaseOptions.configPath

## Verification
- [x] Parity test: openloreAnalyze produces the same artifacts an embedder reads (graph +
      fingerprint + inventories + indexes) as CLI analyze on the same fixture
- [x] Config-pattern test: an excludePatterns entry is respected through the API
- [x] Provider test: a keyless generation.provider works through openloreRun
- [x] Cache test: a result served from cache carries fromCache:true; a missing artifact
      yields a disclosed degraded field, never an all-zeros graph
- [x] Side-effect test: with quiet set, no console output is emitted during an API generate
- [x] Error test: no-config / no-analysis / no-api-key throw typed OpenLoreError with codes
- [x] Full suite green

## Spec
- [x] `api` delta: ADD ApiIsAFacadeOverTheCliCore, ApiResultsDiscloseCacheAndDegradation,
      ApiHasNoConsoleSideEffectsAndTypedErrors
