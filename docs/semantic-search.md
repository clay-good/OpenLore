## Semantic Search & GraphRAG

`openlore analyze` builds a vector index over all functions in the call graph, enabling natural-language search via the `search_code`, `orient`, and `suggest_insertion_points` MCP tools, and the search bar in the viewer.

### GraphRAG retrieval expansion

Semantic search is only the starting point. openlore combines three retrieval layers into every search result — this is what makes it genuinely useful for AI agents navigating unfamiliar codebases:

1. **Semantic seed** — keyword (BM25) search by default, or dense+BM25 hybrid ranking when embeddings are enabled, finds the top-N functions closest in meaning to the query.
2. **Call-graph expansion** — BFS up to depth 2 follows callee edges from every seed function, pulling in the files those functions depend on. During `generate`, this ensures the LLM sees the full call neighbourhood, not just the most obvious files.
3. **Spec-linked peer functions** — each seed function's spec domain is looked up in the requirement→function mapping. Functions from the same spec domain that live in *different files* are surfaced as `specLinkedFunctions`. This crosses the call-graph boundary: implementations that share a spec requirement but are not directly connected by calls are retrieved automatically.

The result: a single `orient` or `search_code` call returns not just "functions that mention this concept" but the interconnected cluster of code and specs that collectively implement it. Agents spend less time chasing cross-file references manually and more time making changes with confidence.

### Retrieval modes

Keyword (BM25) search is the **first-class default** — `openlore analyze` builds a working keyword index with zero configuration, no network, and no API key, and `orient` / `search_code` / `search_specs` / `suggest_insertion_points` all work immediately. Semantic (dense) embeddings are a **ranking upgrade** that improves recall on synonym/paraphrase queries; they are never required and structural correctness never depends on them.

Each surface states the active mode plainly — `keyword`, `keyword+vocabulary`, `local-semantic`, or `remote-semantic` (in `analyze` summaries, the `orient` CLI, and the `retrievalMode` field of the `orient` / `search_code` / `search_specs` responses). The keyword default is never framed as a degraded fallback. Agent responses carry no advice to change the mode; `openlore status` and `openlore doctor` name the optional upgrade for a human.

#### Local semantic in the background

When a repository names no embedding provider, the background builds (auto-init, and the MCP server's and hooks' self-healing repair) publish the keyword index first, then add local vectors in a detached process. Answers say `keyword+vocabulary` until those vectors exist for the current analysis generation, then `local-semantic`. Embedding runs into a scratch index, so the real index's lock is held only for the final write. Once vectors exist, later rebuilds re-embed only changed functions; `analyze --force` builds keyword and the next background build adds the vectors again.

Nothing is reported as a problem when this cannot happen: without the optional `@huggingface/transformers` package, or when the model cannot be downloaded, the keyword index keeps serving. Opt out with `"embedding": { "provider": "none" }` (which also wins over `EMBED_*`), `openlore embed --off`, or `autoInit: false`.

#### Measured (2026-11-01)

`npm run bench:retrieval` (harness: `bench/retrieval/`) asks fixed task queries with known target symbols through `orient` — the path an agent's call takes — on a keyword index and on a local-semantic index of the same clone. A query hits when a target is in the first 5 functions returned; MRR counts the first 10. Paraphrase queries avoid the target's name; identifier queries contain it.

| Corpus | Queries (identifier / paraphrase) | Mode | recall@5 | MRR | Index build | Analysis dir |
|---|---|---|---|---|---|---|
| OpenLore (this repo, TypeScript) | 26 (12 / 14) | keyword+vocabulary | 46.2% | 0.369 | 31 s | 124 MB |
| | | local-semantic | 61.5% | 0.442 | 50 s | 141 MB |
| gridprims (JavaScript, documented) | 17 (7 / 10) | keyword+vocabulary | 82.4% | 0.801 | 7 s | 29 MB |
| | | local-semantic | 94.1% | 0.865 | 10 s | 30 MB |
| roughlogic.com (JavaScript, no doc comments) | 16 (7 / 9) | keyword+vocabulary | 43.8% | 0.446 | 19 s | 107 MB |
| | | local-semantic | 50.0% | 0.414 | 30 s | 116 MB |
| **All 59 queries** | | keyword+vocabulary | **55.9%** | 0.514 | | |
| | | local-semantic | **67.8%** | 0.556 | | |

