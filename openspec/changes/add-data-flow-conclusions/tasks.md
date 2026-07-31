# Tasks — add-data-flow-conclusions

## Implementation
- [ ] Per-function flow summaries (param→return, param→callee-arg, param→container-write) from
      the existing def-use overlay; memoized by Pass-1 content-hash key; TS/JS/Python
- [ ] Interprocedural composer: bounded BFS over resolved call edges binding call-site args ↔
      params and returns ↔ results; boundary collection (external/unresolved callee, dynamic
      site, unsupported language, depth cap)
- [ ] `trace_data_flow` handler + `openlore data-flow` CLI: `flow-found` with ordered hop
      receipt (def-use step file:line | call binding), or `no-flow-within-analyzed-scope` with
      enumerated boundaries; sound-direction sentence verbatim in both
- [ ] Container-level hops labeled; alias ambiguity emitted as a boundary class, never resolved
- [ ] Wiring checklist: tool-contract classification (conclusion, family navigate), `full`
      preset membership, Pi surfaced-or-excluded, epistemic-lease weights, docs table row

## Verification
- [ ] Fixtures: direct chain, cross-function arg→param→return chain, container write,
      no-flow-with-external-frontier, unsupported-language region, depth-cap disclosure
- [ ] Negative verdict always enumerates a non-empty boundary set when any frontier exists;
      never the word "safe"
- [ ] Watcher edit to one function refreshes only that function's summary (hash-memo test)
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD FlowSummariesAreCompositionalAndHashKeyed
- [ ] `mcp-handlers` delta: ADD DataFlowVerdictsAreSoundlyBounded
