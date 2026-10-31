# Adopt the MCP 2026-07-28 RC: cache hints carry the lease, tasks carry long builds

> Status: PROPOSED (2026-07-03, e2e audit follow-up). The explicitly staged NEXT step after the
> sibling `adopt-mcp-protocol-conformance` (rev 2025-06-18: annotations guard, outputSchema, error
> shape, elicitation) — that change's own "WATCH item, no work now" is this proposal's scope,
> **gated on the RC stabilizing**. Prior art: the MCP 2026-07-28 release candidate
> (https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/): result cache hints
> (`ttlMs`/`cacheScope`, modeled on HTTP Cache-Control), a Tasks extension (a tool call returns a
> task handle driven via `tasks/get`/`tasks/cancel`), full JSON Schema 2020-12 input schemas
> (`oneOf`/conditionals) + unrestricted output schemas, and a stateless core (no initialize
> handshake). All local, deterministic, no behavior change to any conclusion.

## The gap

1. **The epistemic lease is prose-only on the wire.** The lease's freshness signal is a factual
   note appended (degraded) or prepended (stale) to the tool result text
   (`src/core/services/mcp-handlers/epistemic-lease.ts:24-31`, injection at `:777-807` —
   `signal.prepend ? signal.text + text : text + signal.text`). A machine client cannot consume
   it without re-parsing prose. The RC's `ttlMs`/`cacheScope` is a protocol-native carrier for
   exactly this "how long may you trust this result" fact.
2. **Long operations are awkward over stdio.** The cold-start self-bootstrap builds the full index
   in a fire-and-forget background promise with no handle, no progress, no cancel
   (`src/cli/commands/mcp.ts:2441-2452` — `bootstrapAnalysisInBackground` injecting install's
   `buildIndex`), and a full `analyze_codebase` call blocks its request for the whole build. The
   Tasks extension is the fit: return a handle, poll via `tasks/get`, cancel via `tasks/cancel`.
3. **Mutually exclusive parameters are inexpressible.** `find_clones` takes `symbol` XOR `snippet`,
   but its schema requires only `directory` (`mcp.ts:1763-1773`) and the exclusivity lives in
   description prose ("Provide exactly one of symbol or snippet", `:1767-1768`) plus runtime
   rejection. JSON Schema 2020-12 `oneOf` states it declaratively, so hosts validate before
   dispatch.
4. **The stateless core breaks a known construct.** OpenLore ships a custom initialize handler
   (`mcp.ts:2402-2423`) that captures client identity, negotiates the protocol version, and
   carries the breadth-pointer `instructions` precisely BECAUSE the handler shadows the SDK's
   `instructions` option (comment at `:2417-2421`). Removing the handshake removes that carrier;
   the conformance sibling recorded this as a forward-compat risk and deferred it here.

## What changes — staged, every stage gated on the RC going final

- **Stage 0 (now): track, don't build.** A pinned task tracks the RC → final transition (spec
  revision + SDK release). Nothing below ships against the moving spec; the conformance sibling's
  rev-2025-06-18 work proceeds independently and lands first.
- **Stage 1 — cache hints as the lease's wire carrier.** Tool results gain `ttlMs`/`cacheScope`
  derived from the lease's existing thresholds (the 15-min degraded boundary,
  `epistemic-lease.ts:10`) — **no new tuning constant**. Honesty clauses: a hint is only ever MORE
  conservative than the lease (never advertises validity the lease would not); the prose note is
  RETAINED unchanged (the hint is additive, not a replacement — clients that ignore hints lose
  nothing); a result whose validity is watcher-event-bound (recall verdicts, certificates) declares
  the no-store-equivalent scope rather than a wall-clock TTL that would outlive a repo change.
- **Stage 2 — Tasks for the two genuinely long operations.** When the client negotiates the tasks
  capability, `analyze_codebase` and the cold-start bootstrap return task handles (progress via
  `tasks/get`, cancel via `tasks/cancel`); without the capability, behavior is byte-identical to
  today. No other tool becomes a task — conclusions stay synchronous by design.
