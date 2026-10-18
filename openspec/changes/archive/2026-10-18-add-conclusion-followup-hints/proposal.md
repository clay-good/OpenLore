# Data-dependent follow-up hints: a conclusion that warrants a next check says so, with a receipt

> Status: SHIPPED (2026-10-18). Proposed 2026-07-03 (e2e audit pass 3). Conclusion payloads already contain the fields
> that make a specific next tool call warranted — a search hit that is a hub, a dead-code
> candidate at low confidence, a blast radius naming specs that will go stale — but the agent has
> to know the tool catalog cold to act on them. Add a CLOSED, source-declared rule table that
> attaches at most 1-2 deterministic follow-up hints to a conclusion payload, each citing the
> triggering field value. Prior art: Octocode's result-dependent next-query suggestions
> (https://github.com/bgauryy/octocode), adapted fully deterministic.

## The gap

- **The payload knows; the surface doesn't say.** A `search_code` hit carries `fanIn`, `isHub`,
  `role` (`semantic.ts:51-54`, `classifyRole` `:57-68`) — an agent about to edit a hub hit should
  run `analyze_impact` first, but nothing in the response points there. A `find_dead_code`
  candidate carries a `confidence` level with documented blind spots (`reachability.ts:14-28`);
  the structural cross-check (`report_coverage_gaps`, whose gap labels include `also-dead`) is
  never suggested. `blast_radius` reports `specs.willGoStale` with items capped at 20
  (`blast-radius.ts:301`, cap receipt `:272-273`); the tool that returns the full per-requirement
  detail (`check_spec_drift`) goes unnamed in the moment it matters.
- **The existing cross-references are static.** The NoRedundantConclusions sibling
  cross-references (change `unify-navigation-and-governance-substrate`, its `mcp-quality` delta)
  live in tool *descriptions* — docs-level, always the same text. What's missing is the
  data-dependent form: a hint that fires only when THIS response's fields warrant it.

## What changes

- **A closed rule table, `FOLLOWUP_HINT_RULES`,** in a source-declared module beside
  `tool-contract.ts` — the `FINDING_CODE_REGISTRY` style (`enforcement-policy.ts:81`): every rule
  names its tool, its predicate over fields ALREADY PRESENT in that tool's payload, the tool it
  suggests, and a message template. No rule may introduce a threshold: predicates read existing
  classifier outputs (`isHub`, `role`, `confidence`, `specs.willGoStale > 0`) — the thresholds
  behind them (e.g. `HUB_HIGH_FAN_IN_THRESHOLD`, `constants.ts:446`) stay where they are and are
  not re-tested downstream.
- **Hints are receipts, not advice:** each emitted hint is
  `{ tool, trigger: { field, value }, message }` — e.g.
  `{ tool: "analyze_impact", trigger: { field: "topHit.fanIn", value: 74 }, message: "top hit is a hub (fanIn 74): check impact before editing" }`.
  Capped at 2 per response, deterministic tie-break by rule order in the table.
- **Applied at the dispatch layer** where the conclusion contract is already enforced
  (`assertConclusionShape`, `tool-contract.ts:354`) — one injection point, no per-handler logic.
  A `tool-contract.test.ts`-style guard pins the table closed: a rule naming an unknown tool or a
  field absent from the payload shape fails CI.
- Initial table (small, by design): the three rules above. Growing it is a table edit reviewed
  against this requirement, not new machinery.

## Why this is in scope

`mcp-quality` already demands conclusions over graphs (`ToolsReturnConclusionsNotGraphs`, base
spec:369) and token-disciplined output (Output Token Budgeting, base spec:145). A hint that fires
off fields the payload already carries is the cheapest possible increment of conclusion quality:
zero new analysis, deterministic, and it routes the agent to the sibling tool exactly when the
static cross-reference would have been too late or unread.

## Impact

- Files: new `src/core/services/mcp-handlers/followup-hints.ts` (rule table + evaluator),
  dispatch-layer injection beside `assertConclusionShape` (`tool-contract.ts:354`), table-closure
  guard test.
- Specs: `mcp-quality` — 1 ADDED requirement (DataDependentFollowupHints); cross-references
  ToolsReturnConclusionsNotGraphs and the (pending) NoRedundantConclusions sibling-reference
  requirement — this change is its data-dependent complement, not a replacement.
- Tool surface: no new tool; tool descriptions untouched, so the tools/list full-prefix ceiling
  (88,000 B, `mcp-presets.test.ts:581` — a ceiling this repo has consciously bumped
  84,000 → 86,000 → 88,000) is unaffected; the assertion is re-run to prove it. If a shared
  description line documenting the `followUp` field is added instead, the budget is re-measured
  and any bump justified in the same comment trail.
- Risk: low. Response payloads grow by at most 2 small objects (within the Output Token
  Budgeting discipline); a wrong hint is advisory noise, never a gate; the closed table plus CI
  guard prevents hint sprawl.
