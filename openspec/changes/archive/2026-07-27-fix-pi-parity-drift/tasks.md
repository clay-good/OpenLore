# Tasks — fix-pi-parity-drift

## Implementation
- [x] Add `decision-current` to Pi's `verify_claim` kind enum (extension.ts:606); extend the
      guideline with the decision-citation trigger (subject = 8-char decision id), matching the
      MCP contract (claim-verification.ts:60-63)
- [x] Add NAV_TOOLS entries for the six drifted conclusion tools — `find_clones`,
      `analyze_error_propagation`, `analyze_env_impact`, `certify_public_surface`,
      `get_style_fingerprint`, `briefing_since` — trigger-first descriptions/guidelines in the
      existing house style; params a subset of each daemon inputSchema
- [x] Add a named, commented Pi exclusion list beside NAV_TOOLS (one stated reason per excluded
      conclusion tool: opt-in federation/coordination preset surface, inventories covered by
      injection, etc.)
- [x] Two-direction parity guard in extension.test.ts: every dispatchable conclusion tool (per
      TOOL_OUTPUT_CLASS) is in NAV_TOOLS or on the exclusion list — fails-until-you-decide, the
      tool-contract.test.ts precedent; keep the existing NAV_TOOLS ⊆ dispatchable direction
      (extension.test.ts:297-301)
- [x] Cleanup: replace the literal NUL byte in interference-map.ts:391
      (`${repo}\x00${w.filePath}` template literal, ~offset 19335) with the `'\x00'` escape
      sequence so grep/rg stop treating the file as binary; no behavior change

## Verification
- [x] Test: parity guard fails when a new conclusion tool is added to TOOL_OUTPUT_CLASS without a
      NAV_TOOLS entry or exclusion-list entry (simulated in-test), and passes on the reconciled
      surface
- [x] Test: Pi `verify_claim` accepts kind `decision-current` and round-trips to the daemon
      handler (superseded decision → refuted with live superseder)
- [x] Existing param-subset test (extension.test.ts:303-314) passes for all six new NAV_TOOLS
      entries against their daemon inputSchemas
- [x] `command grep -c x src/core/services/mcp-handlers/interference-map.ts` runs in text mode
      (no "binary file matches") and the interference-map suite is green (NUL escape is
      byte-equivalent at runtime)
- [x] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-quality` delta: ADD PiSurfaceParityIsGuarded
