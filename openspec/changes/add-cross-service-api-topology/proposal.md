# Cross-service API topology: deterministic client-call-site → server-route edges, within and across repos

> Status: IMPLEMENTED (2026-06-26). Part of the `STRUCTURAL-CONTEXT-PATTERNS.md` set. Projects HTTP
> client→server relationships onto the existing call-graph primitives, the same way the IaC subsystem
> projects infrastructure dependencies — so `analyze_impact`, `find_path`, and `blast_radius` answer
> "who calls this endpoint?" across the process boundary. No graph-schema change, no new dependency,
> no LLM, no runtime tracing.
>
> **Implementation note (what was found vs. built).** The single-repo projection described in items
> 1–3 below **already existed** in the analyzer (`http-route-parser.ts` + call-graph Pass 2b's
> `http_endpoint` edges) — but it was untested at the call-graph layer and *silently broken* for the
> most common Node idiom (a top-level `app.get(...)` registration mis-resolved its handler name, so no
> edge wired), and it never matched a same-language TS client→TS server. This change adds the
> characterization tests that surfaced those defects, **fixes** them, makes coverage **observable**
> via a `crossServiceHttp` language-support capability, and builds the genuinely net-new **cross-repo
> federation bridge** (item 4). The proposal's original premise that cross-repo worked "for free under
> federation" was **incorrect** — federation resolves by symbol *name*, but a client call references a
> *route key*, not the handler's symbol — so a dedicated route-key resolver was required. See
> `tasks.md` for the per-item built/found/deferred breakdown and `docs/cross-service-topology.md`.

## Why

OpenLore's call graph is sound and complete *up to the process boundary* and then it stops. In a
service-oriented or full-stack codebase, the most consequential edges are the ones it cannot see: a
frontend or service calls `fetch("/api/users/:id")` / an HTTP client method, and that request is
handled by a route registered in another module — or another repository. To the call graph these are
two disconnected islands. So "if I change this endpoint's contract, what breaks?" — the single most
common cross-service change-impact question — gets the answer "nothing," because the client call sites
that depend on the endpoint are invisible to `analyze_impact`. The blast radius of an API change stops
exactly where it matters most.

OpenLore already has both halves of the bridge. It parses **server-side route registrations** within a
repo (`src/core/analyzer/http-route-parser.ts`), and it already **projects a normalized relationship
graph onto `FunctionNode`/`CallEdge`** for an entire family of non-call relationships — every IaC
ecosystem does exactly this through `src/core/analyzer/iac/project.ts` with zero tool or schema
changes. The missing piece is the **client** half (statically recognizing outbound HTTP call sites and
their method+path) and the **matcher** that links a client call site to the server route it targets.
Federation already gives cross-repo stable symbol IDs and cross-repo `analyze_impact`/`find_path`, so
once the edge exists in one repo's graph it extends across the federation for free.

A peer system makes this an explicit edge type and matches client call sites to server routes
(including across sibling repos under one workspace) using framework-aware scanners — exactly the
projector-on-top-of-AST shape OpenLore already uses for IaC. We adopt the concept on OpenLore's
existing primitives.

## What changes

1. **Client call-site extraction (the missing half).** A framework-aware, static scanner recognizes
   outbound HTTP call sites — the common JS/TS client idioms (`fetch`, `axios`, `ky`, `got`; a typed
   API-client wrapper built on one of these is captured at its own call site, callers reaching the
   endpoint transitively) — and extracts the **method + path template** each targets, plus the
   enclosing function (so the edge has a real source node). This mirrors how `http-route-parser.ts`
   already extracts server routes, and is gated per framework/language through the
   `add-declarative-language-support-registry` seam so coverage is observable and extends as languages
   land.

2. **A deterministic client→server matcher.** A normalized route key (method + path template, with
   path parameters normalized so `/users/:id` and `/users/{id}` and `/users/123` reconcile) links each
   client call site to the server route handler that registers the matching key. The match is exact and
   structural; an ambiguous or unresolved target (templated path, dynamic base URL, no registered
   route in scope) emits **no edge**, never a guessed one — the same honesty contract every IaC
   extractor follows.

