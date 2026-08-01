# Tasks — enforce-preset-membership-at-dispatch

## Implementation

- [x] `mcp.ts` CallTool handler: after `resolveCanonicalToolName`, check membership in the
      active preset's tool set BEFORE arg validation, watcher bootstrap side effects, and
      dispatch; return the actionable tool error (tool, active preset, containing preset(s),
      `openlore install --preset <name>`)
- [x] Compute "containing presets" from `TOOL_PRESETS` + `FULL_PRESET` (no new table to drift)
- [x] Enforce the same check on the serve-daemon delegation path (forwarded calls) and in the
      daemon itself (defense in depth — the daemon knows its own preset)
- [x] Guard test beside `mcp-presets.test.ts`: for every preset, one out-of-surface tool →
      membership error; wire-protocol and daemon tests assert write tools (`record_decision`,
      `remember`, `approve_decision`) leave no persisted side effect (ledger, pending.json,
      notes.json unchanged)
- [x] Confirm `--watch-auto` bootstrap does not fire for a rejected call (the membership check
      precedes it)
- [x] Docs: initialize `instructions` pointer already says "more tools behind named presets —
      re-wire"; verify no published copy promises hidden callability

## Verification

- [x] Re-run the e2e probe: under `substrate`, `find_dead_code` / `record_decision` /
      `remember` all rejected with the actionable error and zero side effects; `orient` and the
      other 12 members unaffected; `--preset full` still dispatches everything

## Adversarial follow-up

- [x] Refuse daemon reuse when the requested canonical preset or token differs
- [x] Require one authenticated, root-bound health response with
      `presetDispatchEnforced: true` before trusting daemon metadata
- [x] Keep out-of-preset and unauthorized calls from resetting the daemon idle timer
- [x] Stop a verified daemon through its authenticated shutdown endpoint, never descriptor PID data
- [x] Do not replay non-idempotent writes after an ambiguous daemon disconnect
- [x] Claim the daemon descriptor before acknowledging shutdown so replacements retain discovery
- [x] Preserve a healthy narrow daemon after an expected `403` local fallback
- [x] Detect a narrow pre-existing Pi daemon and return actionable stop/restart remediation
- [x] Seed initialized decision/memory stores and prove byte-identical rejection behavior
- [x] Exercise the real MCP-to-full-daemon delegation boundary in hosted CI
