# Contract node projection: OpenAPI operations in the graph, bound to the code that serves and calls them

> Status: PROPOSED (2026-11-01). Split from `add-contract-graph-projection`, which keeps the
> remaining element model (fields, messages, types), the protobuf and GraphQL readers, the
> changed-specification briefing, and federated consumers.
> Research: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`.

## Why

`certify_service_contract` and the `contracts` briefing answer from the specification file. The
graph itself still does not hold the declared interface, so `orient`, `analyze_impact`,
`get_subgraph`, `find_path`, `search_code` and the federation and SCIP exports cannot see that a
handler serves a declared operation, or that a client call consumes one.

## What changes

| Part | What it does |
|------|--------------|
| Graph nodes | Each OpenAPI/Swagger operation becomes a node (`language: OpenAPI`), addressed `<METHOD> <path template>`, projected like an IaC resource |
| `implements_endpoint` | Handler → operation, from the indexed route registrations, matched literally by method and normalized path |
| `consumes_endpoint` | The function enclosing a client call → operation, by method and normalized literal URL, with or without a handler in the repository |
| Liveness | A handler that implements a declared operation is invoked from outside the code, so it is a reachability root, not dead code |
| Disclosure | Operations no route serves, and routes no operation declares, stay listed as unmatched; a specification that cannot be read is disclosed, never read as empty |
| Capability | Language-support capability `contractSchemas` |

Contract elements are declarations, not code units: they are excluded from the code candidate
sets (hubs, entry points, dead code, coverage gaps, significance) and their edges are excluded
from the structural fan-in/fan-out metrics.

## Not built

Fields, messages and types as nodes; protobuf and GraphQL; generated-client binding by
`operationId`; the changed-specification briefing; federated consumers. All stay in
`add-contract-graph-projection`.

## Impact

- Specs: `analyzer` — 2 ADDED.
- Edge kinds: `implements_endpoint`, `consumes_endpoint`.
- Capability: `contractSchemas`.
