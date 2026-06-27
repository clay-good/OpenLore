# Deterministic recall ranking: stop losing memories to phrasing

> Status: IMPLEMENTED — shipped on branch `feat/recall-deterministic-ranking` (PR #161). Ships in **v2.1.0**.
> See the "Implementation status" section at the foot of this file for what landed, file refs, and tests.
> Memory-quality change. Complements `add-trust-calibrated-context-economy` (which governs *ordering
> under budget and trust evidence*, explicitly **not** which memories are relevant — this change fills
> exactly that gap) and `add-bitemporal-typed-memory-operations` (a `type` filter composes with this).

## Why

`recall`'s relevance function is the weakest link in OpenLore's memory path. It is literal substring
token-overlap: tokenize the task, count how many tokens appear anywhere in the haystack, rank by that
count (`memory.ts:198-208`). Concretely:

```
function relevance(queryTokens, haystack) {
  let score = 0;
  for (const t of queryTokens) if (hay.includes(t)) score++;   // binary presence, unweighted
  return score;
}
```

Three failure modes follow directly:

1. **Phrasing sensitivity.** A memory recorded as "the cache is write-through" scores **zero** for a
   task phrased "caching strategy" — no shared 3+ char token. The memory exists, is fresh, is
   perfectly relevant, and is silently dropped. The agent re-derives what OpenLore already knew. That
   is the +43% small-repo rent (`add-trust-calibrated-context-economy`) showing up as a *retrieval
   miss*, not a token-budget problem.
2. **No field weighting.** A token hit in an anchor's `symbolName` (the memory is *about* that exact
   symbol) counts the same as an incidental hit in free-text content. The strongest possible relevance
   signal OpenLore has — the structural anchor — is ignored by ranking.
3. **Binary, not graded.** A token appearing once and ten times score identically; longer memories are
   neither rewarded nor penalized. Ties collapse to recency, so ranking quality degrades exactly as a
   repo accumulates memories.

The agent-memory field's answer to this is semantic (embedding) retrieval. OpenLore deliberately keeps
the memory path **LLM-free and learned-model-free** (north star, `c6d1ad07`); the existing `VectorIndex`
(used for `search_code`) is embedding-based and so sits outside that line for the memory store. The
fix here is therefore a **better deterministic lexical ranker** — no learned model — that closes the
worst misses. Embedding-backed recall is named as a considered, deferred option, not adopted.

## What changes

1. **Field-weighted, graded scoring.** Replace binary presence-count with a deterministic score that
   (a) weights matches by field — anchor `symbolName` > tags > anchor file path > content — and
   (b) is graded by token frequency, not binary. The weights are a small fixed table, documented and
   tested; they are constants in the same sense as the navigation set's classifier thresholds, not a
   learned or tuned ranker.

2. **Exact-anchor boost — the structural lever.** When a query token exactly matches a memory's
   resolved anchor `symbolName`, that memory receives a strong deterministic boost. This is the signal
   no lexical-only tool has: OpenLore knows a memory is *about* a specific symbol, and a task naming
   that symbol should surface it first. Reuses the anchors already resolved at record time.

3. **Lightweight token normalization.** Apply deterministic normalization before matching:
   case-fold (already done), split `camelCase`/`snake_case`/`kebab-case` identifiers into subtokens,
   and strip a small fixed stopword set. This closes the "write-through" vs "write through" /
   `writeThrough` class of misses without any semantic model. Normalization is a pure function with no
   external data.

4. **Transparent scoring (no silent ranker).** `recall` SHALL be able to report, per returned memory,
   the deterministic reason it ranked where it did (matched fields + boosts), consistent with the
   "labeled signals, not a blended black-box number" discipline of the navigation set. The agent can
   see *why* a memory surfaced.

## What does NOT change

- **No LLM, no embeddings, no learned ranker.** Scoring is a documented deterministic function of
  exact and normalized token matches against weighted fields. North star (`c6d1ad07`) preserved.
- **The authoritative-recall invariant is untouched.** This change reorders *relevant* candidates; it
  never promotes a `drifted`/`orphaned` memory into the authoritative set. Freshness gating runs after
  ranking, exactly as today.
- **Selection set is a superset of today's.** Anything that matched under substring-overlap still
  matches; this change *adds* matches (via normalization/field-weighting) and *reorders*. No currently
  returned memory disappears for the same query.
- **Surface stays flat.** Rides `recall` / `orient` output; no new tool, no new default-surface entry.
- **No change to what is stored.** Ranking is computed at recall from existing fields (content, tags,
  resolved anchors); the memory schema is unchanged by this proposal.

## Research basis

