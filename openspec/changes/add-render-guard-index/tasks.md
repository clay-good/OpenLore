# Tasks

## 1. Guard collection

- [ ] 1.1 Add an AST guard collector for JSX recovering logical-and wrappers, conditional-expression
  branches and early returns; verify each shape with a unit test naming the gated element, file and
  line
- [ ] 1.2 Chain enclosing guards upward per element and verify a nested element reports both its own
  and its ancestors' conditions in evaluation order
- [ ] 1.3 Record an unreducible condition as an undetermined input and verify it is not dropped
- [ ] 1.4 Attribute a guard inside a callback to its enclosing scope and verify the chain still reads
  upward correctly

## 2. Inputs and writers

- [ ] 2.1 Classify guard inputs from their binding sites (prop, state, store/context, derived) and
  verify each classification with a fixture
- [ ] 2.2 Resolve state-setter writers and verify the setter call site is recorded with file, line
  and enclosing function
- [ ] 2.3 Resolve message-selected clause writers through the message-topology rule and verify the
  clause is recorded; verify the writer is reported unresolved when that rule is unavailable
- [ ] 2.4 Report an unresolvable write path as unresolved with a reason and verify an empty writer
  list is never presented as complete

## 3. Persistence

- [ ] 3.1 Persist guard facts in a sidecar beside the UI inventory; verify the edge store and every
  edge-count-dependent answer are byte-identical before and after
- [ ] 3.2 Apply per-component and per-element caps with disclosure; verify a synthetic oversized
  component discloses truncation instead of dropping silently
- [ ] 3.3 Handle an index built before this change by reporting guard facts as absent and naming the
  rebuild command; verify with a fixture index lacking the sidecar

## 4. The tool

- [ ] 4.1 Add the visibility tool returning the guard chain, inputs, writers and reaching tests;
  verify the response is a conclusion, not a traversal, per the dispatch-time shape check
- [ ] 4.2 Declare its capability family and sibling cross-references in `tool-contract.ts`; verify
  the contract test passes
- [ ] 4.3 Return an explicit not-found with candidates for an unknown component and verify no empty
  guard list is returned
- [ ] 4.4 Point the `what-gates` question kind at this tool where the framework is supported; verify
  the abstention response names it instead of reporting the kind unserved

## 5. Language support and verification

- [ ] 5.1 Declare render-guard support per framework in the language-support registry and
  `docs/language-support.md`; verify an unsupported framework returns an unsupported result
- [ ] 5.2 End-to-end: reproduce the 2026-09-20 spinner case — a guard written by a message-selected
  clause — and verify the tool names the condition, its input and the writing clause
- [ ] 5.3 Measure analysis-time and sidecar-size delta on a real interface codebase and record the
  numbers in the change
- [ ] 5.4 Run `openspec validate --strict` and the reaching tests from `openlore select-tests`;
  verify both are green