- **Stage 3 — 2020-12 schemas.** `find_clones` declares `symbol` XOR `snippet` via `oneOf`; a
  sweep converts every prose-only exclusivity constraint on the surface. The runtime validator
  (`validateToolArgs`, `mcp.ts:2476-2481`) stays as defense in depth. Payload budget re-asserted
  (`mcp-presets.test.ts:582-584`, full < 88k) with the per-bump rationale discipline if `oneOf`
  grows schemas.
- **Stage 4 — stateless core migration.** Retire the custom initialize handler; move the breadth
  pointer, version report, and client-identity capture to whatever carriers the final spec
  provides. This is the WATCH item's discharge — its acceptance test is that the lean-default
  breadth pointer still reaches the client.

Deliberately NOT borrowed from the RC surface: server-initiated sampling (an LLM in the hot path —
still refused, per the audit set's out-of-scope list), remote/HTTP transports (local-first), and
speculative task-ification of ordinary conclusion tools (a deterministic answer that computes in
milliseconds gains nothing from a handle).

## Addendum (2026-10-31): the revision is published; correct the cache-hint scope

Source: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. The 2026-07-28 revision is published at
https://modelcontextprotocol.io/specification/2026-07-28/changelog. Stage 0's gate is now "the
TypeScript SDK supports it", not "the RC goes final". Corrections from the published text:

- **`ttlMs`/`cacheScope` are required on `tools/list`, `prompts/list`, `resources/list`,
  `resources/read`, `resources/templates/list`** (`CacheableResult`, SEP-2549) — not on tool-call
  results. Stage 1 therefore has two parts: (a) required: hints on `tools/list` (a long TTL, `private`
  scope; the preset decides the list), (b) optional, as already designed: the lease-derived hint on
  conclusion results, carried in `_meta` and never more permissive than the lease.
- **`tools/list` SHOULD be deterministically ordered** (prompt-cache hit rate). OpenLore's registry
  order is already fixed; add a guard test that pins it.
- **`subscriptions/listen` replaces `resources/subscribe`.** If OpenLore exposes the lease or the
  session ledger as a resource, `resourceSubscriptions` is the protocol-native push for "a symbol you
  read changed" — the same fact the loop hooks deliver (`add-agent-loop-hook-surfaces`). Hooks stay
  the primary carrier because not every client listens.
- **Tasks extension redesign:** polling via `tasks/get`, input via `tasks/update`, no `tasks/list`;
  servers may return task handles unsolicited. Stage 2 follows the redesigned shape.
- **Sampling, Roots, and Logging are deprecated** — consistent with OpenLore never using sampling.

## Why this is in scope

Pure protocol conformance on an existing surface, continuing the sibling's line: no new
capability, no LLM, no conclusion changes, no default-membership change (ADR-0023 governs
membership, not encoding). Cache hints make the lease's honesty machine-consumable; tasks make the
two real long operations honest instead of invisible; `oneOf` makes an existing contract
declarative.

## Impact

- `src/cli/commands/mcp.ts` (task plumbing, initialize retirement, schema sweep),
  `epistemic-lease.ts` (hint derivation beside the existing note), `mcp-presets.test.ts` (budget),
  SDK version bump when final.
- Specs: `mcp-quality` — 2 ADDED (RcAdoptionGatedOnFinalization,
  SchemasExpressParameterExclusivity); `mcp-handlers` — 2 ADDED
  (CacheHintsNeverOutrunTheLease, LongOperationsAreTasksWhenNegotiated).
- Risk: building against a moving spec (mitigated: stage 0 gate — nothing ships pre-final); hint
  misuse by caching clients (mitigated: conservative-only derivation + retained prose note);
  initialize retirement breaking older hosts (mitigated: version-negotiated — the old path remains
  for pre-RC protocol versions the SDK still pins).
