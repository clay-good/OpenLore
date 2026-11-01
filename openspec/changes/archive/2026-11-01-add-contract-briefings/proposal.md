# Contract briefings: the OpenAPI operation a handler serves, unasked

> Status: SHIPPED (2026-11-01). The first slice of `add-contract-graph-projection` (briefings),
> built on the shipped `certify_service_contract` readers; graph nodes, the payload check, consumer
> tests, and protobuf/GraphQL stay there.

## Why

`certify_service_contract` answers when asked. An agent editing a route handler did not see,
unasked, that the handler is declared in a specification and what the declaration requires.

## What changes

| Briefing | Adds |
|----------|------|
| `orient` | `contracts`: OpenAPI operations served by indexed routes in the files in scope — address, `operationId`, spec file:line, the serving route, required parameters and body properties, deprecation (at most 5; trimmed first under a token budget) |
| `blast_radius` | `contracts`: the same for routes in the files the diff changes |

Matching is by method and normalized path, as in the certification's parity. Read only when a file
in scope has an indexed route. Specification text is screened.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
