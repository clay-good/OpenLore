# Tasks

## 1. Rule plumbing

- [x] 1.1 Add `'message-topology'` to the Pass-1 event-fact rule union in
  `src/core/analyzer/call-graph-types.ts`; verify the project type-checks
- [x] 1.2 Collect message topology in its own block beside the per-language chain (design 5), so
  TypeScript/JavaScript have both rules; verify the other edges are unchanged (additive-only test)

## 2. Collection

- [x] 2.1 Collect consumer clauses: `switch (expr.field)` cases and `if (expr.field === "lit")`
  consequents, keyed `<field>=<tag>`, resolving the handler to the clause body's single callee
  when there is one and the enclosing function otherwise; verify with unit tests over both shapes
- [x] 2.2 Collect construction sites: object literals carrying a static discriminant field, keyed
  identically; verify a computed, spread or templated tag yields no site
- [ ] 2.3 (Deferred — the transport gate in design 4a removed the false pairings this was for)
  Read the discriminant field name from a declared discriminated-union type when present in
  the index, falling back to the consumer-tested field; verify both paths with a fixture that has a
  shared protocol module and one that does not
- [x] 2.4 Add a cheap content prefilter for each collector and verify a file with neither shape does
  no AST work in a benchmark or instrumented test

## 3. Pairing and boundaries

- [x] 3.1 Emit edges with the new rule label, sharing the event-channel fan-out cap and key-kind
  namespacing (design 2); verify the cap and namespacing apply
- [x] 3.2 Verify two protocols keyed on different fields sharing a tag literal produce no cross edge
- [x] 3.3 Record an unpaired static send as a dynamic-boundary site with the new
  `unindexed-message-consumer` reason; verify the reason is in the closed vocabulary and appears in
  the sidecar for a fixture whose consumer is absent
- [x] 3.4 Verify a graph built with the rule disabled and one with it enabled differ only by added
  message-topology edges

## 4. Reporting

- [x] 4.1 Render the message hop distinctly wherever paths and callers are reported, and verify a
  path crossing a message edge labels that hop — `find_path` marks the step a synthesized edge
  reaches with `via: "<rule>"`; caller and subgraph views already carry `synthesizedBy`
- [x] 4.2 Ensure a traversal restricted to directly-resolved edges excludes message edges, and verify
  its result equals the rule-disabled graph
- [x] 4.3 Declare message-topology support per language in the language-support registry and
  `docs/language-support.md`; verify `get_language_support` reports it supported for
  TypeScript/JavaScript only

## 5. Verification on real protocols

- [x] 5.1 Add an end-to-end fixture reproducing the 2026-09-20 case — client `send({type:"restart"})`
  → server `case "restart"` → `broadcast({type:"restarted"})` → reducer `case "restarted"` — and
  verify a path exists from the client action to the reducer clause
- [x] 5.2 Measure edge-count and analysis-time delta on this repository and on a client/server app;
  verify the growth is within the fan-out cap's bound and record the numbers in the change —
  this repository (1,379 analyzed files): 10 message edges (+0.03%, all real worker-protocol and
  telemetry hops after review round 1), 54 `message-send` boundary sites; earlier cut: 7 edges, 40 sites, no
  other edge changed (no `tested_by` edge derives from a message hop after round 2); analysis
  time 24–26 s with and without the rule over three runs each (no measurable change)
- [x] 5.3 Run `openspec validate --strict` for this change and the reaching tests from
  `openlore select-tests`, and verify both are green
