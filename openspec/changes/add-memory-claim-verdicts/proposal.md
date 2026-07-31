# Add memory claim verdicts: a memory's evidence is re-verified at every recall

> Status: PROPOSED (2026-07-27, ecosystem research sweep). A memory can carry machine-checkable
> structural claims; `recall` re-verifies them against the current graph and serves a per-claim
> verdict. Closes the gap where the anchor stays fresh but the *fact* rots. Prior art: a major
> production agentic-memory system verifies stored citations just-in-time before use
> (https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/);
> OpenLore can do the same deterministically because it already owns both halves.

## The gap

Anchor freshness and content truth are different things, and OpenLore only checks the first.
`recall` serves a memory with a `fresh | drifted | orphaned` verdict computed from its anchors
(`src/core/services/mcp-handlers/memory.ts:176`), and an orphaned memory is never authoritative
(`memory.ts:7`, `:309`). But a memory whose anchored symbol still exists — untouched — can assert
a structural fact that has silently stopped being true: "`layoutPass` has exactly one caller",
"`handleX` never reaches the network". The anchor is byte-identical, the verdict is `fresh`, and
the content is wrong. Nothing in the store can even represent this failure, let alone detect it.

Meanwhile `verify_claim` (`claim-verification.ts:61`) already evaluates exactly these claim shapes
— `calls | reaches | dead | impacts | safe-to-change | decision-current` — deterministically
against the graph. The two faces share one substrate but not this join: a memory cannot cite the
claims that support it, and recall cannot re-run them.

## What changes

- **`remember` accepts optional `claims`** — an array of claims in `verify_claim`'s existing
  grammar (`{ kind, subject, object? }`, `claim-verification.ts:76`). No new claim vocabulary. At
  write time each claim is verified once; a claim that does not verify `true` at record time is
  refused with the receipt (you cannot store evidence that was already false), and the
  record-time receipt (graph fingerprint + verdict) is persisted with the memory.
- **`recall` re-verifies each claim** against the current graph and attaches a per-claim verdict:
  `evidence-holds` (with the fresh receipt), `evidence-refuted` (with the failing claim and the
  counter-receipt — e.g. the second caller that now exists), or `evidence-unverifiable` (subject
  no longer resolves — folds into the existing orphan lane). Verdicts are cached per
  (claim, graph fingerprint) so an unchanged graph costs one lookup, not N traversals.
- **`evidence-refuted` is a third non-authoritative lane**, distinct from `drifted` (anchor moved)
  and `orphaned` (anchor gone): the code the memory points at is intact, but a fact it asserts is
  no longer true. A refuted memory is served the way unreconciled pairs are — disclosed, never as
  clean authoritative context — and the refutation feeds the invalidation receipt if
  `add-invalidation-receipts` ships (composes; does not block).

Deliberately NOT borrowed from the prior-art system: LLM/agent-mediated verification (OpenLore's
verdicts are pure graph lookups), automatic correction-memory generation (a refuted memory is
disclosed, not silently rewritten), and natural-language citations (claims are typed, not prose).

## Why this is in scope

The exact substrate thesis (decision `c6d1ad07`): the same deterministic engine that verifies a
claim for a human (`verify_claim`) now verifies the store's own contents, with no LLM anywhere.
It strengthens the north-star differentiator — structurally-anchored, deterministically-invalidated
memory — along the one axis the anchor machinery cannot see: content-level truth.

## Impact

- Touches: `remember`/`recall` handlers (`src/core/services/mcp-handlers/memory.ts`), claim
  evaluation reused from `claim-verification.ts` (exported evaluator, no duplication),
  `AnchoredMemory` gains optional `claims` + record-time receipts (`src/types/index.ts:823` —
  additive, per the `AdditiveBitemporalMemorySchema` precedent; legacy memories = no claims, no
  new lane).
- No new tool, no tool-count change; `memory` preset semantics unchanged.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: recall latency on large stores with many claims (mitigated: fingerprint-keyed verdict
  cache; claims are opt-in per memory). Refusing false-at-write claims could surprise callers
  (mitigated: the refusal carries the same receipt `verify_claim` would return, so the caller
  learns the truth at the cheapest possible moment).
