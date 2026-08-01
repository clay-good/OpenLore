# Fix the injection relevance gate: it can never fire in the zero-config default mode on small repos

> Status: PROPOSED (2026-07-27, first-run e2e). The task-scoped pre-turn injection
> (`orient --inject`, wired by install as the `UserPromptSubmit` hook — the "first turn begins
> already oriented" flagship) is gated by a relevance check that has **no satisfiable branch in
> keyword (BM25) retrieval mode on a small repo**. BM25 is the zero-config default since
> `make-embeddings-zero-config`, and a first-time user's repo is exactly where hubs and fan-in ≥ 2
> don't exist yet. Net effect: every zero-config first-run user gets the generic pointer line on
> every prompt — even a prompt that names a function verbatim — and the flagship feature is dead
> weight for precisely the audience install optimizes for.

## The gap

Reproduced on a clean sandbox (5 functions, fresh `install`): the hook payload
`{"prompt":"fix the bug where chargeCard rejects zero amounts"}` — an exact identifier mention —
emits only the pointer line. Root cause is structural, not tuning:

- `passesRelevanceGate` (`src/cli/commands/orient-inject-render.ts:139-154`) passes only when
  (a) a matched function is a hub, (b) max fan-in ≥ `relevanceMinFanIn` (default 2,
  `orient-inject-render.ts:33`), or (c) `searchMode === 'hybrid'` and score ≥ 0.3. The score
  branch is deliberately hybrid-only ("Score is only comparable to a fixed threshold on the
  bounded hybrid scale") — BM25 scores are unbounded, so in `bm25_fallback` mode the gate reduces
  to hubs-or-fanIn≥2.
- On the zero-config default (keyword mode, no `openlore embed --local`), a repo whose matched
  functions all have fan-in < 2 — any small repo, and many perfectly relevant matches in large
  ones — can NEVER produce a full injection block. The prompt's exact naming of `chargeCard`
  (BM25 rank 1, its identifier tokenized and matched) counts for nothing.
- The failure is silent: the hook emits the pointer line, and nothing anywhere records that a
  block was suppressed or why. A user cannot distinguish "no graph", "weak match", and
  "strong match, structurally ungateable".

Adjacent open work does not cover this: `refine-orient-context-budgeting` refits the *budget*
half (exact-fit rendering, cold-start breadth), not the gate; the shipped
`add-task-scoped-context-injection` introduced the gate in the pre-BM25-default world and was
never revisited when keyword became the default retrieval mode.

## What changes

- **The gate gets a mode-independent, scale-free evidence branch: exact identifier mention.**
  When the prompt contains a matched function's exact name (already computable from the tokenized
  prompt and the match's `name` — binary, no new threshold), the gate passes regardless of
  retrieval mode, hub status, or fan-in. A verbatim mention is the strongest relevance evidence
  the substrate can observe deterministically.
- **The keyword mode gets a decidable rank-evidence branch.** In keyword mode the gate MAY also
  pass on rank-based evidence that is scale-free by construction (e.g. the top match's tokens
  intersect the prompt's identifier-shaped tokens) — never on a raw BM25 score compared to a
  fixed constant, which stays forbidden for the documented reason.
- **Suppression becomes observable.** `orient --inject` under an opt-in debug switch (env var or
  flag) reports the gate verdict and the failing criterion to **stderr** (stdout stays reserved
  for the injected block). The pointer line itself is unchanged.

No new tuning constants; the two new branches are binary predicates over data the result already
carries.

## Impact

- Affected specs: `cli`
- Affected code: `src/cli/commands/orient-inject-render.ts` (`passesRelevanceGate`,
  `INJECTION_DEFAULTS` docs), `src/cli/commands/orient-inject.ts` (debug reporting),
  Pi extension parity: the injection block in `src/pi/extension.ts` consumes the same render
  module — verify the shared gate change carries over (MCP ↔ Pi parity rule)
