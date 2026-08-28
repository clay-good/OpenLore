## Semantic Search & GraphRAG

`openlore analyze` builds a vector index over all functions in the call graph, enabling natural-language search via the `search_code`, `orient`, and `suggest_insertion_points` MCP tools, and the search bar in the viewer.

### GraphRAG retrieval expansion

Semantic search is only the starting point. openlore combines three retrieval layers into every search result — this is what makes it genuinely useful for AI agents navigating unfamiliar codebases:

1. **Semantic seed** — keyword (BM25) search by default, or dense+BM25 hybrid ranking when embeddings are enabled, finds the top-N functions closest in meaning to the query.
2. **Call-graph expansion** — BFS up to depth 2 follows callee edges from every seed function, pulling in the files those functions depend on. During `generate`, this ensures the LLM sees the full call neighbourhood, not just the most obvious files.
3. **Spec-linked peer functions** — each seed function's spec domain is looked up in the requirement→function mapping. Functions from the same spec domain that live in *different files* are surfaced as `specLinkedFunctions`. This crosses the call-graph boundary: implementations that share a spec requirement but are not directly connected by calls are retrieved automatically.

The result: a single `orient` or `search_code` call returns not just "functions that mention this concept" but the interconnected cluster of code and specs that collectively implement it. Agents spend less time chasing cross-file references manually and more time making changes with confidence.

### Retrieval modes

Keyword (BM25) search is the **first-class default** — `openlore analyze` builds a working keyword index with zero configuration, no network, and no API key, and `orient` / `search_code` / `search_specs` / `suggest_insertion_points` all work immediately. Semantic (dense) embeddings are an **optional ranking upgrade** that improves recall on synonym/paraphrase queries; they are never required and structural correctness never depends on them.

Each surface states the active mode plainly — `keyword`, `local-semantic`, or `remote-semantic` (in `analyze` summaries, the `orient` CLI, and the `retrievalMode` field of the `orient` / `search_code` / `search_specs` responses). The keyword default is never framed as a degraded fallback.

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

- `provider`: `"local"` (on-device) or `"remote"` (default when `baseUrl`/`model` are set)
- `batchSize`: Number of texts to embed per API call (default: 64)

> Switching the embedding model or provider re-embeds the whole index (`openlore embed` runs a forced rebuild). Cached vectors from a different model are never reused, so the index can never end up with mixed dimensions; if a stale index is ever queried with a mismatched model, search degrades to keyword (BM25) rather than erroring.

The index is stored in `.openlore/analysis/vector-index/` and is automatically used by the viewer's search bar and the `search_code` / `suggest_insertion_points` MCP tools. With the keyword default the directory holds a BM25-only index (no `vector` column).

