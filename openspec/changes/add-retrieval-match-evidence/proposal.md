# Retrieval evidence: why this result surfaced, and why the one you expected did not

> Status: PROPOSED (2026-07-31, external-pattern study). Every conclusion tool OpenLore ships
> carries a receipt — except the one an agent calls first. `search_code`, `search_specs`, and
> `orient` return ranked results with no statement of *what matched*, and no way at all to ask why
> a symbol you know exists did not come back. "No receipt, no claim" is the house rule; retrieval
> is where it is not applied. Prior art: deterministic retrieval engines that surface explain-hit
> evidence per result and a target-scoped explain-miss diagnostic, both read off the real matcher.

## The gap

- **A hit states its score, not its reason.** A search result carries a number whose meaning
  depends on the retrieval mode. Even once the sibling `refine-search-serving-quality` adds
  `scoreKind` — which fixes what the number *means* — nothing says which field matched: the symbol
  name, the file path, the signature, the doc comment, the body, or a dense-vector neighbourhood.
  An agent cannot tell a name-exact hit from a body-fuzzy one, so it cannot calibrate how much to
  trust the result it is about to act on.
- **The matcher already knows and throws it away.** BM25 scoring in
  `src/core/analyzer/unified-search.ts` and the identifier-aware tokenizer (PR #221) necessarily
  compute which query terms hit which field to produce the score at all. That information is
  discarded before the result is served. This change returns it; it computes nothing new.
- **There is no way to ask why something did not surface.** This is the more common question in
  practice. An agent that knows `resolveCallSite` exists and does not get it back from
  `search_code` has exactly one move: guess, and fall back to `grep` — the file-by-file
  rediscovery `orient` exists to eliminate. The possible causes are all deterministic and all
  distinguishable — no query term matched any field; the symbol is not in the index at all; its
  language has no extractor for that capability; a `language` or `domain` filter excluded it; it
  ranked below the returned set; the result budget truncated it — and the substrate can name which
  one applies. Today it names none.
- **The failure mode is silent and expensive.** `fix-empty-orient-and-corpus-honesty` and
  `harden-grammar-load-disclosure` establish that a quiet empty result is the substrate's worst
  honesty failure. An empty *search* result is the highest-frequency instance of exactly that
  shape, and it is the one still uncovered.

## What changes

1. **`matchEvidence` on every served result** — an additive field on `search_code`, `search_specs`,
   and the search-derived sections of `orient`. Its shape is fixed and small:
   `{ field, terms, tier }` — the winning field (one of a closed enumeration: `symbol`, `path`,
   `signature`, `doc`, `body`, `vector`), the query terms that matched in query order, and the
   numeric tier so a consumer can compare without re-deriving. For a dense-vector win, `terms` is
   empty and `field` is `vector`, stated plainly rather than fabricating a lexical explanation for
   a non-lexical match.

2. **Read off the matcher, never recomputed.** The evidence must come from the same scoring pass
   that produced the ranking. A second matching path that "explains" results the real one did not
   produce is worse than no explanation, because it is confidently wrong. A test asserts the served
   evidence equals the matcher's actual winning field and matched terms.

3. **`explain_retrieval_miss` — target-scoped, never an enumeration.** Given a query *and* a named
   target (a symbol, a file, or a spec requirement), it reports the deterministic reason that target
   did not surface, from a closed cause set: `not-indexed`, `capability-unsupported-for-language`,
   `no-term-matched`, `filtered-out` (naming the filter and its value), `outranked` (naming its
   rank and the cutoff), `budget-truncated`. Invoking it without a target is a usage error — an
   open dump of everything that did not match is not a conclusion. The trace runs over the same
   matcher, tokenizer, and filter path, so the diagnosis explains the real behavior.

4. **The diagnosis explains behavior; it never changes it.** No result matches, ranks, or is
   filtered differently because diagnostics exist. Search goldens are byte-identical before and
   after, modulo the additive `matchEvidence` key.

5. **Both faces, one source of truth.** The CLI (`openlore search ... --explain`) and the MCP tool
   emit the same evidence object from the same code. A parity test pins them together, in the shape
   `conclusion-honesty-parity.test.ts` already established for staleness disclosures.

## Why this is in scope

`mcp-quality` requires conclusions, not graphs, and requires that degradation be disclosed rather
than served silently. A ranked list with no attribution is the one remaining place OpenLore hands
an agent a raw artifact and asks it to infer the reasoning. Closing it costs no new analysis: the
hit evidence is data already computed and discarded, and the miss diagnosis is a trace over the
existing path. It also makes the retrieval layer's own quality *measurable* — a prerequisite the
sibling `add-benchmark-harness-protocol` needs to gate on anything more specific than a total.

## Impact

- **Files:** evidence threaded out of `src/core/analyzer/unified-search.ts` and
  `src/core/analyzer/vector-index.ts` / `spec-vector-index.ts` into
  `src/core/services/mcp-handlers/semantic.ts` and `orient.ts`; new
  `src/core/services/mcp-handlers/retrieval-miss.ts`; `--explain` on the CLI search path; a
  CLI/MCP evidence-parity test.
- **Specs:** `mcp-handlers` — 2 ADDED requirements (per-result match evidence; target-scoped miss
  diagnosis).
- **Tool surface:** one new opt-in tool (`explain_retrieval_miss`, family `navigate`, absent from
  the default `substrate` surface per the opt-in-by-default rule). It cross-references
  `search_code`/`search_specs` as its siblings, satisfying `NoRedundantConclusions`. Tool-count
  documentation and the `tools/list` prefix ceiling in `mcp-presets.test.ts` are re-measured, and
  any bump is justified in the same comment trail.
- **Risk:** low. `matchEvidence` is additive and small; the miss tool is opt-in and read-only. The
  one real risk is evidence being mistaken for a relevance verdict, which is why the field is
  strictly structural — field, terms, tier — with no quality, confidence, or relevance value.
- **Sibling boundaries:** `refine-search-serving-quality` owns `scoreKind`, prefiltering, and
  compaction — this assumes them and adds no cache or filter machinery.
  `fix-bm25-identifier-tokenization` owns the tokenizer. `add-conclusion-followup-hints` owns what
  to do *next*; this owns why *this*.
