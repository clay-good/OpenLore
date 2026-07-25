# Tasks — add-span-precise-conclusions

## Implementation
- [ ] Surface stored lines: `startLine` on `search_code` symbol hits (`semantic.ts:255-280`)
      and `orient` functions (`orient.ts:224-236`); call-site `line` on `analyze_impact`
      entries (`graph.ts:307-310`) and `trace_execution_path` steps (`graph.ts:1294-1306`) —
      read from the stored edge/node fields only, absent when not captured
- [ ] `get_function_body` `focus` param (`analysis.ts:457`): resolve focus as variable
      (def-use lines via `getCfg` + the overlay's `DefUseEdge`s) or callee (call-site lines for
      that callee within the span); render slice lines + minimal excerpt with per-line
      `exact | may` tags
- [ ] Boundary handling: `cfgSupportsLanguage` false or focus not found → whole span /
      not-found with machine-readable `sliceUnavailable` reason; stale-index disclosure via the
      dual-baseline freshness verdict (`symbol-span.ts:76-87` pattern)
- [ ] Pi parity: apply the same fields to the Pi-surfaced equivalents or add to
      `PI_EXCLUDED_CONCLUSION_TOOLS` with rationale (two-direction parity guard)

## Verification
- [ ] Line-fidelity tests: surfaced lines equal the stored `CallEdge.line` / node `startLine`
      for fixtures in TS, Python, Go; absent when extraction did not capture a line
- [ ] Slice test: focused read of a large fixture function returns exactly the def/use lines
      with correct `exact | may` tags; unfocused call byte-identical to today
- [ ] Boundary tests: unsupported-language focus → whole span + `sliceUnavailable`; unknown
      focus name → not-found with candidates, never a guessed slice
- [ ] Payload-budget check: tools/list and per-response budgets unaffected beyond the additive
      integer fields (existing tool-guard caps hold)
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD ConclusionsCarrySpanEvidence
- [ ] `mcp-handlers` delta: ADD SliceFocusDisclosesPrecisionAndScope
