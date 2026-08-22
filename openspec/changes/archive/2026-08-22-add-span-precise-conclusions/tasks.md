# Tasks — add-span-precise-conclusions

## Implementation
- [x] Surface `startLine` on `search_code` symbol hits and `orient` functions by canonical
      symbol id; omit it when the indexed node has no valid stored start line
- [x] Surface bounded, deterministically ordered call-site receipts from stored edges only:
      canonically selected `analyze_impact` affected entries get `callSites` for all qualifying
      shortest-frontier edges under a global cap with an omission receipt, and each non-terminal
      `trace_execution_path` step gets `callsNext` for all parallel
      edges to the next symbol; deduplicate identical receipts and disclose returned, exact total
      when complete or bounded `totalAtLeast` when truncated, and the truncation verdict
- [x] Add optional `get_function_body` focused mode to MCP dispatch and schema: focused calls
      provide `focus` and `focusKind: variable | callee`; calls omitting both fields preserve the
      legacy response byte-for-byte
- [x] Implement variable focus from one cached analysis generation via `getCfg` and persisted
      `DefUseEdge`s: return bounded direct same-spelling definition/use lines, their source text,
      roles, and stored `dataFlowPrecision`; disclose the non-scope-qualified spelling boundary
- [x] Implement callee focus from stored outgoing call edges: return bounded parallel call-site
      lines, their source text, and stored `callConfidence`; do not invent `exact | may` for call
      evidence
- [x] Successful focused reads omit `body`; focused response collections are deterministic and
      carry explicit completeness/truncation receipts
- [x] Boundary handling: unsupported variable language or missing CFG overlay → legacy whole
      body plus machine-readable `sliceUnavailable`; unknown focus → typed not-found with
      bounded candidates; ambiguous symbol, stale index/generation, unreadable source, or a line
      outside the selected symbol span → fail-closed refusal with no focused body
- [x] Apply content-hash-first, artifact-mtime-fallback freshness from the same cached generation
      used for symbol resolution; never combine raw-artifact offsets with a watcher-primed graph
- [x] Pi parity: advertise the same optional `focus` + `focusKind` contract and add a reverse
      parity assertion so MCP cannot grow focused parameters without Pi making an explicit choice
- [x] Update `docs/mcp-tools.md` with the focused input and success/degradation response contract

## Verification
- [x] Line-fidelity tests: surfaced lines equal stored `CallEdge.line` / node `startLine` for TS,
      Python, and Go; uncaptured lines are absent; same-name symbols prove canonical-id joins
- [x] Parallel-edge tests: trace preserves every distinct A→B call site; impact preserves every
      qualifying shortest-frontier edge (including multiple prior-depth parents); identical
      receipts deduplicate deterministically; absent lines are never guessed
- [x] Variable-focus test: a large function returns only bounded direct same-spelling def/use
      evidence with unchanged stored `dataFlowPrecision`, roles, source text, and no `body`
- [x] Callee-focus test: parallel call sites retain stored `callConfidence`, carry no invented
      data-flow precision, and return no `body`
- [x] Legacy compatibility test: a call without `focus`/`focusKind` is byte-for-byte identical to
      the pre-change result in indexed and line-scan fallback paths
- [x] Boundary tests: unsupported/missing variable overlay, unknown focus, unused tracked value,
      ambiguous symbol, stale/mixed generation, unreadable source, and out-of-span stored line all
      produce the specified machine-readable degradation/refusal without a guessed slice
- [x] Determinism/budget tests: repeated receipts are byte-identical, caps disclose completeness,
      a focused large body is materially smaller, full/default tools-list ceilings stay green,
      and lean preset counts/bytes remain unchanged
- [x] Redaction and transport tests: focused line text is recursively redacted; MCP JSON-RPC,
      serve HTTP root binding, and Pi return the same focused contract
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD ConclusionsCarrySpanEvidence
- [x] `mcp-handlers` delta: ADD SliceFocusDisclosesPrecisionAndScope
