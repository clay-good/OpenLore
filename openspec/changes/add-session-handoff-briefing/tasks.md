# Tasks — add-session-handoff-briefing

## Implementation
- [ ] Composer: working-tree diff → touched symbols + callers (footprint machinery); fresh
      in-scope memories/decisions (orphaned withheld, drifted flagged); drifted specs; open
      change dirs referencing touched paths with unchecked task lines quoted; reaching tests;
      unfinished receipts (uncommitted list, staged/unstaged split, stale certificate lease)
- [ ] Determinism: same repo state ⇒ byte-identical briefing (no timestamps, no ordering
      nondeterminism)
- [ ] Re-fetch identifiers on every truncated/summarized element (tool + args)
- [ ] Token budget with peripheral-first truncation + per-section omission receipts; clean-tree
      response is an explicit "nothing in flight" + lease state
- [ ] `get_handoff_briefing` handler + `openlore handoff [--json]`; staleness disclosure
      carried when the index trails the tree
- [ ] Wiring checklist: conclusion classification (family `change`), `full` preset, Pi
      surfaced-or-excluded, lease weights, docs table row, adjacent cross-references

## Verification
- [ ] Fixture: mid-change repo (edited hub + memory + drifted spec + open change dir) →
      briefing contains all five sections with correct receipts
- [ ] Byte-identical on repeated invocation at fixed state
- [ ] Clean tree → explicit nothing-in-flight, never `{}`
- [ ] Budget truncation emits omission receipts and keeps re-fetch identifiers
- [ ] Full suite green

## Spec
- [ ] `cli` delta: ADD HandoffBriefingIsDeterministicAndReplayable
- [ ] `mcp-handlers` delta: ADD HandoffBriefingComposesExistingConclusions
