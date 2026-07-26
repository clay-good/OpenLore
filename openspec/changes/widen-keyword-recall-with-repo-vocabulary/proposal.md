# Widen keyword recall with the repository's own vocabulary: close the natural-language gap without an embedder

> Status: PROPOSED (2026-07-25, known-limitations closure #4 of 6). Keyword (BM25) is the
> first-class default and semantic is the opt-in upgrade — a deliberate, correct choice for a
> local-first tool. But the default's actual weakness is narrow and fixable: the tokenizer
> splits identifiers into sub-tokens yet does no stemming or expansion, so a natural-language
> task query reaches `chargeCard` (→ `charge`, `card`) but misses genuinely abbreviated code
> (`PmtSvc` → `pmt`, `svc`) — on the exact query shape `orient(task)` receives every prompt. This change mines an **abbreviation and co-occurrence lexicon from
> the repository itself** during analyze, and uses it for deterministic query expansion at
> search time. No model, no download, no API key, no network — the same answer on every
> machine. Semantic remains the opt-in upgrade; it stops being the *only* upgrade.

## The gap

- **The tokenizer is purely lexical, and that is the whole vocabulary.** `tokenize`
  (`src/core/analyzer/vector-index.ts:184-202`) splits on non-alphanumerics, lowercases, keeps
  the compound, and adds camelCase sub-tokens. There is no stemming, no abbreviation expansion,
  no synonymy, and no query-side expansion of any kind — index and query go through the identical
  function (`:181`). Sub-token splitting already covers the easy case; what scores zero is a
  query term that is not a sub-token of any identifier or comment, however obviously related.
- **The mismatch is structural, not incidental.** BM25 is *excellent* at exact identifier lookup
  and domain jargon — which is exactly why it is the right default — and correspondingly weak
  where the query vocabulary and the code vocabulary differ. Code vocabulary differs from natural
  language by construction: developers abbreviate (`cfg`, `svc`, `txn`, `auth`, `repo`), and the
  same concept appears as a noun in a class name and a verb in a method name.
- **This weakness lands precisely on the product's highest-traffic path.** `orient(task)` is
  invoked with a natural-language task description — that is the entire pitch, and the
  `UserPromptSubmit` hook fires it on *every* prompt.
- **This is a recall gap, and it is NOT the published loss case.**
  `docs/AGENT-BENCHMARKS.md:139-166` diagnoses the small/familiar-repo loss as a *forced extra
  orient round-trip* on a trivial question — correctness was already `100% = 100%`
  (`README.md:176`) — and states the loss "is not 'fixable' without an unreliable
  skip-heuristic." Widening recall cannot remove a round-trip and may add response tokens, so
  this change does **not** target that loss and MUST NOT be measured against it. Claiming
  otherwise would be a savings claim the benchmark did not produce, which the honesty contract
  forbids. The claim made here is narrower and separately measurable: on natural-language task
  queries against repositories with abbreviated identifiers, keyword mode today returns zero for
  a related-but-non-substring term.
- **Today's only remedy costs a download and a decision.** `openlore embed --local` is
  genuinely low-friction (bundled CPU embedder, ~23 MB pinned model), but it is still an explicit
  action, a disk cost, and a slower index build — and it is offered as the *only* way to improve
  recall. There is a large deterministic gain available before that point that the product does
  not take.
- **The technique is old, well-studied, and needs no model.** Vocabulary normalization —
  splitting identifiers and expanding each part to a dictionary word — measurably improves
  IR-based concept location (Lawrie & Binkley, "Expanding Identifiers to Normalize Source Code
  Vocabulary", ICSM'11, http://www.cs.loyola.edu/~binkley/papers/icsm-11-normalization.pdf).
  AMAP (Hill et al., https://dl.acm.org/doi/pdf/10.1145/1370750.1370771) mines abbreviation
  expansions **from the program itself** — the same repository OpenLore has already parsed —
  rather than from an external dictionary. Query expansion over BM25 is standard IR practice.
  Every input this needs is already in the graph.

## What changes

**1. A repository vocabulary artifact, mined during analyze.** One pass over material the
analyzer already holds — identifiers, doc comments, string literals used as keys, and file paths —
produces a deterministic lexicon:

- **Abbreviation → expansion**, mined AMAP-style from *in-repo evidence only*: a short token is
  linked to a long one when the short is a subsequence of the long, the pair clears four
  measured guards (short ≥ 3 chars, shared first character, long ≤ 3× short, ≥ 2 attesting
  binding sites — without which `id` links to 2,360 forms and `db` links to `debug`), and the two
  co-occur in a binding position the analyzer already knows (a declaration and its doc comment, a parameter and
  its type name, a variable and the function it is assigned from). `cfg`↔`config`,
  `svc`↔`service`, `txn`↔`transaction` are *discovered*, never hard-coded. A tiny, explicitly
  listed set of universal programming abbreviations may seed the lexicon; everything else must be
  evidenced in the repository.
- **Term co-occurrence**, from identifier tokens appearing together in one symbol's name, its
  doc comment, and its immediate call neighborhood — the graph-aware half a plain text index
  cannot compute.
- **Morphological variants** by conservative, rule-based stemming restricted to English suffix
  families (`-s`, `-ing`, `-ed`, `-er`, `-tion`) applied only when both forms are attested in the
  repository, so no non-English or domain token is mangled.

The lexicon is persisted next to the BM25 corpus sidecar, is byte-deterministic for a given
repository state, and carries **both** a format-version stamp and a content stamp — a version
stamp alone cannot detect that the *repository* moved, and the incremental path patches the index
without re-running analyze, so a format-only guard would serve a stale lexicon indefinitely.
Mining is bucketed (not all-pairs) and runs under a declared wall-clock budget, emitting a
`partial` lexicon with a disclosed omitted count rather than overrunning the analyze.

**2. Deterministic query-side expansion.** At search time only — the index is untouched, so no
re-index is required and index size does not grow — query tokens are expanded through the
lexicon, and ranking is **two-tier, not weighted**: an original score and an expansion score are
computed separately, and any document matching an original term sorts above every expansion-only
document. A scalar down-weight cannot deliver that — the scoring function sums over terms without
bound, so five high-idf expansion matches beat one weak original match at any non-trivial weight,
and the hybrid path discards magnitudes entirely by fusing ranks. The tiering is applied before
candidate truncation so an original match can never be evicted from the window. Expansion is
bounded per token, and the terms that actually **scored** are returned with the results.

**3. Retrieval-mode disclosure gets more honest, not just more capable.** The served mode
becomes `keyword` / `keyword+vocabulary` / `local-semantic` / `remote-semantic`, so a caller can
always tell which recall regime produced an answer. Both the existing hints — pointing users at
`openlore embed --local` — stay exactly as they are; expansion is not sold as a replacement for
semantic retrieval.

**4. An escape hatch and a measurement.** A config flag disables expansion outright, and the
`openlore prove --estimate` path gains a retrieval-recall comparison over the repository's own
symbol/doc-comment pairs so the gain is *measured on the user's repo*, never asserted from ours.

**Explicitly NOT built:** an external dictionary or WordNet dependency; an LLM-generated synonym
list; learned or statistical relevance feedback (nondeterministic across runs); index-side
expansion (bloats the corpus and forces a re-index); and any change to the default retrieval
mode's identity — keyword stays the default, and semantic stays the opt-in upgrade.

## Why this is in scope

The retrieval layer feeds `orient`, and `orient` is the product. This makes the zero-config
default measurably better on exactly the query shape the product receives most, using only
material already extracted, with no network, no model, no key, and full determinism — the same
constraints every other capability in the substrate honors. It is measured as a retrieval-recall
change on the user's own repository — explicitly *not* against the published agent-cost loss
case, which the benchmark attributes to a forced round-trip that no recall work can remove.

## Impact

- **Files:** a new `repo-vocabulary.ts` miner invoked from the analyze pipeline (reusing the
  Pass-1 identifier/doc-comment material), a lexicon sidecar written next to the BM25 corpus with
  a version stamp, query expansion in the BM25 query path (`vector-index.ts`,
  `spec-vector-index.ts`), retrieval-mode reporting in `mcp-handlers/semantic.ts` (`:206-207`,
  `:292-293`, `:538-539`) and `orient.ts`, a config flag, `openlore prove --estimate`, and
  `docs/providers.md` / `docs/configuration.md`.
- **Specs:** `analyzer` — 2 ADDED (RepositoryVocabularyIsMinedDeterministicallyFromTheRepository,
  VocabularyExpansionIsQuerySideBoundedAndDownWeighted); `mcp-handlers` — 1 ADDED
  (RetrievalModeAndExpansionAreDisclosedPerResult).
- **Tool surface:** unchanged — no new tool. `search_code` / `search_specs` / `orient` responses
  gain the expansion terms used, inside their existing disclosure field.
- **Performance:** one additional pass over already-resident tokens at analyze time (bounded, and
  skippable); at query time, a bounded lexicon lookup per token — no extra corpus reads.
- **Sequencing:** lands after `refine-search-serving-quality`, which rewrites the same
  per-result disclosure block (`semantic.ts:538-559`) and owns `scoreKind`; the two-tier ordering
  SHALL be expressed in terms of that change's score disclosure rather than a second parallel
  score shape.
- **Interaction:** the lexicon is a repository-wide artifact; under
  `scale-analyze-to-workspace-shards` it must be recomputed whole or retained and reported, never
  mined from a single shard.
- **Risk:** (a) *precision loss from a bad expansion* — mitigated by down-weighting (exact
  matches always rank first), a per-token cap, requiring in-repo evidence for every entry, and
  the disable flag. (b) *nondeterminism* — mitigated by mining only from deterministic inputs
  with a stable ordering and version stamp, covered by the existing analyze-twice byte-diff
  e2e. (c) *undermining the semantic upgrade path* — mitigated by keeping both hints and by
  disclosing the served mode, so the upgrade stays visible and honestly described.
