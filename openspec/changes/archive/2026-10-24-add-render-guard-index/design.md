# Design

## Context

See `proposal.md` — Why. Three facts about the existing code shape this design:

- `src/core/analyzer/ui-component-extractor.ts` finds components with regular expressions
  (`REACT_FUNCTION_COMPONENT`, `VUE_OPTIONS_PROPS`, a bounded props body) and deliberately bounds
  its patterns against pathological files. It can name components; it cannot express a condition.
  The guard collector therefore runs on the tree-sitter AST the analyzer already parses, and reuses
  the UI inventory only to know which functions are components.
- The call graph already has a synthesis pass with independent per-pattern rules, and
  `add-message-topology-edges` adds the rule that connects a message tag to the clause that handles
  it. A reducer-written guard input becomes reachable through that rule.
- Tool authoring is governed: a new tool declares a capability family in `tool-contract.ts`, is
  classified `conclusion` or `explicit-topology`, and must cross-reference its adjacent siblings or
  the contract test fails.

## Goals / Non-Goals

**Goals:**

- Answer "what makes this appear" from syntax that already states it, with the same honesty
  discipline as the rest of the substrate: disclosed boundaries, no guessed writers.
- Keep the guard facts small enough to persist beside the UI inventory and to serve without a
  traversal.

**Non-Goals:**

- No evaluation, no truth values, no reachability of a particular UI state. The tool says what gates
  an element and who writes those inputs; it does not say whether the element is visible now.
- No CSS, no layout, no runtime visibility (`display:none`, z-index, portals).
- No framework beyond React/JSX in this change.
- No new inference: a condition that is not syntactically reducible is a disclosed boundary.

## Decisions

**1. Guards are collected per rendered element, chained upward, not flattened.**
An element's effective condition is the conjunction of its own guard and every enclosing guard up to
the component's early returns. Storing the chain (rather than a flattened boolean) keeps each link's
file and line, which is what makes the answer actionable — the caller needs the line to edit, not a
formula.

**2. Inputs are classified structurally, from the declaration that binds them.**
A state hook's tuple binds a value and a setter; a parameter of the component binds a prop; a
context/store read binds an external value. Everything else reachable from those is `derived`. This
classification is a lookup on the binding site, not an analysis — it stays sound and cheap.

**3. Writers are found by the same rules the call graph already uses.**
A setter is a call to the identifier bound as the setter of that state. A reducer clause is the
clause that assigns the field — reached through the message-topology rule when the clause is selected
by a tag. A store mutation is a call to a known mutation API. Anything else is `unresolved`, with a
reason. Nothing here needs a new resolver.
*Alternative considered:* def-use analysis over the whole module to find every assignment. Rejected
for this change — the CFG/def-use overlay exists but scoping it to guard inputs across module and
process boundaries is a larger piece of work than the failure requires; the unresolved disclosure
keeps the answer sound in the meantime.

**4. The facts persist beside the UI inventory, not in the call graph.**
A guard is not an edge: its endpoints are an element and an identifier, and its useful payload is a
line. Putting it in the edge store would distort every traversal that counts edges. A sidecar keeps
`find_path`, blast radius and fan-in arithmetic untouched.

**5. The tool is a conclusion tool in the `navigate` family, cross-referencing its siblings.**
Its nearest siblings are `analyze_impact` (who calls this) and `trace_execution_path` (how does
control get here); the contract test requires it to name them, and the abstention vocabulary's
`what-gates` kind points at it once it ships.

**6. Element identity is `component + element name + line`.**
Two `<Spinner/>` renders in one component are distinct answers, and the line is the disambiguator the
caller already has in front of them.

## Risks / Trade-offs

- **JSX is large and varied** (fragments, maps, render props, HOCs) → the collector recovers the
  three shapes named in the spec and discloses anything else as undetermined rather than partially
  guessing; coverage grows shape by shape with a test each.
- **A guard inside a `.map()` callback belongs to a list item, not the component** → recorded with
  its enclosing callback as the element's scope; the chain still reads correctly upward.
- **Sidecar growth on large UIs** → bounded per component (guards per element, elements per
  component) with the same cap-and-disclose pattern used elsewhere.
- **Dependence on message-topology for reducer writers** → stated in the proposal: without that
  change the writer is reported unresolved, which is honest and still better than today's silence.
- **Regex-based component discovery misses a component the AST would see** → the guard collector
  works from the AST and can attribute a guard to an enclosing function the UI inventory never
  listed; that case is reported with the function name rather than being dropped.

## Migration Plan

Additive: a new sidecar artifact, a new tool, one new capability column. Absent the sidecar (an index
built before this change), the tool reports that guard facts are not in the index and names the
command that rebuilds it — the same pattern other opt-in artifacts use. No existing answer changes.
