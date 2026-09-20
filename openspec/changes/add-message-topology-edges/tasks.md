# Tasks

## 1. Rule plumbing

- [ ] 1.1 Add `'message-topology'` to the `synthesizedBy` union in
  `src/core/analyzer/call-graph-types.ts` and to the `addEvents` rule parameter in
  `src/core/analyzer/call-graph.ts`; verify the project type-checks with no exhaustiveness gaps
- [ ] 1.2 Make the per-language collector dispatch additive so TypeScript/JavaScript can register
  both `event-channel` and `message-topology`; verify with a test that the edges synthesized for
  Python, Ruby, PHP, Swift, Java, C#, Kotlin and Elixir are unchanged byte for byte

## 2. Collection

- [ ] 2.1 Collect consumer clauses: `switch (expr.field)` cases and `if (expr.field === "lit")`
  consequents, keyed `<field>:<literal>`, resolving the handler to the clause body's single callee
  when there is one and the enclosing function otherwise; verify with unit tests over both shapes
- [ ] 2.2 Collect construction sites: object literals carrying a static discriminant field, keyed
  identically; verify a computed, spread or templated tag yields no site
- [ ] 2.3 Read the discriminant field name from a declared discriminated-union type when present in
  the index, falling back to the consumer-tested field; verify both paths with a fixture that has a
  shared protocol module and one that does not
- [ ] 2.4 Add a cheap content prefilter for each collector and verify a file with neither shape does
  no AST work in a benchmark or instrumented test

## 3. Pairing and boundaries

- [ ] 3.1 Emit edges through the existing `pairAndEmitEventEdges` with the new rule label; verify
  the fan-out cap and key-kind namespacing apply unchanged
- [ ] 3.2 Verify two protocols keyed on different fields sharing a tag literal produce no cross edge
- [ ] 3.3 Record an unpaired static send as a dynamic-boundary site with the new
  `unindexed-message-consumer` reason; verify the reason is in the closed vocabulary and appears in
  the sidecar for a fixture whose consumer is absent
- [ ] 3.4 Verify a graph built with the rule disabled and one with it enabled differ only by added
  message-topology edges

## 4. Reporting

- [ ] 4.1 Render the message hop distinctly wherever paths and callers are reported, and verify a
  path crossing a message edge labels that hop
- [ ] 4.2 Ensure a traversal restricted to directly-resolved edges excludes message edges, and verify
  its result equals the rule-disabled graph
- [ ] 4.3 Declare message-topology support per language in the language-support registry and
  `docs/language-support.md`; verify `get_language_support` reports it supported for
  TypeScript/JavaScript only

## 5. Verification on real protocols

- [ ] 5.1 Add an end-to-end fixture reproducing the 2026-09-20 case — client `send({type:"restart"})`
  → server `case "restart"` → `broadcast({type:"restarted"})` → reducer `case "restarted"` — and
  verify a path exists from the client action to the reducer clause
- [ ] 5.2 Measure edge-count and analysis-time delta on this repository and on a client/server app;
  verify the growth is within the fan-out cap's bound and record the numbers in the change
- [ ] 5.3 Run `openspec validate --strict` for this change and the reaching tests from
  `openlore select-tests`, and verify both are green
