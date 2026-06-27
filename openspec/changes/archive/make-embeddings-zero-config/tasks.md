# Tasks — Make embeddings frictionless or honestly unnecessary

> Status: SHIPPED (2026-06-23) on branch `feat/make-embeddings-zero-config`. First-run friction fix;
> no new MCP tool, no LLM on any hot path. The local embedder is an optional ranking aid, never a
> correctness dependency.
>
> Implementation summary:
> - Provider selection extracted to `src/core/analyzer/embedder.ts` (`resolveEmbedder` + `embedderMode`),
>   the single env→local→remote resolver every consumer shares (analyze, watch, orient, search_code,
>   search_specs, generate, view) so the configured provider is honoured identically at build and query time.
> - `LocalEmbeddingService` (`src/core/analyzer/local-embedding-service.ts`) implements the `Embedder`
>   contract via the optional, lazily-imported `@huggingface/transformers` (pinned `Xenova/all-MiniLM-L6-v2`,
>   384-dim, ~23 MB, cached under `~/.openlore/models`).
> - `@huggingface/transformers` is an **optionalDependency** + lazy dynamic import: absent → clear install
>   hint, keyword index still works (validated e2e).

## 1. BM25 as a first-class default (reframing)
- [x] Treat the `hasEmbeddings: false` / `_bm25Only` path as a named `keyword` mode, not a fallback
      (`retrievalMode` field + `embedderMode()`).
- [x] Strip degraded-fallback framing from happy-path output in `analyze.ts` (`[keyword]` mode line +
      optional-upgrade hint, no warning) and the orient/search notes.
- [x] Test: `embedder.test.ts` + updated `orient.test.ts` / `semantic.test.ts` assert keyword default
      builds/queries with no error/warning noise.

## 2. Zero-config local embedder
- [x] `LocalEmbeddingService` alongside `EmbeddingService`, same `embed(texts)` contract, CPU-only, no
      API key; lazy download + cache of a pinned small model.
- [x] Selectable via config (`embedding.provider: 'local'`), consumed unchanged by `VectorIndex.build` /
      `VectorIndex.search` (both now typed to the `Embedder` interface).
- [x] Preserve the remote OpenAI-compatible path (`EMBED_*` / `embedding` block) unchanged.
- [x] Test: `embedder.test.ts` covers local/remote/env precedence; e2e dogfood built a local-semantic index.

## 3. `openlore embed --local` command
- [x] New CLI command (`src/cli/commands/embed.ts`, registered in `src/cli/index.ts`) that sets the local
      provider and rebuilds the index in one step, fetching+caching the model on first use.
- [x] Test: dogfooded e2e — one command enabled local semantic search; subsequent `orient` reported
      `local-semantic` and ranked the semantically-closest function first.

## 4. Low-noise mode reporting
- [x] Report active mode (`keyword` / `local-semantic` / `remote-semantic`) in `analyze` summary lines,
      the `orient` CLI ("Retrieval mode:"), and the orient/search_code/search_specs JSON (`retrievalMode`).
- [x] No degraded-fallback warning for the keyword default; the build-time path still surfaces a
      configured-but-unreachable remote endpoint (existing `analyze` notice).
- [x] Test: keyword default states mode without warning (asserted in handler tests).

## 5. First-run never blocks
- [x] `openlore install` / `analyze` complete fully with the keyword default, no embedding config, no network.
- [x] Test (dogfood): clean repo → `init` → `analyze` → working keyword index + `orient`; and with the
      optional dep hidden, `analyze` falls back to keyword with an actionable message (never blocks).

## 6. Docs
- [x] Documented the lexical-default stance and `openlore embed --local` in the README, plus
      docs/semantic-search.md, docs/mcp-tools.md, docs/configuration.md, docs/install.md,
      docs/cli-reference.md, docs/output.md, docs/providers.md, and CHANGELOG.md. (The
      `first-run-hardening` skill is a global Claude skill, not tracked in this repo.)

## 7. Round-2 hardening (adversarial review of PR #191)
- [x] **Model/dimension-switch safety.** `VectorIndex.build` now gates cached-vector reuse on an exact
      model match (`existingMeta.model === embedSvc.modelName`), `VectorIndex.updateFiles` (watch)
      refuses to mix dimensions when the model changed, and both `VectorIndex.search` /
      `SpecVectorIndex.search` degrade to keyword (BM25) instead of throwing when a stale index is
      queried with a mismatched-dimension embedder. Regression: `vector-index-model-switch.test.ts`.
- [x] **Precedence.** An explicit `embedding.provider: 'local'` now wins over ambient `EMBED_*` env in
      `resolveEmbedder`, so `openlore embed --local` is never silently overridden (it also warns when
      `EMBED_*` is set). Regression: `embedder.test.ts`.
- [x] **Honest mode reporting.** `servedRetrievalMode` reports `keyword` whenever the on-disk index has
      no vectors (e.g. a build fell back after a missing optional dep), even if config names a semantic
      provider; `searchMode` is derived from it. Regression: `embedder.test.ts`.
- [x] **Reversibility.** Added `openlore embed --off` (revert to keyword + forced rebuild). `doctor`
      now reports a configured local provider instead of silently skipping. Tests: `embed.test.ts`.
- [x] Validated all of the above e2e on a clean repo: keyword default (no warning), `embed --local`
      ignoring stale `EMBED_*`, incremental re-analyze staying dimension-safe, `embed --off`, and the
      missing-dep path producing a working keyword index with an honest `keyword` mode.

## 8. Round-3 hardening (second adversarial review of PR #191)
- [x] **Visible watch-mode deferral.** When `VectorIndex.updateFiles` refuses a vector update because the
      embedding model changed, it now returns `deferred: 'model-changed'` and the watcher prints an
      actionable notice ("vector update deferred … run analyze --force") instead of a misleading
      "0 new, 0 reused" no-op line. Regression asserted in `vector-index-model-switch.test.ts`.
- [x] **Clearer local model-load failure.** `LocalEmbeddingService.getExtractor` now wraps the
      `pipeline()` call so a bad `--model` id / first-fetch network failure surfaces "Could not load the
      local embedding model …" (distinct from the package-missing message), still degrading to keyword.
- [x] Fresh e2e dogfood of previously-untested paths: `embed --local --model <nonexistent>` → graceful
      keyword fallback; spec search under the local provider (`orient.matchingSpecs` populated,
      `[local-semantic]` spec index); idempotent `embed --off`. Full suite 4696 passed / 2 skipped.
