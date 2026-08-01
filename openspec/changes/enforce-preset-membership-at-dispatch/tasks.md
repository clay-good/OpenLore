# Tasks — enforce-preset-membership-at-dispatch

## Implementation

- [ ] `mcp.ts` CallTool handler: after `resolveCanonicalToolName`, check membership in the
      active preset's tool set BEFORE arg validation, watcher bootstrap side effects, and
      dispatch; return the actionable tool error (tool, active preset, containing preset(s),
      `openlore install --preset <name>`)
- [ ] Compute "containing presets" from `TOOL_PRESETS` + `FULL_PRESET` at startup (no new
      table to drift)
- [ ] Enforce the same check on the serve-daemon delegation path (forwarded calls) and in the
      daemon itself (defense in depth — the daemon knows its own preset)
- [ ] Guard test beside `mcp-presets.test.ts`: for every preset, one out-of-surface call →
      membership error; for write tools (`record_decision`, `remember`, `approve_decision`),
      assert no persisted side effect (ledger, pending.json, notes.json unchanged)
- [ ] Confirm `--watch-auto` bootstrap does not fire for a rejected call (the membership check
      precedes it)
- [ ] Docs: initialize `instructions` pointer already says "more tools behind named presets —
      re-wire"; verify no published copy promises hidden callability

## Verification

- [ ] Re-run the e2e probe: under `substrate`, `find_dead_code` / `record_decision` /
      `remember` all rejected with the actionable error and zero side effects; `orient` and the
      other 12 members unaffected; `--preset full` still dispatches everything
