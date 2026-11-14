# Tasks — add-assumption-anchored-resolutions

## 1. Record

- [ ] 1.1 Add `assumption` to `MemoryType` and `MEMORY_TYPES` in `src/types/index.ts`, and to the
      `remember` `type` enum in `src/cli/commands/mcp.ts` and `src/pi/extension.ts`. Test:
      `src/core/services/mcp-handlers/memory.test.ts`. Done when `remember` stores the type and an
      unknown type still becomes `note`.
- [ ] 1.2 Validate the content in `src/core/services/mcp-handlers/memory.ts`: a site inside the
      anchor symbol and `dispatch-target: <symbol>` or `no-throw`. Test: `memory.test.ts`. Done when
      a malformed assumption is refused with a shape hint and nothing is stored.

## 2. Read at answer time

- [ ] 2.1 New `src/core/services/mcp-handlers/assumptions.ts`: load assumptions that `recall`
      would serve as authoritative, keyed by anchor symbol and site. Test: new
      `assumptions.test.ts`. Done when a drifted, orphaned or superseded one is not returned.
- [ ] 2.2 Use `dispatch-target` in `blast-radius.ts`, `graph.ts` (`analyze_impact`),
      `reachability.ts` (`find_dead_code`) and `claim-verification.ts` (`dead`, `impacts`). Tests:
      `blast-radius.test.ts`, `reachability.test.ts`, `claim-verification.test.ts`. Done when the
      answer includes the stated edge and `assumptions: [id]`, and is identical to today when no
      fresh assumption exists.
- [ ] 2.3 Use `no-throw` in `error-propagation.ts`. Test: `error-propagation.test.ts`. Done when
      only that callee leaves `boundaries` and the result carries the id.
- [ ] 2.4 Classify the `assumptions` field in `confidence-boundary.ts`. Test:
      `completeness-invariant.test.ts`. Done when the test passes.

## 3. Guards and docs

- [ ] 3.1 Overlay only. Test: `assumptions.test.ts`. Done when the files in `.openlore/analysis`
      are byte-identical before and after recording an assumption.
- [ ] 3.2 MCP↔Pi parity and payload budget. Tests: `src/pi/extension.test.ts`,
      `src/cli/commands/mcp-presets.test.ts`. Done when both pass with the new enum value.
- [ ] 3.3 Document the type and the `assumptions` field in `docs/mcp-tools.md`. Done when the doc
      shows one `remember` example and states the two resolutions.
