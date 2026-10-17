# Design

## Context

See `proposal.md` — Why. The substrate this change needs already exists:

- `src/core/analyzer/retrieval-evidence.ts` (`change: add-retrieval-match-evidence`) attaches a
  `MatchEvidence { field, terms, tier }` to every result, with `RetrievalTier = 1 | 2 | 3` and
  `LEXICAL_MATCH_FIELDS = ['symbol', 'path', 'signature', 'doc', 'body']`. `requireMatchEvidence`
  already drops a row that cannot show why it matched.
- `src/core/services/mcp-handlers/retrieval-miss.ts` already answers "why did this not come back",
  given a query and an expected target.
- `mcp-quality` already carries `NoFalseCompleteness` and enforces the conclusion shape at dispatch
  (`ConclusionShapeIsEnforcedAtDispatch`).

So the verdict is a fold over evidence that is already computed per result. Nothing new is measured.

## Goals / Non-Goals

**Goals:**

- Make "not covered" a first-class answer with the same standing as a result set.
- Keep the derivation mechanical: field and tier, nothing else.
- Route the caller to the tool that answers their question kind, or admit that none does.

**Non-Goals:**

- No relevance tuning, no score threshold, no configurable cut-off. A threshold would be a knob that
  drifts and that nobody can justify; the evidence tiers are already the product's own statement of
  match strength.
- No question classification by an LLM. The question kind comes from the caller's own request shape
  or an explicit parameter, never from inferring intent out of free text.
- No change to ranking or to which rows are indexed.

## Decisions

**1. The verdict folds evidence, it does not score it.**
`covered` = at least one result carries evidence on a strong field (`symbol`, `path`, `signature`) or
a tier-1 match. `weak` = results exist, but every one rests on `body`/`doc` low-tier evidence.
`uncovered` = after `requireMatchEvidence`, nothing survives. This makes the verdict a total function
of data already on each row, so two runs cannot disagree and no repository needs tuning.
*Alternative considered:* a normalized score with a threshold. Rejected — it introduces exactly the
confidence number the north-star decision (c6d1ad07) rules out, and it would make the verdict
repository-dependent.

**2. An `uncovered` verdict withholds the list rather than labelling it.**
A labelled list still gets read as an answer; the list *is* the false coverage. The response carries
the reason, the question kind, and a pointer to the miss explainer that can say which field would
have had to match.
*Alternative considered:* return the list with `coverage: 'uncovered'`. Rejected — every observed
failure on 2026-09-20 was a caller acting on a plausible-looking list.

**3. The question kind is declared by the caller, defaulted by the handler, never inferred.**
Handlers whose kind is fixed supply it themselves (`analyze_impact` is always `who-calls`). Search
and orient accept an optional kind and otherwise default to `where-is`, which is what an unqualified
query means. No free-text intent classification enters the path.
*Alternative considered:* infer the kind from the query's wording. Rejected — that is an LLM judgment
in the retrieval path.

**4. `what-gates` is deliberately in the vocabulary with no tool behind it.**
It names the gap rather than papering over it: a caller asking what makes something appear gets told
the product does not answer that, instead of a ranked list of components. When the render-guard index
ships, that kind gains its tool and the disclosure changes with no vocabulary change.

**5. Orientation abstains on symbols only, never on the whole briefing.**
`orient` also returns specs, decisions, staleness and insertion points. An uncovered symbol search
suppresses the symbol list and the insertion points (which derive from it); the rest is unaffected,
because those parts have their own evidence.

## Risks / Trade-offs

- **A caller that depended on always getting a list** → the abstention carries the same fields plus a
  reason, so a consumer reading results defensively sees an empty list with an explanation; the
  contract test covers both shapes.
- **`weak` becomes the common verdict on small or comment-poor repositories** → acceptable and
  honest; the verdict says results rest on body-text matches, which is exactly what they do.
- **A genuinely useful body-text match now arrives labelled weak** → the results are still returned;
  only the framing changes.
- **Vocabulary drift** → the six kinds are a closed set with a contract test, like the existing
  refusal vocabularies.

## Migration Plan

Additive to every response shape. Existing consumers ignoring the new field keep working; the one
behavioral change is that an `uncovered` search returns no rows, which previously returned rows that
were, by this definition, noise.
