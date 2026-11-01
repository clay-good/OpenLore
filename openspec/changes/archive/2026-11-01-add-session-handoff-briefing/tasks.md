# Tasks — add-session-handoff-briefing

## Implementation
- [x] Composer (`src/core/services/mcp-handlers/handoff.ts`): working-tree diff → touched symbols +
      callers (`blast_radius` against HEAD); in-scope memories/decisions (orphaned withheld, drifted
      flagged); drifted specs; open change dirs naming touched paths with unchecked task lines quoted;
      reaching tests; unfinished receipts (uncommitted staged/unstaged/untracked, index lease)
- [x] Determinism: same repo state ⇒ byte-identical briefing (no timestamps; every list sorted)
- [x] Re-fetch identifiers (`expand`) on every element and truncation receipt
- [x] Token budget, least central sections first, with omission receipts; clean tree ⇒ explicit
      "nothing in flight" + lease
- [x] `get_handoff_briefing` handler + `openlore handoff [--json] [--budget]`; staleness disclosed
- [x] Wiring: conclusion, family `change`, `full` preset, Pi excluded with a reason, lease weight,
      live-data driver, docs rows, tool-count docs, payload budget; description names `blast_radius`,
      `briefing_since`, `orient`
- [x] After-compact hook moment (`SessionStart` matcher `compact`, opt-out `hooks.after-compact`);
      session ledger's committed edits and open facts as inputs. Declared footprint: when the peer
      footprint board ships

## Verification
- [x] Fixture: touched hub, open change with unchecked tasks, tests, drifted spec, uncommitted split
      (`handoff.test.ts`)
- [x] Byte-identical on repeated invocation at fixed state
- [x] Clean tree → explicit nothing-in-flight, never `{}`
- [x] Budget truncation emits omission receipts naming the call
- [x] Committed-then-compacted edits still appear via the ledger; after-compact hook prints it
- [x] Full suite green

## Spec
- [x] `cli` delta: ADD HandoffBriefingIsDeterministicAndReplayable
- [x] `mcp-handlers` delta: ADD HandoffBriefingComposesExistingConclusions
- [x] `mcp-handlers` delta: ADD HandoffBriefingSurvivesCompaction
