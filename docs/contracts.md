# Interface contracts in the graph

OpenLore models a codebase as nodes and edges. A declared HTTP interface maps onto the same
graph: an operation is a thing code serves and calls, so it becomes a node with edges to the
code on both sides.

Because contract elements are **projected onto the existing graph primitives**
(`FunctionNode` / `CallEdge`), the graph tools see them with no change of their own: `orient`,
`search_code`, `get_subgraph`, `analyze_impact`, the SCIP export, and the federation manifest. An
operation reaches you as a typed *cross-domain neighbour* (`crossDomain.operations`), never inside
the list of code functions — it is a declaration, not something you can edit or test. `find_path`
and `trace_execution_path` walk call edges only, so they do not route through an operation.

## The mapping

| Contract concept | OpenLore graph primitive |
|---|---|
| A declared operation (`GET /v1/orders/{id}`) | a node (`FunctionNode`), `language: OpenAPI` |
| The route handler that serves it | an `implements_endpoint` edge, **handler → operation** |
| The function that calls it | a `consumes_endpoint` edge, **caller → operation** |

`name` and the node address are `<METHOD> <path template>` with the servers base path included;
`filePath` and `startLine` point at the declaration in the specification; `className` is the
dialect (`OpenAPI` or `Swagger`); `signature` carries the `operationId` when the document
declares one.

Formats read: **OpenAPI 3.0 / 3.1** and **Swagger 2.0**, YAML or JSON. A file is a candidate when
its extension is `.yaml` / `.yml` / `.json` and it carries a top-level `openapi` or `swagger` key.

## A declaration is not a code unit

A contract node is excluded from every candidate set that ranks source code — hub functions,
entry points, `find_dead_code`, `report_coverage_gaps`, `briefing_since` — and a contract edge
never changes a function's fan-in or fan-out. Projecting a specification therefore changes no
structural metric of the code.

One conclusion does change, and deliberately: a handler that serves a declared operation is
**invoked from outside the code** — by whoever calls that endpoint, in this repository or outside
it — so it is a reachability root rather than a dead-code candidate. A handler no specification
declares is unaffected.

## Matching is literal

No name similarity, no embeddings, no prefix guessing.

- **Handler → operation.** The route's method and normalized path must equal the operation's. A
  router is often mounted *under* the servers base path, so a route also matches the path as
  declared under `paths` — but only when it carries a literal segment and exactly one operation
  across every specification has that method and declared path.
- **Caller → operation.** Same rule, plus one step: a call writes a value where the specification
  writes a parameter (`/v1/orders/7` against `/v1/orders/{id}`), so a concrete path binds to the
  one declared template that accepts it, segment by segment. An exactly declared path always
  wins over a template the same path could fill, and a path that fills two different templates
  binds nothing.
- A wildcard-method registration (`app.use`, `app.all`) declares no one operation, so it matches
  nothing.

## Everything unbound is disclosed

The projection never implies absence. The build result carries:

| Disclosure | Means |
|---|---|
| `unmatchedOperations` | Declared, but no indexed route serves it and no indexed call consumes it |
| `unmatchedRoutes` | Registered, but no declared operation matched it |
| `unresolvedBindings` | A route or call that *did* match an operation, whose handler or caller resolved to no single indexed function |
| `unreadSpecifications` | The file declared itself a specification and could not be read, with the reason |
| `unboundClientCalls` | The call's method or path is not literal, its host is not one this specification declares, its address is ambiguous, or no operation declares it |
| `ambiguousAddresses` | A method and path that name more than one declared operation, so nothing binds to them |
| `notAssessed` | Why an "unmatched" conclusion is **withheld** rather than drawn |
| `truncations` | Every cap the projection stopped at, with what it saw |

Each list is bounded and carries its exact `total`, so a disclosure never becomes the thing that
blows up the artifact carrying it.

A specification that fails to parse is therefore *unread*, never read as "declares nothing" — and
while anything is unread, degraded, or past a cap, nothing is called unmatched at all:
`notAssessed` says why. `find_dead_code` repeats the part that bears on liveness, because an
unresolved binding means a declared handler can still look dead.
`certify_service_contract` is the conclusion-shaped view of the same parity, with breaking-change
verdicts; the `contracts` line in `orient` and `blast_radius` names the operation a handler in
scope serves.

## When it is computed

