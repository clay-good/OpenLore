# Persist the tokenized keyword corpus: make the tokenizer-version stamp guard a real serve-time artifact, not just the incremental lane

> Status: SHIPPED (2026-07-18, PR #222; status reconciled 2026-07-19). Originally proposed (2026-07-18). Follow-up to the shipped `fix-bm25-identifier-tokenization`
> (PR #221). That change added an identifier-aware tokenizer and a `TOKENIZER_VERSION` stamp, and
> its spec (`analyzer` › IdentifierAwareKeywordTokenization) states that "The persisted text index
> SHALL carry a tokenizer-version stamp, and a version mismatch SHALL trigger a rebuild rather than
> serving mixed-token results." **But no persisted token corpus exists** — every keyword search
> rebuilds the corpus in memory from persisted RAW TEXT on the first query per process, so the
> stamp today guards only the incremental-patch lane, not serving. This change builds the persisted
> corpus the shipped spec's language already implies: a serialized BM25 corpus stamped with the
> tokenizer version, loaded on cold start instead of re-tokenizing, and rebuilt-not-served on skew.
> Deterministic, local, no new tuning constants. Grounded in the north star (`overview/spec.md`,
> decision `c6d1ad07`).

## The gap

- **The "persisted text index" the shipped spec guards does not exist.** Every BM25 search
  rebuilds `Bm25Corpus` from scratch by re-tokenizing the persisted raw `text` column on the first
  query in each process: the hybrid cold path (`vector-index.ts:848-857`) and `_bm25Only`
  (`vector-index.ts:926-935`) both do `table.query().toArray()` → `buildBm25Corpus(...)`. Tokens
  are never serialized. Because the corpus is always freshly, uniformly re-tokenized, serving is
  never mixed — which is exactly why the `TOKENIZER_VERSION` stamp added by
  `fix-bm25-identifier-tokenization` guards only the incremental `updateFiles` lane
  (`vector-index.ts:618-627`) and nothing at serve time. The shipped scenario "Tokenizer skew
  rebuilds, never mixes" is satisfied by re-tokenization, not by the persisted-stamp mechanism its
  own text describes. The stamp is a promise about an artifact that isn't there.
- **Cold start pays a full re-tokenization every process.** `buildBm25Corpus`
  (`vector-index.ts:203-221`) tokenizes every document and builds N per-doc term-frequency maps
  plus the document-frequency map — O(total corpus text) CPU. A warm daemon pays it once per
  lifetime; **every fresh `openlore search`/`orient` CLI invocation pays it in full**, on the
  zero-config keyword path that every embedder-less install hits.

## What changes

**Serialize the BM25 corpus to a stamped sidecar; load it on cold start; rebuild-not-serve on
tokenizer skew — so the stamp finally guards a real serve-time artifact.**

- **One shared serializer/deserializer** beside `buildBm25Corpus` (`vector-index.ts`): a
  `Bm25Corpus` ⇄ JSON pair that converts the per-doc `tfMap`/`df` `Map`s to arrays and back,
  deterministically. The sidecar carries `tokenizerVersion` (= `TOKENIZER_VERSION`) and a corpus
  **schema version** (so the serialization format can evolve independently of the tokenizer).
- **Write at build time.** `VectorIndex.build` writes the sidecar (`bm25-corpus.json` inside the
  index folder) after it writes the table + meta, for both the BM25-only and embedded builds.
- **Load-or-rebuild on the cold path.** The two `buildBm25Corpus`-from-raw-text sites become
  load-or-rebuild: if the sidecar exists AND its `tokenizerVersion` matches the running
  `TOKENIZER_VERSION` AND it parses, hydrate the corpus from it (no document re-tokenized);
  otherwise fall back to the current rebuild-from-raw-text path and re-persist. A missing sidecar
  (legacy index), a corrupt sidecar, or a version mismatch all degrade to rebuild — **never a hard
  failure, never a served stale corpus.**
- **Invalidate on incremental patch.** `patchBm25Cache` (`vector-index.ts:269-276`) deletes the
  sidecar so the next cold start rebuilds from raw text rather than loading a corpus that predates
  the patch. Re-persisting on every watcher batch is intentionally NOT done here (see boundaries).
- **No new tuning constants**; `TOKENIZER_VERSION` is reused, the corpus schema version is a
  format stamp, not a tuning knob. The in-memory `_bm25Cache` lifecycle is unchanged — the corpus
  is still hydrated once per process; only its *source* changes (sidecar vs. re-tokenization).

## Boundaries (disclosed, not silently scoped out)

- **Serving still reads all rows from LanceDB.** The row data (`rowById`, `rowToRecord` fields, and
  the dense vector for hybrid) still comes from `table.query().toArray()`. The sidecar removes the
  tokenization/corpus-construction CPU, **not** the table read — measured, not assumed (see tasks).
- **Text-line and spec keyword corpora are a mechanical follow-up.** `text-line-index.ts:248` and
  `spec-vector-index.ts:518-521` rebuild their corpora from raw rows the same way and would reuse
  the very same shared serializer. Deferred to keep this PR bounded; disclosed so the gap is known,
  not hidden. The requirement below is written about the mechanism so the follow-up needs no spec
  re-drift.
- **In-process cross-analyze cache invalidation stays with `optimize-serving-hot-path-caches`**
  (item c / fix 3: column projection excluding `vector`, top-k early termination, incremental df
  patching, and the mtime/attestation check so an external `analyze` invalidates a long-lived
  server's corpus). This change does not alter the per-query scan algorithm or the `_bm25Cache`
  invalidation contract; it inherits whatever that change lands. Coordinate to avoid a merge
  conflict in `vector-index.ts`.

## Considered alternative

Rather than build the artifact, the shipped `IdentifierAwareKeywordTokenization` scenario could be
**reworded** to describe reality (re-tokenize from raw text each process; the stamp guards the
incremental lane). That is the smaller change and is honest. It is rejected here because the user
asked to build it fully, the persisted corpus is the substrate's stated design, and it removes a
real per-invocation CPU cost on the default path. The reword is noted so the choice is explicit.

## Why this is in scope

The substrate's honesty contract is that a stamp means something. Today `TOKENIZER_VERSION` is
written to disk but consulted only on the incremental lane, while the spec advertises it as the
guard on a persisted served index. Building that index makes the claim true, is pure deterministic
local serialization (no LLM, no network, no new dependency), and pays down a cold-start cost on the
zero-config keyword path — the first impression of every embedder-less install.

## Impact

- Files: `src/core/analyzer/vector-index.ts` (shared corpus serializer/deserializer; sidecar write
  in both `build` branches; load-or-rebuild at the two cold paths `:848-857` / `:926-935`; sidecar
  delete in `patchBm25Cache`). Tests: hydrate/skew/corrupt/patch-invalidation + a measured
  cold-start CPU delta.
- Specs: `analyzer` — 1 ADDED (PersistedKeywordCorpusGuardedByTokenizerStamp). Complements, does
  not modify, the shipped IdentifierAwareKeywordTokenization requirement.
- Tool surface: unchanged (no new tool, no payload-budget impact; `search_code` behavior identical,
  faster cold start).
- Risk: low-medium. The one hazard is a stale sidecar; the integrity contract is "present ⇒ valid,"
  enforced structurally (build overwrites, patch deletes) and backstopped by version-stamp checking
  and parse-failure fallback to rebuild. No behavior change for any query result.
