# Fix empty-orient and corpus honesty: a zero-match briefing explains itself, and the corpus contains only real symbols

> Status: **BUILT** (2026-08-09). Verified by 368 passing test files (7,008 tests passed,
> 2 skipped), lint, typecheck, build, and strict OpenSpec validation. A first-time user's very first `orient` can be an
> empty briefing — and today that briefing neither explains why it is empty nor suggests anything
> useful. Meanwhile the searchable function corpus quietly contains **synthetic `external::`
> nodes**, so counts are inflated and a search can hit a "function" that does not exist in the
> repo.

## The gap

Reproduced on a fresh zero-config install (keyword mode):

- **The empty result is mute.** `orient --json --task "change the greeting"` on a repo whose
  function is named `greet` returns empty `relevantFiles`/`relevantFunctions`/`callPaths`/
  `insertionPoints` — with no field explaining that the query tokens (`change`, `greeting`)
  matched nothing, and no hint that `greet` exists one token away. (The stemming gap itself is
  owned by `widen-keyword-recall-with-repo-vocabulary`; this change owns the *disclosure* when a
  miss still happens.)
- **The canned next steps are wrong for the shape of the result.** The same empty payload says:
  "Before making an architectural choice, call record_decision…" and "After implementing, run
  check_spec_drift" — decision-workflow advice attached to a briefing containing nothing to
  implement. The steps are static boilerplate, not conditioned on the result.
- **The corpus counts phantoms.** The sandbox's BM25 corpus (`bm25-corpus.json`) holds 6 entries
  for a 5-function repo: the sixth is `external::id.startsWith` — a synthetic external
  call-target indexed as if it were a searchable repo function. Consequences: the first-run
  message "Function index built [keyword] (6 functions)" disagrees with the call-graph summary
  ("Functions: 5") two lines up in the same output, and a query matching an external name (e.g.
  "startsWith") can return a phantom symbol with no file to open.

Adjacent open proposals do not cover this: `add-conclusion-followup-hints` fires on fields of
*populated* payloads (hub hit → suggest impact); `refine-search-serving-quality` owns
filter-constrained recall, score semantics, compaction, and the spec-index lane — not corpus
membership and not the empty-result contract.

## What changes

- **A zero-match orientation discloses why, deterministically.** The payload gains an
  `emptyResult` disclosure: the identifier-shaped query tokens that had no posting in the corpus,
  and — computable today with no new machinery — for each missed token, whether any indexed
  identifier *contains* it as a substring/prefix (a "near token" receipt: `greeting` → nearest
  indexed token `greet`). No ranking, no model; a bounded lookup against the existing corpus
  vocabulary.
- **Next steps are conditioned on result shape.** An empty briefing suggests the actions that
  make sense for empty (`search_code` with identifier-style terms, `get_map` for the lay of the
  land, the near-token receipt if present) and drops the decision-workflow boilerplate. Populated
  briefings keep today's steps.
- **The searchable function corpus contains repo symbols only.** `external::` synthetic nodes are
  excluded from the BM25/vector function corpus, and every user-facing function count over the
  corpus agrees with the call-graph function count (or states exactly what else it includes).

## Impact

- Affected specs: `mcp-handlers`, `analyzer`
- Affected code: `src/core/services/mcp-handlers/orient.ts` (empty-result disclosure,
  conditional next steps), `src/core/analyzer/vector-index.ts` (corpus membership, count
  message), Pi parity: the injected pointer/briefing consumes orient output — verify the empty
  contract carries over
