# Structural claim verification: make the agent's claims about code auditable

> Status: BUILT (2026-06-19) — `verify_claim` MCP tool shipped behind the opt-in `verify` preset.
> See `src/core/services/mcp-handlers/claim-verification.ts` (+ `.test.ts`). Decision: `9a8084b6`.
> Stacked on `feat/confidence-boundary-disclosure` (PR #165) for the confidence-boundary primitives.
> Phase-2 set (built after the memory + dispatch changes). Consumes the `unverifiable` verdict
> from `add-confidence-boundary-disclosure` and the grounding certificate from
> `add-trust-calibrated-context-economy`.

## Why

`add-trust-calibrated-context-economy` gives the agent evidence in one direction: OpenLore → agent
("here is proof this fact is current"). The reverse direction is missing and is just as valuable:
agent → OpenLore. When an agent is about to tell a user "this function is dead," "Y calls Z," or "this
change is safe," it is often pattern-matching, and it is sometimes wrong. There is no cheap way for the
agent to **check a structural claim against the deterministic graph and get back a verdict plus a
citation it can show the user.**

This is the difference between an agent that asserts and an agent that *verifies, then cites*. It
converts the agent's confident-wrong failure mode into checked-or-flagged, and it makes the agent's
output auditable by the human — OpenLore becomes the citation layer for claims about code, not just a
private context source.

## What changes

1. **A claim-verification capability.** The agent submits a structured structural claim —
   `{ kind: 'calls' | 'reaches' | 'dead' | 'impacts' | 'safe-to-change', subject, object? }` — and
   OpenLore returns `{ verdict: 'confirmed' | 'refuted' | 'unverifiable', receipt }`. The verdict is a
   deterministic graph computation, never an LLM judgement.

2. **The receipt is a citation.** A `confirmed` or `refuted` verdict carries the evidence behind it —
   the edges, spans, and content hashes (reusing the grounding certificate shape) and the index commit
   — in a form the agent surfaces to the user: "verified against the index at commit X: see
   `file.ts:42`." The human can audit the claim without trusting the agent's word.

3. **`unverifiable` is first-class.** When a claim depends on a blind spot (reflection, computed
   dispatch, an unindexed repo), the verdict is `unverifiable` with the boundary named — reusing
   `add-confidence-boundary-disclosure`. OpenLore never fabricates a verdict to look decisive; "I can't
   verify this statically, here's why" is a valid, trust-building answer.

4. **A loop pattern, not just a tool.** The intended use: before an agent asserts a structural fact to
   a user, it verifies the claim and cites the receipt; an `unverifiable` result tells it to hedge or
   read the source. This is the mechanism that removes the excuse to be confidently wrong.

## What does NOT change

- **No LLM in the verdict.** The claim is structured and the verdict is a graph lookup; the north star
  (`c6d1ad07`) holds. (How the agent *forms* the claim is the agent's business; OpenLore only checks it.)
- **No new tuning score.** Verdicts are `confirmed` / `refuted` / `unverifiable`, not a confidence number.
- **Opt-in surface.** The capability lands in an opt-in preset, never the minimal or first-run default.
- **Conclusion-shaped.** A verdict + receipt, never a graph to traverse; `tool-contract.ts` stays
  `conclusion`.

## Research basis

This is "unit tests for assertions about code" — the verification analogue of CI, packaged with a
citation contract for agent output. SCIP / CodeQL let you *query* the graph; this change packages a
query as a *verifiable claim with a receipt*, which is the shape an agent needs to make its own output
trustworthy to a human. The honesty of the `unverifiable` verdict is the same discipline as
`add-confidence-boundary-disclosure`.

## Application to OpenLore

- Each claim `kind` maps to an existing deterministic computation: `calls`/`reaches` to graph
  traversal, `dead` to reachability, `impacts` to `analyze_impact`, `safe-to-change` to blast-radius +
  anchored-memory orphaning.
- The receipt reuses the grounding-certificate shape (`{ symbol, filePath, lineSpan, contentHash }`)
  and the index commit.
- `unverifiable` reuses the `confidenceBoundary` known-unknowable detection.

## Out of scope

- **Verifying non-structural claims** (behavioral correctness, runtime properties). This verifies
  *structural* claims the call graph can decide.
- **Auto-forming claims for the agent.** OpenLore checks a claim; it does not invent the claim.
- **A natural-language claim parser.** Claims are structured input, not prose.
