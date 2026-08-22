# The programmatic API is a fork of the CLI pipeline, not a facade over it — realign and make its contract embedder-safe

> Status: BUILT (2026-08-22). The CLI and programmatic API now share bounded analysis,
> indexing, provider resolution, generation finalization, and coherent locking. Verified by
> 8,252 unit tests, 189 E2E tests, real CLI/API artifact parity, packed-consumer smoke, and
> four adversarial multi-agent review/fix loops. `src/api/*.ts` is OpenLore's public
> embeddable surface (the documented OpenSpec-CLI integration point). It reimplements the
> analysis and generation pipelines in parallel to the CLI instead of calling the same core,
> and has drifted on every axis the CLI has since fixed: it ignores config include/exclude
> patterns, writes no `fingerprint.json`, builds no BM25/spec index, resolves LLM providers
> differently, uses a different cache-freshness rule, and returns fabricated version fields.
> On top of that its stated contract ("no side effects, no console.log") is false and its
> errors are untyped. This is the already-bitten dogfood gotcha ("cold-start must inject
> install's buildIndex — openloreRun/openloreAnalyze are wrong") generalized into a spec.

## The gap

- **(a) The API builds a lesser, incompatible index.** `openloreAnalyze`/`openloreRun`
  (`analyze.ts:143-186`, `run.ts:170-199`) run only RepositoryMapper + DependencyGraphBuilder
  + ArtifactGenerator. CLI `runAnalysis` (`cli/commands/analyze.ts:117-243`) additionally
  merges `analysis.includePatterns`/`excludePatterns` (its own comment promises "all entry
  points … respect the project configuration"), writes `fingerprint.json` (the content-hash
  freshness marker + bundle `sourceCommit` source), runs the Phase-3 inventory extractors,
  and builds the `VectorIndex`/`SpecVectorIndex`. An embedder that calls `openloreAnalyze()`
  gets vendored code indexed, no fingerprint (every later freshness check degrades to TTL),
  and empty `orient`/`search_code`/inventory results on an "analyzed" repo.
- **(b) Provider resolution diverges.** `run.ts:235-273` resolves the provider from
  `options.provider ?? env` only, dropping `generation.provider`, `generation.model`,
  `openaiCompatBaseUrl`, and `OPENAI_COMPAT_BASE_URL` that `generate.ts:126-192` and the CLI's
  shared `resolveLLMProvider` honor. A repo configured with a keyless provider works on the
  CLI and throws `No LLM API key found` through `openloreRun`.
- **(c) Cached/partial results are indistinguishable from fresh/complete.** `openloreAnalyze`
  uses an mtime TTL while `openloreRun` uses content-hash `isCacheFresh` — same library, two
  freshness semantics. No result carries a `fromCache` marker, and a missing/corrupt
  `dependency-graph.json` is silently replaced by an all-zeros empty graph
  (`analyze.ts:107-132`) so an embedder cannot tell "no dependencies" from "artifact missing."
- **(d) The contract is dishonest at the edges.** Every `src/api/*.ts` header claims "no
  side effects (no console.log)", but the writer and pipeline emit through the singleton
  logger (`openspec-writer.ts:455-492`, `spec-pipeline.ts`), corrupting a host that uses
  stdout for protocol framing. Errors are raw (`run.ts:305` discards `cause`; `audit.ts:89`
  bare `JSON.parse`; `audit.ts:148` writes into a never-created dir → raw `ENOENT`) though
  `OpenLoreError` with stable codes already exists. `pipelineResult: {} as …` (`run.ts:225`)
  lies to the type system; `openloreVersion: '1.0.0'` is hardcoded (package is 2.1.5);
  `BaseOptions.configPath` is documented but read nowhere.

## What changes

1. **Make the API a facade over the CLI core.** Extract the analysis and generation cores
   the CLI already owns (config-pattern merge, `fingerprint.json`, inventory extractors,
   vector indexes, `resolveLLMProvider`, the post-write mapping/RAG/snapshot steps) behind a
   progress adapter, and have `openloreAnalyze`/`openloreRun`/`openloreGenerate` call it.
   One freshness predicate for both entry points.
2. **Honest result contract.** Add `fromCache: boolean` and a disclosed `degraded`/missing
   field instead of a fabricated empty graph; thread a `quiet`/logger option (or route
   through `onProgress`) so the API makes no console side effects; make `pipelineResult`
   optional or a `{ dryRun: true }` discriminant; report the real package version and
   separate it from the config-schema version; honor or remove `configPath`.
3. **Typed errors.** Throw `OpenLoreError` with stable codes (`no-config`, `no-analysis`,
   `no-api-key`, `pipeline-failed` carrying `cause`) and guard the raw parse/write sites.

## Why this is in scope

The embeddable API is how other tools (OpenSpec CLI, host loaders) consume the substrate; a
fork that silently indexes less, resolves providers differently, and lies about caching and
side effects is the substrate failing its own integration contract. Aligning to one core
also stops the divergence from recurring.

## Impact

- Files: `src/api/analyze.ts`, `run.ts`, `generate.ts`, `audit.ts`, `types.ts`, `index.ts`;
  shared cores extracted from `src/cli/commands/analyze.ts` / `run.ts` / `generate.ts`;
  `src/utils/errors.ts` (reuse). Sibling: this discharges findings the pass-3
  `align`-adjacent changes did not touch.
- Specs: `api` — 3 ADDED (ApiIsAFacadeOverTheCliCore, ApiResultsDiscloseCacheAndDegradation,
  ApiHasNoConsoleSideEffectsAndTypedErrors).
- No new tool. Risk: medium — the API result shapes are exported surface; add fields
  additively, reserve the `pipelineResult` optionality as the one breaking shape change and
  note it. Verify with an embedder harness (analyze via API == analyze via CLI, byte-for-byte
  on the artifacts an embedder reads).
