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
- Reuse `pairAndEmitEventEdges`, the key-kind namespacing and the fan-out cap unchanged, so the new
  rule cannot alter the edges any existing rule produces.
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
A `case "x":` clause is collected as a registration on key `"x"` whose handler is the nearest
enclosing function of the clause body — or, when the clause body's only statement is a call, that
callee, which is the common `case "x": handleX(msg)` shape and gives the more useful edge target.
A construction site is collected as a dispatch on the same key. Both then flow through
`pairAndEmitEventEdges` unchanged, inheriting the cap and the kind namespacing.
*Alternative considered:* a bespoke pairing pass for clauses. Rejected — it would duplicate the cap
and namespacing logic, which is exactly the drift the existing per-rule structure avoids.

**3. The discriminant field is namespaced into the key.**
Keys become `<field>:<literal>` (`type:restart`), reusing the existing kind-namespacing mechanism,
so a protocol keyed on `type` can never pair with one keyed on `kind` that happens to share a tag
literal. This is what makes the rule safe in a repository holding several protocols.

**4. Declared unions are an optional precision input, never a requirement.**
When a discriminated-union type is in the index, its discriminant field name is used to decide which
object literals count as messages, which suppresses tagging on unrelated literals that happen to
carry a `type` property. When no such type is found, the rule falls back to the field the *consumer*
tests — the consumer is the side that proves a discriminant exists. A construction site matching no
consumer field produces nothing.
*Alternative considered:* require a declared union. Rejected — plain JavaScript and untyped IPC
envelopes are exactly where the graph is emptiest, and the consumer-side evidence is sufficient.

**5. TypeScript gets two collectors, so the language dispatch chain stops being exclusive.**
Today `addEvents` runs in an `else if` chain, one collector per language. TS needs both
`event-channel` and `message-topology`, so the chain becomes per-language additive calls. Each
collector keeps its own prefilter (a cheap `content` regex) so a file with no tagged literals and no
switch on a member expression costs one failed regex.
*Risk of this edit:* it touches the dispatch of every language's collector. Mitigated by the
existing per-rule tests plus a graph-equality test asserting non-TS languages produce byte-identical
edge sets before and after.

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

## Migration Plan

Additive: a graph built without the rule and one built with it differ only by added edges, which is
asserted by test. No sidecar schema change beyond the added refusal-reason enum value; older
dynamic-boundary files remain readable. Rollback is disabling the rule registration — no on-disk
state needs undoing, though a re-analysis is needed to drop the edges.

## Open Questions

- Whether a follow-up should pair a construction site with a consumer in a *different indexed
  repository* through the federation surface. Out of scope here; the transport-boundary record is
  the hook that makes it possible later without changing this rule.