3. **Projection onto existing primitives (no schema change).** The matched relationship is projected
   as an edge from the client call site's enclosing function to the server route handler, through the
   same projector path the IaC subsystem uses — so `analyze_impact` on a route handler surfaces its
   client callers, `find_path` can route from a client function to a handler, and `blast_radius` on an
   endpoint includes its consumers. No new node kind, edge schema, or MCP tool is required; the
   existing navigation/impact tools simply see more of the graph. The provenance of these edges is
   labeled (an HTTP/cross-service relationship, not a direct call) using the existing edge-metadata
   convention IaC already uses, so a consumer can distinguish a same-process call from a service hop.

4. **Cross-repo under federation (via a route-key bridge — NOT "for free").** The original premise
   here was wrong and was corrected during implementation: federation resolves cross-repo edges by
   matching a producer's symbol *name* at an external call site, but a client call references a
   *URL/route key*, not the handler's symbol — so the name-based resolver can never bridge the hop.
   The implementation adds `findCrossRepoClientCallers`: given a home handler's route key, it loads
   each scoped repo's index, re-extracts that repo's client call sites, and matches them with the same
   `buildHttpEdges` the single-repo edge uses. `analyze_impact` on a route handler then surfaces
   `crossServiceConsumers` in *other services* — the cross-service blast radius. Within a single repo
   (a full-stack monolith or a monorepo of services), the edge is local and needs no federation.

5. **Determinism & honesty.** Edges are a deterministic function of the parsed client call sites and
   server routes; re-analysis is byte-identical. Only statically-resolvable client→server pairs become
   edges; everything dynamic emits nothing and is eligible for a `confidence-boundary`
   known-unknowable note (dynamic dispatch across a network boundary), consistent with how OpenLore
   already discloses the edges it cannot resolve.

## Decision

**Static client→server matching projected onto the call graph — no runtime tracing, no OpenAPI
requirement.** The bridge is built purely from source: recognize client call sites, normalize route
keys, match to registered server routes, project the matched pairs as labeled edges via the existing
IaC-style projector. We deliberately do not ingest runtime traces, require an OpenAPI/schema document,
or call any service — those are either non-deterministic or out of OpenLore's local-first substrate
scope. Unresolvable pairs emit no edge by design, exactly like every IaC ecosystem's dynamic
constructs. An OpenAPI/contract file, if present, MAY later *strengthen* matching (a follow-up), but is
never required.

## Scope contract — do not break these things

This change must NOT:
- Change the `FunctionNode` / `CallEdge` / `ClassNode` schema or add an MCP tool. Cross-service edges
  ride the existing primitives and the existing impact/navigation tools, exactly like IaC.
- Invent an edge where the target route cannot be statically resolved. Dynamic/templated targets emit
  nothing and may carry a known-unknowable disclosure.
- Perform any runtime tracing, network call, or service introspection. Static parse only.
- Require an OpenAPI/schema document. It is an optional future strengthener, never a precondition.
- Regress same-process call extraction or any existing language. Cross-service edges are additive and
  labeled distinctly from direct calls.

## Out of scope (deferred)

Non-HTTP transports (gRPC, message queues / pub-sub, GraphQL, tRPC) — each is a later projector on the
same pattern; OpenAPI/contract-file-strengthened matching; request/response *payload* type reconciliation
across the boundary; and a dedicated cross-service-topology MCP tool or diagram (the existing impact and
pathfinding tools already answer the questions once the edges exist; a visualization is a separate,
optional surface).

## Implementation status

Tracked in `tasks.md`. Verified by a single-repo full-stack fixture (a client `fetch` call site links to
its route handler; `analyze_impact` on the handler surfaces the client caller), a path-parameter
normalization test (`:id` / `{id}` / a concrete value reconcile), a dynamic-target test (a templated
path emits no edge), a cross-repo federation test (a client in one indexed repo links to a handler in
another), and a determinism test.
