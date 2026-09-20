# Proposal

## Why

The call graph splits at every process boundary an application actually runs on. In a client/server
app, `client.send({ type: "restart" })` → the server's `switch (msg.type) { case "restart": … }` →
`broadcast({ type: "restarted" })` → the client reducer's `case "restarted":` is one causal chain
with **zero edges** in the graph: each hop crosses a tagged message, not a call. On 2026-09-20 an
`orient` about a spinner that would not stop returned `restartServer`, `DocxExportButton` and
`withoutTrailingStop`, plus an insertion point advising a new step inside `restartServer` — all
structurally reachable, none on the path, because the path is a message flow. OpenLore already
recovers event channels (`emit(k)` ↔ `on(k, fn)`) through its dynamic-dispatch synthesis pass; the
far more common discriminated-union protocol — one literal discriminant, a switch over it, often a
declared union type sitting in a shared module — is not recovered, though it is just as statically
explicit.

## What Changes

- The dynamic-dispatch synthesis pass gains a **message-topology rule**: an additive edge from the
  function that constructs a tagged message value (`{ type: "x", … }`, `{ kind: "x", … }`) to each
  handler clause that tests the same discriminant field against the same literal (`switch`
  case, `if (m.type === "x")`), when field name and literal are both static.
- The discriminant field is taken from a declared discriminated-union type when one is in the index
  (the shared protocol module), and otherwise from the member expression the consumer compares.
  Neither path guesses: a message whose tag is computed, spread, or renamed produces no edge.
- Synthesized message edges carry their own provenance label, distinct from directly-resolved calls
  and from event-channel edges, so every consumer can tell a message hop from a call and can
  exclude them.
- A send site whose message is statically tagged but whose consumers are not in the index (an
  external service, an unindexed sibling repo) is recorded as a **transport boundary**, disclosed
  the way dynamic-boundary sites already are — never as an absent or an invented edge.
- The language-support matrix gains the capability, so a quiet result in an unsupported language
  reads as "not recovered here", not "no message flow".
- Scope in this change: TypeScript/JavaScript (object-literal tag + `switch`/`===` consumer), which
  covers WebSocket/`postMessage`/IPC envelopes and Redux-style actions. Further languages follow the
  one-at-a-time discipline the event-channel rule already sets.

## Capabilities

### New Capabilities

(none — this extends the existing synthesis pass)

### Modified Capabilities

- `analyzer`: `SynthesizedDynamicDispatchEdges` gains the message-topology rule as an independent
  per-pattern rule under its existing discipline (deterministic, additive-only, no LLM); the
  language-support registry gains the matching capability flag so an unsupported language reports
  the gap instead of an empty result.

## Impact

- `src/core/analyzer/call-graph.ts` — synthesis pass registration for the new rule
- `src/core/analyzer/` — new per-pattern rule module: tag collection at construction sites,
  discriminant resolution from declared unions, consumer-clause collection, pairing
- `src/core/analyzer/dynamic-boundary` sidecar — transport-boundary sites
- `src/core/services/mcp-handlers/` — no new tool; existing traversals gain the edges and must
  render the new provenance label
- `docs/language-support.md` and the language-support registry — new capability column
- Graph size: bounded by the same fan-out cap the event-channel rule uses
