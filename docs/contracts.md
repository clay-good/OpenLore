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

## Not read

Fields, messages and types as their own nodes; protobuf and GraphQL; generated clients bound by
`operationId`; registry or network fetches; runtime traffic; contract tests; code generation; any
LLM.
