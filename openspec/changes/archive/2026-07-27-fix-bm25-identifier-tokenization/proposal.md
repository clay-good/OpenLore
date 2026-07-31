# Identifier-aware BM25 tokenization: `getUserById` must match a query for `user`

> Status: SHIPPED (2026-07-18, PR #221; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). BM25 keyword search is the zero-config DEFAULT
> retrieval mode, but its tokenizer lowercases and splits only on non-alphanumerics — an
> identifier like `getUserById` becomes the single token `getuserbyid`, so the most common
> identifier-shaped queries (`user`, `getUser`) miss entirely. Split compound identifiers into
> sub-tokens AND keep the compound, identically at index and query time; version the tokenizer so
> a mixed-token index is rebuilt, never served. Plus a small dead-code cleanup in the RRF merge.

## The gap

- **The default mode under-recalls silently.** With no embedder configured, retrieval is
  first-class keyword BM25 (`embedder.ts:39-56` resolves to `null` → `RetrievalMode: 'keyword'`,
  `embedder.ts:17,65`) — the honest zero-config default shipped by
  `make-embeddings-zero-config`. But `tokenize()` (`vector-index.ts:142-145`) is
  `text.toLowerCase().split(/[^a-z0-9]+/)`: `getUserById` → `getuserbyid`, `snake_case` splits
  (underscore is non-alphanumeric) but camelCase/PascalCase does not. A query for `user` or
  `getUser` scores zero against the function the user is looking for. The *mode* is disclosed
  (`keyword`), but its recall boundary is not — the worst kind of silent gap, because it is the
  out-of-box experience. The same tokenizer feeds every BM25 corpus: the function index, the
  text-line index (`text-line-index.ts:31,253` imports it deliberately), and spec search's
  BM25-only path.
- **Dead score math in the RRF merge.** `vector-index.ts:808-825` accumulates per-entry RRF
  scores into `rrfMap`, then `:830-840` rebuilds every score from `denseRankById`/`sparseRankById`
  and uses only the map's rows — ~15 lines of accumulation whose results are discarded. Harmless,
  but it misleads readers about which numbers matter (cleanup, no behavior change).

## What changes

**Identifier-aware tokenization, applied identically at index and query time; a tokenizer version
stamp so skew rebuilds instead of serving mixed results.**

- `tokenize()` splits camelCase / PascalCase / snake_case / kebab-case boundaries into sub-tokens
  AND retains the original compound token (both indexed): `getUserById` →
  `getuserbyid, get, user, by, id` (existing >1-char filter unchanged). Deterministic string
  splitting — no new tuning constants; the existing BM25 parameters are reused untouched, and IDF
  naturally weights the now-frequent sub-tokens (no manual re-weighting introduced).
- Index/query symmetry is structural: there is one `tokenize`, already shared by all corpora —
  the change lands in that single function, and a test pins that a compound indexed under the new
  tokenizer is found by both its compound and each sub-token.
- **Tokenizer-version skew rebuilds, never mixes.** The persisted text index gains a
  tokenizer-version stamp; on mismatch the index is rebuilt rather than queried — mirroring the
  existing model-changed deferral discipline in `updateFiles` (`vector-index.ts:560-572`), which
  refuses an incremental update when the embedding model changed rather than mixing dimensions.
  In-memory BM25 corpora (rebuilt per process) need only the stamp check where a corpus is
  persisted or cached across versions.
- **Cleanup:** delete the dead RRF accumulation (`:808-825` score writes); the recomputed-ranks
  path (`:830-840`) is the single source of merge scores. Behavior identical, pinned by a
  hybrid-search snapshot test.
- Recall tests with identifier-shaped queries: `user` finds `getUserById`; `getUser` finds it;
  `get_user_by_id` and `get-user-by-id` behave identically; exact compound queries still rank the
  exact match at least as well as today.

## Why this is in scope

The zero-config default is the substrate's first impression, and its honesty story
("keyword mode, disclosed") currently hides a recall cliff exactly where coding agents query
hardest: identifiers. Fixing the tokenizer is deterministic, local, constant-free precision work
on an existing capability — the same class as the call-resolution hardening — and the
version-stamped rebuild reuses an established discipline instead of inventing one.

## Impact

- Files: `src/core/analyzer/vector-index.ts` (`tokenize`, RRF cleanup, tokenizer-version stamp in
  index meta), consumers via the shared import (`text-line-index.ts`, spec BM25 path) get the fix
  for free; recall + symmetry + snapshot tests.
- Specs: `analyzer` — 1 ADDED requirement (IdentifierAwareKeywordTokenization).
- Tool surface: unchanged (search_code/search_specs behavior improves; no new tool, no
  payload-budget impact).
- Risk: low-medium. Sub-tokens grow corpus vocabulary (memory/index size — measure and report,
  no unmeasured claims); ranking shifts for queries that previously matched only compounds are
  intended and covered by the recall suite; one-time index rebuild on upgrade is disclosed via the
  version stamp, not silent.