The agent-memory field treats retrieval quality as the core problem and answers it with embeddings.
OpenLore's constraint is the opposite: determinism is non-negotiable, so the answer is a *better
deterministic ranker*, not a semantic one. Two transferable ideas survive that constraint: field
weighting (a match in the title/anchor means more than a match in the body) and identifier-aware
normalization (code memories are full of `camelCase`/`snake_case` that naive tokenization splinters).
The structural-anchor boost is OpenLore-native: it has a relevance signal — "this memory is about this
exact symbol" — that no lexical-only memory tool possesses.

## Application to OpenLore

- Scoring replaces `relevance()` (`memory.ts:202-208`); inputs are the fields already assembled at
  recall (`memory.ts:141,157`).
- The exact-anchor boost reuses the resolved `symbolName` on each anchor (`memory.ts:214-216`).
- Normalization is a new pure helper alongside `tokenize()` (`memory.ts:198-200`); it has no external
  data and is fully unit-testable.
- The same ranker applies to decisions surfaced through `recall` (`memory.ts:145-159`) since they go
  through the same path.

## Out of scope

- **Embedding / semantic recall.** Named as a considered upgrade and deliberately deferred: it would
  introduce a learned model into the memory path that the north star has so far excluded. If pursued
  later it would be a separate proposal with its own decision record, likely behind an opt-in flag.
- **Tuning the weights with usage data.** The weight table is a fixed, documented constant set, not
  learned. Any change to it is a code+test change, not a runtime knob.
- **Ordering under a token budget.** That is `add-trust-calibrated-context-economy`; this change
  decides relevance, that one decides what survives a cap. They compose: rank here, truncate there.
- **Cross-repo or shared recall.** Local-first, per repo.

## Implementation status

**Done (branch `feat/recall-deterministic-ranking`).** All spec requirements
(`DeterministicRecallRanking`, `ExactAnchorBoost`, `TransparentRankingReason`) are satisfied and
guarded by tests.

What landed:

- **New pure ranker module** `src/core/services/mcp-handlers/memory-ranking.ts`:
  - `normalizeTokens()` — identifier-aware normalization (camelCase / PascalCase / snake_case /
    kebab-case split before lower-casing, fixed stopword set, ≥2-char tokens), with multiplicity.
  - `scoreMemory()` — field-weighted (`anchorSymbol 4 > tag 3 > anchorFile 2 > content 1`), graded
    (occurrence-capped at 3), with the `ANCHOR_EXACT_BOOST` (8) when the query names every subtoken of
    an anchored symbol. Weights are fixed, documented, exported constants — no learned/tuned ranker.
  - **Superset guarantee** via a substring fallback (`SUBSTRING_FALLBACK_WEIGHT 0.1`) applied only when
    the token score is zero, kept far below the smallest field weight so token matches always win.
- **Wired into `recall`** (`src/core/services/mcp-handlers/memory.ts`): replaced the binary
  `relevance()` / `tokenize()` with `queryTerms()` + `scoreMemory()` over per-item `RankFields` (notes
  and decisions alike). Added an optional `match: { fields, anchorBoost }` to each recalled item
  (set only when a task is given) for `TransparentRankingReason`. The authoritative/orphaned split is
  unchanged and still runs *after* ranking — verified by test.

Verification:

- **Unit** `memory-ranking.test.ts` (15 tests): normalization, field-weight ordering, graded scoring,
  the occurrence cap (a spammed token cannot run away), exact-anchor boost (including that it
  outweighs heavy content repetition), empty-query, and the cross-word-substring superset property.
- **E2E (handler)** `memory.test.ts` (+6 tests): phrasing-miss closure, anchor-vs-prose ranking with
  `anchorBoost`, decisions ranked through the same ranker, transparent `match` reason, the reason
  omitted on a no-task staleness scan, and a high-scoring *orphaned* memory still excluded from
  authoritative.
- **Surface audit:** `recall` is the only memory-ranking surface in the codebase — `orient` has no
  memory/decision/anchor path, and `tool-dispatch` only forwards to `handleRecall`. The spec's
  forward-looking "orient" mention is served by other (draft) proposals; nothing to wire today.
- **Dogfood** against this repo's real call graph: `recall("validateDirectory")` ranks the memory
  anchored to `validateDirectory` first (★boost) above a prose-only mention; `recall("directory")`
  surfaces it via camelCase normalization; freshness intact (`graphAvailable=true`, all `fresh`).
- **Full suite green:** `vitest run src` — 184 files, 3848 passed / 2 skipped / 0 failed. `typecheck`
  and `eslint` clean.

Deferred as designed: embedding-backed recall (out of scope; own proposal + decision if pursued).
