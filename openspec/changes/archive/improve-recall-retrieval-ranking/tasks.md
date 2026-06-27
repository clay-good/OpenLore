# Tasks — Deterministic recall ranking

> Ordered independently-shippable. Call `record_decision` before step 2 (the scoring function + weight
> table is a new deterministic formula) per `CLAUDE.md`. No new tool; rides `recall` / `orient`. No
> LLM, no embeddings, no learned ranker.

## 1. Identifier-aware normalization
- [x] Add a pure `normalizeTokens()` helper alongside `tokenize()` (`memory.ts:198-200`): case-fold,
      split camelCase / snake_case / kebab-case into subtokens, strip a small fixed stopword set.
- [x] Test: `writeThrough` → {`write`, `through`}; stopwords removed; no external data read.

## 2. Field-weighted graded scoring
- [x] Replace `relevance()` (`memory.ts:202-208`) with a deterministic field-weighted, graded scorer
      over anchor symbolName > tags > anchor file path > content. Document the fixed weight table.
- [x] Guarantee superset behavior: anything that matched under substring-overlap still matches.
- [x] Test: field-weight ordering (anchor-symbol match outranks content-only match); graded (repeated
      token outranks single); superset property holds for a corpus of fixtures.

## 3. Exact-anchor boost
- [x] Apply a strong boost when a normalized query token exactly equals a resolved anchor
      `symbolName` (`memory.ts:214-216`). Reuse anchors resolved at record time; no recall-time analysis.
- [x] Test: a memory anchored to `validateDirectory` outranks prose-only mentions when the task names it.

## 4. Freshness invariant unchanged
- [x] Confirm ranking runs *before* the authoritative/orphaned split (`memory.ts:166-167`); add a test
      that a high-scoring orphaned memory is still excluded from the authoritative set.

## 5. Transparent ranking reason
- [x] Optionally attach per-memory matched-fields + boost-applied to the `recall` response, derived
      from the same scoring inputs. No LLM-generated text.
- [x] Test: reason reflects the actual fields that contributed to the score.

## 6. Docs
- [x] Document the scoring function, weight table, and normalization in the `mcp-handlers` spec.
- [x] Note embedding-backed recall as a considered-but-deferred option (own proposal + decision if
      ever pursued).