The gain is +11.9 points of recall@5, and recall@5 rose on every corpus, which clears the bar in the `config` spec (`LocalSemanticIsBuiltInTheBackgroundWhenItMeasurablyHelps`). It comes from paraphrase queries (OpenLore 14% → 36%, roughlogic 0% → 22%); identifier queries stayed level or fell — on roughlogic one exact query dropped out of the top 5 (identifier recall@5 100% → 86%), and roughlogic's MRR fell 0.446 → 0.415. Build time is wall time of `analyze --force` (keyword analysis plus vectors) on a 10-core Apple-silicon laptop under load, with the model already cached; the first use also downloads about 23 MB.

Local embedding was made 8–10x faster on 2026-11-01 (the background vector pass on this repository: 203–259 s → 24–25 s). Texts are batched by length, so a batch is padded to similar lengths instead of to the one long function it happened to hold; a bulk build runs on up to four worker threads, each with its own two-thread model session; and the model reads the 256 word pieces its model card documents instead of the tokenizer config's 512. The first two leave vectors unchanged (pooled vs single-thread vectors agree to 1e-7); the third changes the 6% of functions longer than 256 tokens, and moved recall@5 by nothing and MRR by 0.567 → 0.556 overall (bench/retrieval/results/2026-11-01.json). The background pass runs at low CPU priority. These are small query sets: one query is 4–6 points on a single corpus.

After a full analysis, keyword mode may use a repository-derived vocabulary. OpenLore mines
abbreviation, repeated local co-occurrence, and conservative attested morphology links from the
same symbol/doc/signature material it indexes. The artifact is deterministic, bounded, and tied to
the BM25 corpus content stamp. Expansion happens at query time only: the corpus never grows, any
original-term match ranks above every expansion-only match, and an incremental index mutation
invalidates the vocabulary until the next full analysis. Set
`retrieval.vocabularyExpansion: false` to disable this layer without rebuilding. This is a lexical
recall improvement, not semantic retrieval; the local/remote semantic guidance remains unchanged.

There are two ways to turn on semantic ranking:

#### Option A — Local, zero-config (recommended)

```bash
openlore embed --local
```

A bundled, CPU-only, no-API-key on-device embedder. It lazily downloads and caches a small pinned model (~23 MB, under `~/.openlore/models`) on first use, then rebuilds the index. It is powered by the optional `@huggingface/transformers` package; if that package is unavailable on your platform, OpenLore prints a one-line install hint and keeps the keyword index working. Revert any time with `openlore embed --off`.

This writes `embedding.provider: "local"` to `.openlore/config.json`:
```json
{ "embedding": { "provider": "local" } }
```
An explicit local provider takes precedence over any `EMBED_*` environment variables, so `embed --local` is never silently overridden.

#### Option B — Remote OpenAI-compatible endpoint

Provide an OpenAI-compatible embedding endpoint (Ollama, OpenAI, Mistral, vLLM, LM Studio, etc.) via environment variables or `.openlore/config.json`, then run `openlore analyze`:

**Environment variables:**
```bash
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...         # optional for local servers
openlore analyze             # embedding is automatic when configured
```

Both `EMBED_BASE_URL` and `EMBED_MODEL` are required — setting only the URL falls back to the
keyword index (openlore warns when it sees that). For an endpoint with a self-signed
certificate, see [Self-signed certificates](configuration.md#self-signed-certificates):
prefer `NODE_EXTRA_CA_CERTS`, or `EMBED_SKIP_SSL_VERIFY=1` when the CA is unavailable.

> A non-loopback `embedding.baseUrl` committed in `.openlore/config.json` is **refused** —
> a repository may not choose where its own source text is sent. Set `EMBED_BASE_URL` in your
> environment to select a remote endpoint deliberately.

**Config file (`.openlore/config.json`):**
```json
{
  "embedding": {
    "provider": "remote",
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "batchSize": 64
  }
}
```

- `provider`: `"local"` (on-device), `"remote"` (default when `baseUrl`/`model` are set), or `"none"` (keyword only: no background vectors, and wins over `EMBED_*`)
- `batchSize`: Number of texts to embed per API call (default: 64)

> Switching the embedding model or provider re-embeds the whole index (`openlore embed` runs a forced rebuild). Cached vectors from a different model are never reused, so the index can never end up with mixed dimensions; if a stale index is ever queried with a mismatched model, search degrades to keyword (BM25) rather than erroring.

The index is stored in `.openlore/analysis/vector-index/` and is automatically used by the viewer's search bar and the `search_code` / `suggest_insertion_points` MCP tools. With the keyword default the directory holds a BM25-only index (no `vector` column).
