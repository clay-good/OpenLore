# Make embeddings frictionless — or honestly unnecessary

> Status: SHIPPED (2026-06-23) on branch `feat/make-embeddings-zero-config`. See `tasks.md` for the
> per-task implementation map. Both halves landed: BM25 is a first-class named `keyword` mode (no
> degraded framing), and `openlore embed --local` enables an on-device, zero-config, no-API-key
> semantic upgrade. No new MCP tool; no LLM on any hot path; the local embedder is an optional
> ranking aid behind an optionalDependency + lazy import with graceful keyword fallback.

> Originally PROPOSED (2026-06-22). First-run friction fix across the index/search path
> (`src/core/analyzer/vector-index.ts`, `src/core/analyzer/embedding-service.ts`) and the install/
> analyze flow (`src/cli/install/index.ts`, `src/cli/commands/analyze.ts`). No new MCP tool, no LLM
> on any hot path. The optional local embedder is a ranking aid, never a correctness dependency.

## Why

Embeddings are unavailable even in OpenLore's own repo — `orient` falls back to BM25. There is
literally a `first-run-hardening` skill in this project, which is a standing admission that the install
experience is where users churn. The current design makes semantic search a configured prerequisite
and then treats its absence as a degraded "fallback," which produces the worst of both worlds: a happy
path that often fails to the unhappy path, and an unhappy path framed as second-class.

Today (traced through the code):

- `EmbeddingService.fromEnv()` (`embedding-service.ts:70`) **throws** unless `EMBED_BASE_URL` and
  `EMBED_MODEL` are set; there is **no bundled or local embedder** — every semantic path requires an
  external OpenAI-compatible endpoint.
- `openlore install` → `buildIndex` (`src/cli/install/index.ts:87`) builds the index with **no embed
  flags**, printing "Building search index (BM25; no network required)" — so the *default* first-run
  index is BM25-only.
- At search time, `VectorIndex.search` (`vector-index.ts:687`) reads `hasEmbeddings` from the metadata
  sidecar and silently routes to `_bm25Only` (`vector-index.ts:825`) when embeddings are absent or the
  endpoint throws.

So the de-facto default is already BM25 — but the product frames it as a fallback, dangles a "semantic
upgrade" that requires standing up an endpoint and a key, and leaves first-run users unsure whether
they are using OpenLore "correctly." Pick one honest posture and remove the friction.

## What changes

This proposal does **both** halves of the user's framing — commit to BM25 as a real default *and* make
the semantic upgrade genuinely frictionless — because together they remove the ambiguity entirely.

1. **BM25 is a first-class default, not a degraded fallback.** Reframe the index and search so that a
   keyword index is a supported, named mode — not "fallback," not a warning. Search results from BM25
   are returned without degradation-warning noise on the happy path. The product communicates: *BM25 is
   the default and it is fine; semantic is an optional ranking upgrade.* `orient`/`search_code`
   correctness never depends on embeddings (it does not today, and this makes that explicit and
   intentional rather than incidental).

2. **A zero-config local embedder as the opt-in upgrade.** Add a bundled, CPU-only, no-API-key local
   embedding option, enabled with a single command (`openlore embed --local` / a config flag). It lazily
   downloads and caches a small embedding model on first use — no endpoint, no key, no network beyond
   the one-time model fetch. This turns "set up an OpenAI-compatible server and a key" into "run one
   command." The remote OpenAI-compatible path (`EMBED_*` / config `embedding` block) stays exactly as
   is for users who want it.

3. **Honest, low-noise messaging.** Remove the "fallback"/degraded framing from the happy path. State
   the active retrieval mode plainly (`keyword` / `local-semantic` / `remote-semantic`) once, where it
   is useful (e.g. in `orient`/`analyze` summaries), not as a repeated warning. When the remote endpoint
   is configured but unreachable, *that* is worth a one-time notice (a configured expectation failed);
   plain BM25 default is not.

4. **First-run never blocks on embeddings.** `openlore install` / `analyze` complete fully with a
   first-class keyword index and zero embedding configuration. The semantic upgrade is offered, never
   required, and never on the critical path of getting a working index.

## What does NOT change

- **No LLM on any hot path.** Embeddings are a retrieval ranking aid; the deterministic structural
  substrate (call graph, blast radius, drift) is unchanged and remains the north star (`c6d1ad07`).
- **No new MCP tool.** This is config + CLI + index/search internals.
- **The remote embedding path is preserved.** `EMBED_BASE_URL` / `EMBED_MODEL` / `EMBED_API_KEY` and
  the config `embedding` block keep working unchanged.
- **The hybrid retrieval design stays.** When embeddings are present (local or remote), the existing
  dense+sparse RRF fusion (`vector-index.ts:783`) is used; BM25-only is the default leg, not a new
  algorithm.

## Research basis

For code search over a single repository, lexical BM25 is a strong, well-understood baseline; dense
embeddings add recall on synonym/paraphrase queries but are not required for usable retrieval. The
defensible posture for a local-first tool is therefore "lexical default, semantic optional," and the
friction to *opt into* semantic should be near zero. Small CPU-runnable embedding models (sub-100M
params, ONNX/quantized) make a bundled, no-API-key local embedder practical — this is the same pattern
shipped by other local-first code tools that embed on-device rather than calling a hosted endpoint.

## Application to OpenLore

- **First-class keyword mode** reframes the existing `hasEmbeddings: false` metadata + `_bm25Only`
  path (`vector-index.ts:721`, `:825`) as a named mode rather than a fallback, and strips the degraded
  framing from `analyze`/`install` output (`src/cli/install/index.ts:103`, `analyze.ts:778`).
- **Local embedder** adds a `LocalEmbeddingService` alongside `EmbeddingService`
  (`embedding-service.ts`) implementing the same `embed(texts)` contract, backed by an on-device model
  with a lazy cached download; selected by config/flag, consumed unchanged by `VectorIndex.build`
  (`vector-index.ts:330`) and `VectorIndex.search` (`vector-index.ts:687`).
- **Mode reporting** surfaces the active mode (`keyword` / `local-semantic` / `remote-semantic`) from
  the metadata sidecar where the index already records `hasEmbeddings` / `model`.
- **Config** extends the existing `embedding` block (`src/types/index.ts`) with a local option (e.g.
  `embedding.local: true` or `embedding.provider: 'local'`), additive and optional.

## Out of scope

- **Training or fine-tuning** any model. The local embedder uses a pre-trained, pinned model only.
- **Removing the remote path.** Remote OpenAI-compatible endpoints remain fully supported.
- **GPU acceleration.** CPU-only is the bar for zero-config; GPU is a later optimization.
- **Changing the structural substrate.** Embeddings never become a correctness dependency for any
  deterministic conclusion.

## Design decisions (record before coding)

- **Lexical default, semantic optional — stated, not implied.** The product's default posture is
  first-class BM25; semantic is an opt-in ranking upgrade. This is a deliberate stance, not the
  incidental result of an unconfigured endpoint.
- **One bundled, pinned local model; lazy cached download; no API key.** Frictionless opt-in without
  shipping large weights in the package or requiring network on every run.
- **Same `embed(texts)` contract for local and remote.** `VectorIndex` is agnostic to the embedder
  source; only construction differs.
- **Low-noise messaging.** State the active mode once; warn only when a *configured* expectation fails
  (remote endpoint set but unreachable), never for the plain default.
