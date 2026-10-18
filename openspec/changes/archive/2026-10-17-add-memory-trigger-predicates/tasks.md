# Tasks — add-memory-trigger-predicates

## Implementation
- [x] `types/index.ts`: additive `trigger` (closed union: fileGlob | symbolPattern | specDomain |
      withinHops) and `pinned` on `AnchoredMemory`; old records unaffected
- [x] `memory.ts` `handleRemember` + the `remember` schema in `mcp.ts` and the Pi extension:
      accept/validate `trigger` and `pinned`; a malformed or unsupported trigger is rejected with a
      message, never stored; an in-place update that drops a trigger or pin says so
- [x] Shared evaluator `memory-triggers.ts`: touched files/symbols/domains in, pushed notes with
      receipts out; a linear `* ? **` glob matcher (no regex backtracking on repo-supplied
      patterns); `withinHops` via ONE depth-capped forward walk from the touched symbols over the
      message-free traversal index, shared by every note
- [x] `orient.ts`: evaluate against the touched set (the whole candidate pool under a
      `tokenBudget`); push matched + pinned notes as `injectedMemories`; orphaned matches go to
      `staleTriggeredMemories` (receipt + anchors, no content); drifted, superseded-decision and
      conflicting notes are flagged `verify`; malformed store entries are skipped
- [x] `blast-radius.ts`: same evaluator over the diff (paths re-framed to the analyzed root);
      pinned notes stay with orient; the human CLI briefing lists pushed notes
- [x] `working-set.ts`: carries each target's pushed notes inside the working-set token budget
- [x] Budget: `injectedMemories` is a trimmable `tokenBudget` section counted in the receipt; at
      most 10 notes are pushed, ranked withinHops (nearer first) > symbolPattern > fileGlob >
      specDomain > pinned, then newest; the rest are counted
- [x] Pi parity: the skip is stated — the Pi `before_agent_start` block and the Claude Code prompt
      hook run orient in lean mode (navigation core only), which does not push memories; the Pi
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
      ceiling re-measured (97,800 → 98,500 B; memory preset re-baselined 1,216 → 1,357 tokens);
      full suite green

## Spec
- [x] `mcp-handlers` delta: MODIFY ProactiveIntentBriefing, ADD MemoryTriggerPredicates
