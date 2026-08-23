# Retrieval evidence: why this result surfaced, and why the one you expected did not

> Status: COMPLETE (2026-08-23). Every conclusion tool OpenLore ships
> carries a receipt — except the one an agent calls first. `search_code`, `search_specs`, and
> `orient` return ranked results with no statement of *what matched*, and no way at all to ask why
> a symbol you know exists did not come back. "No receipt, no claim" is the house rule; retrieval
> is where it is not applied. Prior art: deterministic retrieval engines that surface explain-hit
> evidence per result and a target-scoped explain-miss diagnostic, both read off the real matcher.

## Why

- **A hit states its score, not its reason.** A search result carries a number whose meaning
  depends on the retrieval mode. Even once the sibling `refine-search-serving-quality` adds
  `scoreKind` — which fixes what the number *means* — nothing says which field matched: the symbol
  name, the file path, the signature, the doc comment, the body, or a dense-vector neighbourhood.
  An agent cannot tell a name-exact hit from a body-fuzzy one, so it cannot calibrate how much to
  trust the result it is about to act on.
- **The matcher currently flattens fields before scoring.** BM25 scoring in
  `src/core/analyzer/vector-index.ts` and `spec-vector-index.ts` computes the aggregate match but
  stores one term-frequency map for the concatenated record. The 2026-08-23 implementation audit
  corrected the earlier premise that a winning field was already available. This change makes the
  existing scoring pass field-aware while preserving the aggregate term-frequency map, score, and
  ordering byte-for-byte; it does not add a second explanatory matcher.
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

## What Changes

1. **`matchEvidence` on every in-scope served result** — an additive field on symbol results from
   `search_code`, all results from `search_specs`, and the search-derived sections of `orient`.
   Literal-line results returned by `search_code` use `field: "body"`. Other consumers of these
   index results pass the same evidence through rather than implementing another scorer. Its shape
   is fixed and small:
   `{ field, terms, tier }` — the winning field (one of a closed enumeration: `symbol`, `path`,
   `signature`, `doc`, `body`, `vector`), the query terms that matched in query order, and the
   numeric tier so a consumer can distinguish the retrieval path without re-deriving it. Tiers are
   closed and stable: `1` = lexical/BM25, `2` = hybrid fusion, `3` = dense-only. For a hybrid hit,
   a non-zero lexical contribution names its winning lexical field; a dense-only candidate names
   `vector`. For a dense-vector win, `terms` is
   empty and `field` is `vector`, stated plainly rather than fabricating a lexical explanation for
   a non-lexical match. Code fields map the scored prefix and body directly. Spec title tokens map
   to `symbol`, the scored spec/domain marker to `path`, and requirement prose to `doc`; canonical
   IDs and section labels remain identity/filter metadata because the ranker does not score them.
   Lexical ties use `symbol`, `path`, `signature`, `doc`, `body` precedence. Repeated matched
   query tokens remain repeated and in query order.

2. **Attribute the ranker's contribution, never re-rank.** The repository-wide aggregate BM25
   corpus and sidecar stay byte-compatible. After that scorer selects its bounded candidate window,
   the same tokenizer allocates each candidate's exact aggregate query-term contribution across
   its scored fields. No second corpus, index query, or alternative score is built, so evidence
   cannot change or disagree with ranking and large indexes do not pay a duplicated-corpus cost.

3. **`explain_retrieval_miss` — target-scoped, never an enumeration.** Given a query, surface, and
   discriminated named target (`symbol` plus optional file, `file`, or canonical spec requirement
   id), it reports the deterministic reason that target
   did not surface, from a closed cause set: `not-indexed`, `capability-unsupported-for-language`,
   `no-term-matched`, `filtered-out` (naming the filter and its value), `outranked` (naming its
   rank and the cutoff), `budget-truncated`. Invoking it without a target is a usage error — an
   open dump of everything that did not match is not a conclusion. The trace runs over the same
   matcher, tokenizer, and filter path, so the diagnosis explains the real behavior. Ambiguous
   names return a usage error with bounded candidates. A target that did surface returns its rank
   and evidence instead of inventing a miss. Miss precedence is: unsupported language, not
   indexed, filtered out, no term matched, outranked within the ordinary candidate window, then
   truncation by that bounded window. Rank is 1-based; cutoff is the clamped requested limit.
   Presentation token budgets and the transport hard cap are outside this diagnostic because this
   retrieval trace cannot truthfully observe them.

4. **The diagnosis explains behavior; it never changes it.** No result matches, ranks, or is
   filtered differently because diagnostics exist. Search goldens are byte-identical before and
   after, modulo the additive `matchEvidence` key.

5. **Both faces, one source of truth.** A new CLI query face calls the same handlers:
   `openlore search <query> [--specs] [--json]`; `--explain <target>` selects the same target-scoped
   diagnostic and requires `--target-kind symbol|file|requirement` (plus optional `--file`). JSON
   emits the identical evidence object as MCP; human output renders those same fields. A parity
   test pins them together, in the shape
   `conclusion-honesty-parity.test.ts` already established for staleness disclosures.

## Scope

`mcp-quality` requires conclusions, not graphs, and requires that degradation be disclosed rather
than served silently. A ranked list with no attribution is the one remaining place OpenLore hands
an agent a raw artifact and asks it to infer the reasoning. Closing it adds structural attribution
to the existing scoring pass without changing its aggregate score, and makes miss diagnosis a
trace over that same path. It also makes the retrieval layer's own quality *measurable* — a prerequisite the
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
- **Risk:** medium. `matchEvidence` is additive and small, but producing it honestly requires
  candidate-local attribution that stays equivalent to the aggregate scorer. The miss tool is
  opt-in and read-only, and generation-stamp retries keep its identity and rank reads coherent
  across concurrent rebuilds. The main semantic risk is evidence being mistaken for a relevance
  verdict, which is why the field is
  strictly structural — field, terms, tier — with no quality, confidence, or relevance value.
- **Sibling boundaries:** `refine-search-serving-quality` owns `scoreKind`, prefiltering, and
  compaction — this assumes them and adds no cache or filter machinery.
  `fix-bm25-identifier-tokenization` owns the tokenizer. `add-conclusion-followup-hints` owns what
  to do *next*; this owns why *this*.