The projection runs during `openlore analyze`, with the rest of the graph. A specification is not
source code, so a subset rebuild — the watcher's per-file pass, or a shard-scoped re-analysis —
does not re-project it, exactly as it does not re-project an infrastructure manifest. Contract
edges are therefore **preserved**, not deleted, when a bound handler's own file is rebuilt: a save
cannot silently drop the binding. Run `openlore analyze` to refresh the operations after a
specification changes.

## Named schemas as nodes

Each named schema a specification declares — `components/schemas` in OpenAPI 3, `definitions` in
Swagger 2 — is a graph node, and `references_schema` edges connect an operation to the schemas it
names and a schema to the schemas its own definition names:

```
implements_endpoint : createOrder -> POST /v1/orders
references_schema   : POST /v1/orders -> #/components/schemas/Order
references_schema   : POST /v1/orders -> #/components/schemas/OrderInput
references_schema   : #/components/schemas/Order -> #/components/schemas/Customer
```

That shape is the point: a schema shared by twenty operations is **one node with twenty inbound
edges**, so "what does changing `Order` touch?" is a graph question, and a handler reaches the
schemas of its own contract through the operation it serves.

**Per-field nodes are deliberately not projected.** A large document has thousands of fields, and
the question they would answer — did this property's type or requiredness change — already
belongs to `certify_service_contract`'s verdict. The named schema is the reusable unit.

Edges are **direct only**; the transitive closure is the graph's to walk rather than a list
duplicated on every node. A cycle terminates, each edge drawn once. A `$ref` naming something the
document does not declare — an external reference, or a name that does not resolve — draws no edge
and is disclosed; nothing is invented for it. The number of projected schemas is bounded, and a
document past the cap says so rather than projecting part of its schemas silently.

A `references_schema` edge is a declaration binding, so it contributes to no function's degree, no
entry-point or hub classification, no file-level dependency ranking and no layer violation —
verified as a difference between two builds of the same code, one with the specification and one
without.

## Generated clients

A generated API client builds its URL from a base variable —
`fetch(`${BASE}/orders/${id}`)` — so the HTTP projection extracts no literal path and binds
nothing by path: the operation it calls reads as consumed by no one, which is false. Its method
name, though, *is* the `operationId`, an exact identifier rather than a resemblance.

So where a module's **header names a specification** as the source it was generated from, a
function in that module whose name is exactly an `operationId` of that specification is linked to
that operation with a `consumes_endpoint` edge.

A wrong edge is worse than a missing one, so the header declaration carries the whole safety of
the rule and is held to three conditions — each one closing a wrong edge found by review:

| Condition | What it stops |
|---|---|
| The reference is in a **comment** in the header | A loader that reads the specification at runtime, a fixture path, a string constant. |
| The same line carries a **generation marker** (`@generated`, `generated from`, `DO NOT EDIT`, …) | `// See api/openapi.yaml for the wire contract these mirror.` on a hand-written module. |
| The reference matches on **path boundaries** | `api/openapi.yaml` naming `third-party/stripe/openapi.yaml` — `openapi.yaml` is the common filename, and a substring test bound a client to a vendored spec, making the graph assert the repository called Stripe. |

Projected declarations are not candidates either: a Bicep `var getOrder` in a file whose header
named the specification was otherwise bound, linking a declaration to a declaration. Nor are test
modules, whose fixtures mention a specification for conformance and whose helpers collide readily
with a short `operationId` such as `list`.

Where the name matches more than one function node, or a document declares one `operationId`
twice, nothing binds and the case is disclosed in `unresolvedGeneratedBindings`. Two same-named
functions in ONE module collapse to a single graph node before the guard sees them, so that case
binds the surviving node.

Such an edge records `synthesizedBy: 'operationId'`, because it has **no literal call site by
construction** — that is why it is bound by name. `verify_claim endpoint-consumed` reads that
provenance and confirms the consumption instead of reporting a snapshot disagreement it would
otherwise infer from finding no call text.

The edge's evidence is a comment in a code file, which the watcher does re-read — but the watcher
never re-projects contracts, and contract edges are preserved across a subset rebuild. So
deleting a `@generated from …` header does not drop the binding until the next `openlore
analyze`.

## Consumers in other repositories

A service's consumers are usually **not in its own repository**, so a breaking verdict computed
from this repository alone says "no caller in this repository" for exactly the change most worth
stopping. Pass `federation: true` (or `--federation`) and `certify_service_contract` also censuses
the client call sites of the indexed siblings in `.openlore/federation.json`, reporting each hit
against the sibling's **registry name** — its stable id — never a path on this machine.

