# Contract graph projection: schema elements in the graph, the briefings, and more formats

> Status: PROPOSED (2026-11-01). Split from `add-service-contract-certification`, whose OpenAPI
> phase shipped `certify_service_contract` (reader, rule table, parity, in-repo consumer join).
> Research: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. The briefings' first slice (operations served
> by routes in scope, in `orient` and `blast_radius`) shipped in `add-contract-briefings`; the payload check in
> `certify_service_contract` shipped in `add-contract-payload-check`; operations as graph nodes with the
> `implements_endpoint` / `consumes_endpoint` edges and the `contractSchemas` capability shipped in
> `add-contract-node-projection`, which leaves the element model below (fields, messages, types),
> protobuf, GraphQL, generated clients, the changed-specification briefing, and federated consumers.

## Why

`certify_service_contract` answers when asked. An agent editing a route handler still does not
see, unasked, that the handler is declared in a specification, and graph tools (`orient`,
`analyze_impact`, `find_path`) do not see contract elements at all.

## What changes

| Part | What it does |
|------|--------------|
| Graph nodes | Messages, types, and fields become nodes too (`language` = `OpenAPI` / `Protobuf` / `GraphQL`), projected like IaC resources |
| Edges | Generated clients bound via `operationId` (handler → operation and client call → operation shipped) |
| Briefings | `orient` names the contract of a handler in scope; `blast_radius` lists contract elements a diff touches; both budgeted |
| Consumers | Reaching tests per consumer; federated repositories by stable id |
| Payload check | `contract-payload-missing-required` for object-literal request bodies; other bodies not assessed |
| Formats | protobuf v3, then GraphQL SDL, each in its own PR |

## Not built

Registry or network fetches, runtime traffic, contract tests or mock servers, code generation,
DTO-to-schema matching, any LLM.

## Impact

- Specs: `analyzer` — 1 ADDED; `mcp-handlers` — 2 ADDED.
- Finding: `contract-payload-missing-required` (advisory).
