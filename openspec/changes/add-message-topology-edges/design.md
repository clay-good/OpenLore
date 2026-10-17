# Design

## Context

See `proposal.md` — Why. The pass this change extends already exists and already has the shape the
new rule needs:

- `src/core/analyzer/call-graph.ts` collects per-language `EventSites { registrations, dispatches }`
  and pairs them in `pairAndEmitEventEdges(sites, allNodes, rule)`. Three rules ship today —
  `'event-channel'` (key-based: JS/TS, Python, Ruby, PHP, Swift), `'type-event'` (Java, C#, Kotlin)
  and `'actor-message'` (Elixir) — enumerated in the `synthesizedBy` union at
  `src/core/analyzer/call-graph-types.ts:88`.
- Pairing is already language-agnostic, already namespaces keys by kind so a key of one kind never
  pairs with a same-text key of another, and already drops a key whose handler set exceeds
  `EVENT_CHANNEL_FANOUT_CAP` (8) rather than exploding fan-out.
- `dynamic-boundary.ts` already persists "a dispatch site the call graph cannot follow" with a
  refusal reason from a closed vocabulary.

So the work is a fourth rule plus one collector, not new machinery. What the existing rules cannot
express is the shape that dominates client/server apps: the handler is not a registered callback but
a **clause** — `case "x":` in a `switch (msg.type)`, or the consequent of `if (msg.type === "x")` —
and the dispatch is not a named call but the **construction of a tagged object literal**.

## Goals / Non-Goals

**Goals:**

- Recover the producer → handler hop for tagged-message protocols with the same precision discipline
  as the existing rules: static-only, additive-only, deterministic, no LLM.
- Reuse the event-channel key-kind namespacing and fan-out cap, and leave the existing rules'
  pairing untouched, so the new rule cannot alter the edges any existing rule produces.
- Make the hop *legible as a message hop* wherever it is reported, and make an unpairable send
  visible as a boundary rather than as silence.

**Non-Goals:**

- No transport modelling. The rule does not try to prove that a `ws.send` reaches a particular
  server process; it pairs a static tag with a static consumer of that tag inside the index.
- No type checking. Declared unions are read for the discriminant *field name* only, never resolved
  through generics or conditional types.
- No new MCP tool and no new artifact. Existing traversals gain edges; existing disclosure carries
  boundaries.
- No languages beyond TypeScript/JavaScript in this change.

## Decisions

**1. A fourth rule name, `'message-topology'`, added to the `synthesizedBy` union — not a widening
of `'event-channel'`.**
The provenance label is what lets a consumer exclude these edges and what lets a path say "message
hop" instead of "call". Folding them into `event-channel` would make the two indistinguishable after
the fact, and the two have different confidence stories: an `on(k, fn)` registration names its
handler function, while a `case` clause names only a position in a switch.
*Alternative considered:* a boolean flag on the edge. Rejected — the union already exists and is
matched exhaustively.

**2. The consumer side is modelled as a registration, so pairing is untouched.**
A `case "x":` clause is collected as a registration on key `"x"`. *As built:* its handlers are the
enclosing function of the clause (the code that selects the tag, so a verdict about it sees the
hop) and, when the clause body is one call, that callee too (`case "x": handleX(msg)`).
A construction site is collected as a dispatch on the same key.
*As built:* pairing runs in its own `pairMessageTopology`. It shares the event-channel fan-out cap
(`groupHandlersByKey`, counting one per clause container) and edge shape, and adds a test-file rule
(a test's handler pairs only within its file) and the boundary pass. Rounds 2–3 also tried
narrowing by directory distance and by name; both silently dropped real consumers and were removed,
so near-copies in a sample collection pair with each other (precision cost on such collections
only). The other rules' pairing is unchanged.

**3. The discriminant field is namespaced into the key.**
Keys are `<field>=<tag>`, where the tag keeps the event-channel namespacing (`type=str:restart`,
`type=const:Msg.Restart`), so a protocol keyed on `type` can never pair with one keyed on `kind`
that shares a tag, and a string never pairs with a constant. Marker registrations (a clause no
indexed function contains, or one testing an uncomparable constant) use NUL-separated keys that
never pair; a tag containing NUL is refused so it cannot forge one.

**4a. As built: a construction counts only when it is handed to a transport call.**
Measured on this repository before merge: with every tagged literal counted, the rule produced 154
edges, about 150 of them data-flow pairings such as a `CallEdge` literal `{ kind: "calls" }` and a
far-away `if (e.kind === "calls")`. Requiring the literal to be an argument of `send`, `postMessage`,
`sendMessage`, `dispatch`, `broadcast`, `publish` or `emit` (directly or through `JSON.stringify`)
left 7 edges, all real worker-message hops, and 40 disclosed `message-send` boundary sites
(telemetry `emit` calls and a watchdog protocol whose consumer is inside a worker-source string).
A Redux action creator that returns its action is not paired; its `dispatch({ type })` call site is.
The field set is closed for the same reason. Decision 4 (declared unions) is deferred: with the
transport gate, the false pairings it was meant to suppress no longer occur.

**4. Declared unions are an optional precision input, never a requirement.**
When a discriminated-union type is in the index, its discriminant field name is used to decide which
object literals count as messages, which suppresses tagging on unrelated literals that happen to
carry a `type` property. When no such type is found, the rule falls back to the field the *consumer*
tests — the consumer is the side that proves a discriminant exists. A construction site matching no
consumer field produces nothing.
*Alternative considered:* require a declared union. Rejected — plain JavaScript and untyped IPC
envelopes are exactly where the graph is emptiest, and the consumer-side evidence is sufficient.

**5. TypeScript gets a second collector beside the per-language chain.**
*As built:* the `addEvents` `else if` chain is untouched; message topology is collected in its own
block after it, under its own Pass-1 group, with its own prefilter (a cheap `content` regex), and
its edges are appended after every other rule's. So no other language's collection or edge order
can change, which an additive-only test asserts.

**6. An unpaired static send becomes a dynamic-boundary site with a new refusal reason.**
The vocabulary is closed, so the reason is added to it (`unindexed-message-consumer`). This is the
honesty requirement: a `send({type:"x"})` whose consumer lives in another repo must read as "not
recovered here", never as "no consumers". It also gives the federation case a hook later without
designing for it now.

## Risks / Trade-offs

- **Precision on wide protocols**: a protocol with more than `EVENT_CHANNEL_FANOUT_CAP` handlers for
  one tag drops that key → same behavior as event channels today, logged at the same place; the
  dropped key is a boundary, not a silent absence.
- **A `case` clause with a large inline body** gives an edge to the enclosing handler function rather
  than to the specific work → acceptable: the useful answer is "this message reaches this handler",
  and the clause's callees are already reachable from there by ordinary call edges.
- **Object literals that are not messages** (a `{ type: "button" }` props object) could be tagged →
  mitigated by requiring a consumer that tests that exact field against that exact literal; a tag
  with no consumer produces no edge, only a potential boundary record.
- **Graph growth** → bounded by the cap and by the requirement that both sides be static; measured
  on this repository and on a client/server app before merge (task 5.2).
- **Edges are reachability, not execution** → stated in the spec and carried in the label; the risk
  is a consumer reporting a message hop as a proven call, which the labelling requirement forbids.

- **Watcher drift between full analyses** → the watcher re-derives one file at a time, so saving
  a sender records `unresolved-in-file-scope` for a send the full build paired in another file
  (over-disclosure, the safe direction), and saving a consumer does not refresh a stale site in an
  unchanged sender. Both clear at the next `analyze`, as for every other cross-file disclosure.
- **A clause calling a method on some other object** (`console.log(m)`, `m.reply()`) or a name
  imported from a package is attributed to the enclosing function, never resolved by its bare
  name to a same-named function elsewhere (found in review).

## Migration Plan

Additive: a graph built without the rule and one built with it differ only by added edges, which is
asserted by test. No sidecar schema change beyond the added refusal-reason enum value; older
dynamic-boundary files remain readable. Rollback is disabling the rule registration — no on-disk
state needs undoing, though a re-analysis is needed to drop the edges.

## Open Questions

- Whether a follow-up should pair a construction site with a consumer in a *different indexed
  repository* through the federation surface. Out of scope here; the transport-boundary record is
  the hook that makes it possible later without changing this rule.
