# Tasks — add-memory-trigger-predicates

## Implementation
- [x] `types/index.ts`: additive `trigger` (closed union: fileGlob | symbolPattern | specDomain |
      withinHops) and `pinned` on `AnchoredMemory`; old records unaffected
- [x] `memory.ts` `handleRemember` (:58) + `mcp.ts:1992` schema: accept/validate `trigger` and
      `pinned`; an unknown predicate shape is rejected with a message, never stored
- [x] Shared predicate evaluator (one dependency-light module): touched files/symbols/domains in,
      matching memory ids + fired predicate out; `withinHops` via the existing backward
      reachability (select_tests precedent, test-impact.ts:150), depth-capped like its caller
- [x] `orient.ts`: evaluate against relevant files/symbols/domains (touched-set already computed,
      :496-511 vicinity); inject matched + pinned memory content; emit
      `injectedMemories: [{ id, firedPredicate, freshness }]`; orphaned never injected as
      authoritative (memory.ts:382 rule), drifted flagged verify
- [x] `blast-radius.ts` / `working-set.ts`: same evaluator over their touched sets, same receipt
- [x] Pinned items participate in orient's budget per the sibling
      refine-orient-context-budgeting; until then, ride the existing bounded briefing with the
      existing omission disclosure — no new budgeting here
- [x] Pi parity: the skip is stated — the Pi `before_agent_start` block and the Claude Code prompt hook
      run orient in lean mode (navigation core only), which does not push memories; the Pi
      `remember` tool schema carries `trigger`/`pinned` (parity guard). Rendering pushed memories
      in the lean injection block is a follow-up.

## Verification
- [x] Glob/symbol/domain trigger each fires when the task touches a matching file/symbol/domain
      and stays silent otherwise; receipt names the memory and the fired predicate
- [x] `withinHops: 2` fires for a caller two hops upstream of the anchor; not at three
- [x] Pinned memory appears in orient briefings for unrelated tasks, with a receipt
- [x] Orphaned memory with a matching trigger is NOT injected as authoritative; drifted is
      injected flagged `verify`
- [x] Over-broad trigger: injection bounded, omitted count disclosed, never silent truncation
- [x] Substrate/default tools/list prefix byte-identical (orient input schema unchanged); full
      ceiling re-measured (88,000 B, mcp-presets.test.ts:581); full suite green

## Spec
- [x] `mcp-handlers` delta: MODIFY ProactiveIntentBriefing, ADD MemoryTriggerPredicates
