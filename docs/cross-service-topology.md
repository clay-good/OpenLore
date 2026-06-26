# Cross-service API topology

OpenLore's call graph is sound up to the process boundary and then it stops. In a service-oriented or
full-stack codebase the most consequential edges are the ones static call analysis can't see: a
frontend or service calls `fetch("/api/users/:id")`, and that request is handled by a route registered
in another module — or another repository. Cross-service topology bridges that gap by projecting the
client→server relationship onto the **existing** call-graph primitives, exactly the way the IaC
subsystem projects infrastructure. No new node kind, no new edge schema, no new MCP tool, no LLM, no
runtime tracing — the existing impact/pathfinding/blast-radius tools simply see more of the graph.

## What you get

A matched outbound HTTP call site becomes a function→function edge from the **client call's enclosing
function** to the **server route handler**, labeled `http_endpoint` (distinct from a direct call). So:

- `analyze_impact` on a route handler surfaces its client callers — the blast radius of an API change.
- `find_path` can route from a client function to the handler it ultimately invokes.
- `find_dead_code` keeps a handler live because a client reaches it across the boundary.

```
loadUser()  ──http_endpoint──▶  getUser()      # GET /api/users/:id
createUser() ─http_endpoint──▶  addUser()       # POST /api/users
```

## How matching works

1. **Client extraction** (`extractHttpCalls`) recognizes the common client idioms — `fetch`, `axios`,
   `ky`, `got` — in JS/TS and recovers each call's method + path + the line it sits on.
2. **Route extraction** recovers server route registrations: Python (FastAPI / Flask / Django),
   Java (Spring MVC / JAX-RS), and TS/JS (Express / NestJS / Next.js App Router / Fastify / Hono / Koa).
3. **Normalized route key** — both sides are reduced to `METHOD + /path/template`, with path parameters
   normalized so equivalent forms reconcile: a client `` `/users/${id}` ``, a route `/users/:id`, and a
   route `/users/{id}` all collapse to `/users/:param`. Common API prefixes (`/api`, `/api/v1`, …) are
   tried with and without the prefix, so a frontend call to `/api/v1/search` still matches a router
   mounted at `/search`.
4. **The match** is exact/structural (`buildHttpEdges`, tiers `exact` / `path` / `fuzzy`). An ambiguous
   or unresolved target emits **no edge**, never a guessed one.

The handler is resolved by name, preferring the route registration's own file but falling back to a
**unique** match elsewhere — so a framework whose routing table is separate from its handler
definitions still links (Django's `urls.py` → `views.py`, or an Express app with a dedicated routes
file). A handler name that collides across files stays unresolved rather than guessed.

## The honesty contract (no edge on dynamic)

A client call whose target cannot be statically resolved — a non-literal URL (`fetch(endpoint)`), a
dynamically-constructed path, or a dynamic base URL — produces **nothing**. The bridge is built purely
from source: it never traces runtime, never calls a service, and never requires an OpenAPI/contract
document. Re-analysis of a fixed repository is byte-identical.

> The spec notes that an unresolved target is *eligible for* a known-unknowable confidence-boundary
> disclosure. That disclosure (surfacing "N client calls here are dynamic and unmatchable") is a
> deferred follow-up; today the contract is simply that a dynamic target is never linked.

## Cross-repo, under federation

Within a single repo (a full-stack monolith or a monorepo of services) the edge is local and needs no
configuration. Across a **federation** of indexed repos, a client call in repo A is linked to a handler
in repo B by matching A's client call sites against B's handler route key (`findCrossRepoClientCallers`,
the same `buildHttpEdges` matcher). `analyze_impact` on B's handler then reports A's client as a
`crossServiceConsumers` entry in its federation block — the cross-service blast radius across service
boundaries.

This is **not** "free" from federation's symbol-name resolution: a client call references a URL, not the
handler's symbol, so the name-based cross-repo resolver can never see it. The route-key bridge is the
piece that makes cross-repo cross-service impact work. (It re-extracts client call sites from each
scoped repo's source per query; a persisted client-call index is a future optimization.)

## Observability

Which languages participate is an observable fact: the `crossServiceHttp` capability in the
[language-support matrix](language-support.md) (and the `get_language_support` MCP tool) reports clients
for TS/JS and routes for TS/JS, Python, and Java. A language that backs neither reads `·`, honestly.

## Out of scope (deferred)

Non-HTTP transports (gRPC, message queues / pub-sub, GraphQL, tRPC) — each a later projector on the same
pattern; OpenAPI/contract-file-strengthened matching; request/response payload-type reconciliation
across the boundary; and a persisted per-repo client-call index for cheaper federated queries.
