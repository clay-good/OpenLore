# Proposal

## Why

The question anyone actually asks about a user interface is "what makes this appear, or refuse to go
away" — and the graph cannot express it. Call edges answer "who calls this component", which is
almost never the question: the component is rendered by its parent, and whether it appears is decided
by a condition. On 2026-09-20 a spinner that would not stop produced an `orient` answer listing
`restartServer`, `DocxExportButton` and `withoutTrailingStop` — every one structurally reachable,
none of them the guard. The guard was a boolean in a conditional expression, written by one message
handler and read by one JSX conditional: both entirely static, both invisible to the index.

This is not an inference problem. `{isRunning && <Spinner/>}` states the condition in the syntax. The
product simply never collects it.

## What Changes

- The analyzer extracts a **render-guard index**: for each rendered element in a component, the
  conditions that gate its presence — `{cond && <X/>}`, `cond ? <X/> : <Y/>`, an early
  `if (…) return null`, and the same shapes in the frameworks' template syntax where they are
  statically visible.
- Each guard is reduced to the identifiers it reads, classified as prop, local state, store/context
  value, or derived, with the file and line of the condition.
- Each guard input is paired with its **writers**: the call sites that assign it — `setX(…)` from a
  state hook, a reducer clause that assigns the field, a store setter. Where a reducer clause is the
  writer, the writer is reached through the message-topology rule (change
  `add-message-topology-edges`), which is what connects a UI guard to the message that flips it.
- A new conclusion tool answers the question directly: given a component (or a component and an
  element within it), return the guard chain, each guard's inputs, the writers of each input, and the
  tests that reach those writers — not a graph to traverse.
- Honesty is explicit: a guard whose condition is an opaque call, or whose input is assigned through
  an unresolvable path, is disclosed as a boundary. A component in a framework with no collector
  returns an unsupported result, never an empty one.
- Scope: React/JSX (TypeScript and JavaScript) in this change, with the per-language extension
  discipline the event-channel rule already sets.

## Capabilities

### New Capabilities

- `render-guards`: the extraction, storage and querying of the conditions that gate rendered
  interface elements, and the writers of those conditions' inputs.

### Modified Capabilities

- `mcp-handlers`: a new conclusion tool answers the `what-gates` question kind, which the retrieval
  abstention vocabulary currently declares unserved (change `abstain-when-retrieval-is-uncovered`).

## Impact

- `src/core/analyzer/` — new guard collector over the existing tree-sitter parse; note that the
  current `ui-component-extractor.ts` is regex-based and cannot express conditions, so the guard
  collector runs on the AST, not on that extractor
- `.openlore/analysis/` — guard facts persisted alongside the existing UI inventory
- `src/core/services/mcp-handlers/` — the new tool, its capability-family classification and its
  conclusion-shape registration
- `src/core/analyzer/language-support.ts` and `docs/language-support.md` — new capability column
- Interaction: strongest when `add-message-topology-edges` has landed; without it, reducer-written
  guards report their writer as unresolved rather than wrong