A finding then distinguishes three states, which the single in-repo answer collapsed:

| State | What the finding says |
|---|---|
| Called here | `called from src/client.ts:12` |
| Called only in a sibling | `no caller in this repository, but called from web:src/client.ts:4` |
| Called in neither | `no caller in this repository or in 3 censused sibling repositories (1 not censused)` |

The third is the one that must not read as proof of safety, so it names how many siblings were
censused, how many were only **partly** scanned, and how many were not censused at all.

The same consumer rule applies across repositories as within one — and getting this wrong is how
a tool accuses an innocent repository:

| Rule | Why |
|---|---|
| A call counts only if its URL is host-less or names a declared `servers` host | Across repositories a host mismatch is the *normal* case. Without this, a sibling's call to another vendor on the same path was reported as consuming your operation, inside an error finding. |
| An all-parameter path (`/{tenant}/{id}`) is excluded and disclosed | It matches almost any URL of that segment count — a Stripe call and a GitHub call were both reported as consumers. |
| Only `breaking` and `dangerous` addresses are censused | The same scope the in-repository join uses; no finding asks about the rest. |
| Sibling directories are compared by canonical path | Otherwise the repository under certification is censused as its own sibling (`/tmp` vs `/private/tmp`), and two names for one directory count every call site twice. |
| Every repository-derived string is screened | A registry name is attacker-influenced text; an instruction-shaped one was being served verbatim through the boundary list. |

`federationCensus` reports `repos`, `partial` and `skipped` — a sibling that is missing,
unindexed, stale or unbaselined is **named as not censused**, never counted consumer-free; one
whose scan hit a file cap is named as partly scanned; a registry name you asked for that does not
exist is reported rather than ignored; and a registry that cannot be read is named rather than
answered as though you had not asked.

Consumers come back as one bounded top-level `federatedConsumers` list with an exact omitted
count, each entry tagged with its operation address. Nested per changed element they were
unreachable to the response trimmer, and a 200-operation change blew the byte budget and replaced
the whole verdict with a cut JSON string. Without the flag, the tool says plainly that consumers
outside this repository were not assessed.

## Editing a specification

A specification is not a call-graph node and declares no handler of its own, so a diff that edits
only `openapi.yaml` used to brief an agent on nothing at all: no impacted symbols, no tests, no
contracts. `blast_radius` now carries a `changedContracts` field for exactly that diff — the
elements the changed specifications declare, and for each one the indexed handler that serves it
and the in-repo call sites that consume it. Consumers are read from the whole repository, not from
the diff, because a specification change affects callers the diff never touched.

It is a blast radius, not a verdict. It does not compare against a base revision and does not
grade the change; `certify_service_contract` with a base ref owns that conclusion, and the field's
note says so.

Honesty rules, the same as everywhere else here. `unbound` is the only new claim the field
makes, so it is the one held hardest: an element is `unbound` only when **nothing stood in the
way of seeing a binding** — a concrete-method route is indexed, no route matched it ambiguously,
the consumer scan ran and was not capped, and its path is not all-parameter. Each of those is
otherwise disclosed as not assessed. Specifically:

| Situation | Why `unbound` is withheld |
|---|---|
| No route inventory | No index is not no handler. |
| Every indexed route has a wildcard method (Django) | Such a route cannot be matched to an operation, but it may well serve it. |
| Several routes match one operation | It is ambiguous, not unbound; the candidates are named and no single handler is. |
| The operation path is all parameters (`/{kind}/{id}`) | It matches too broadly to attribute either a handler or a caller. |
| The consumer scan was capped or failed | Absence of evidence, not evidence of absence. |

A call site counts as a consumer only when its literal URL has no host (relative — this service)
or a host the specification's own `servers` declares; a call to another vendor on the same path
shape is not a consumer, and the count of such calls is disclosed. `servedBy` is read from the
route inventory as of the last `analyze`, which the field says, since a handler added since then
is not reflected. The consumer scan reads TypeScript, JavaScript, Python and Go, which it also
says. A changed specification that cannot be parsed, cannot be read, was never examined under the
scan cap, or parses with no operation the reader recognizes is named rather than dropped.

## Not read

Per-FIELD nodes (named schemas are projected; individual properties are not); protobuf and
GraphQL; registry or network fetches; runtime traffic; contract tests; code generation; any
LLM.
