# Enforce the conclusion contract at dispatch and close the adjacency-group gaps

> Status: SHIPPED (2026-07-18, PR #233; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). The conclusion-over-graph contract's runtime check
> exists but is never called in production, and the NoRedundantConclusions adjacency table misses
> two genuinely-adjacent pairs — including one on the default surface. Wires the existing check
> into the dispatch path (advisory by default, strict in CI) and completes the table. No new
> tool, no LLM. Grounded in `mcp-quality` ToolsReturnConclusionsNotGraphs and
> NoRedundantConclusions.

## The gap

**(a) The checked invariant isn't checked.** `tool-contract.ts:9-16` documents that the module
"turns that convention into a checked invariant" via `assertConclusionShape` (`:354`), which
rejects a `conclusion` tool's response that regresses into a `nodes[]`+`edges[]` graph dump or an
over-bound raw edge array. But the function has **zero non-test callers** —
`tool-dispatch.ts` imports only `resolveCanonicalToolName` (`:20`), and the companion test admits
it runs on synthetic objects only (`tool-contract.test.ts:5-9`: "they do not invoke handlers
against the live `.openlore/analysis` fixture"). A handler that regresses into a graph dump at
runtime is caught by nothing; the invariant is aspirational exactly where it matters.

**(b) NoRedundantConclusions is under-enforced.** `ADJACENT_TOOL_GROUPS` (`tool-contract.ts:
280-291`) registers four groups, but omits two genuinely-adjacent pairs:

- **`find_path` / `trace_execution_path`** — both return a point-to-point path conclusion, both on
  wide surfaces (`find_path` is in the default `substrate` preset). `trace_execution_path`'s
  description cross-references only `get_subgraph` (`mcp.ts:383-388`); `find_path`'s names **no
  sibling at all** (`mcp.ts:1454-1459`). A selecting agent sees two path tools with no stated
  distinction.
- **`audit_spec_coverage` / `check_spec_drift`** — the family table's own classification comment
  pairs them ("like its sibling audit_spec_coverage", `tool-contract.ts:220-222`), yet no
  adjacency group registers the pair.

Additionally the group test (`tool-contract.test.ts:124-137`) requires each member to name only
**≥1** sibling, so in a 3+-member group a member can silently omit a genuinely-confusable sibling
— mutual legibility rests on author diligence, not the guard.

## What changes

1. **Wire `assertConclusionShape` into `dispatchTool`** as a post-handler check, before the
   byte-cap serialization (`mcp.ts:2604` `capStructuredResult`). Fail-safe by doctrine
   (AdvisoryByDefault): in production a violation logs and attaches a governance-finding-shaped
   disclosure to the response (stable code `conclusion-shape-violation`, registered in
   `FINDING_CODE_REGISTRY` with intrinsic severity, advisory default — an operator can gate on it
   via `enforcement.policy`); the response still returns, since dropping a working answer to
   punish its shape would harm the agent the contract protects. In CI/tests the check runs strict
   (throw), so a regressing handler fails the suite.
2. **Register the two missing adjacency groups** — `['find_path', 'trace_execution_path']` and
   `['audit_spec_coverage', 'check_spec_drift']` — and add the mutual cross-references to all four
   descriptions (each states its distinct question and names the sibling).
3. **Strengthen the group test to all-pairs**: every member's description names **every** sibling
   in its group, so a 3-member group cannot pass on one lucky mention.

## Why this is in scope

ToolsReturnConclusionsNotGraphs is the substrate's core quality claim — the server does the
traversal so the agent never has to. A contract whose runtime check is dead code protects nothing;
this change makes the module's own docstring true. The adjacency completions are the
NoRedundantConclusions requirement applied to its two known blind spots, one of them on the
default surface where selection confusion costs the most.

## Impact

- `src/core/services/tool-dispatch.ts` (post-handler check), `mcp.ts` (two description edits),
  `tool-contract.ts` (two groups), `enforcement-policy.ts` (`conclusion-shape-violation` code),
  `tool-contract.test.ts` (all-pairs), dispatch-path test for the strict/advisory modes.
- Specs: `mcp-quality` — 2 ADDED requirements (ConclusionShapeIsEnforcedAtDispatch,
  AdjacentConclusionsCrossReferenceAllPairs).
- Risk: low. The check is O(top-level values) per response; description edits grow tools/list
  bytes slightly — the payload-budget guardrail (`mcp-presets.test.ts`) bounds it and may need its
  documented ceiling nudged. Advisory default means no behavior break for existing agents.
