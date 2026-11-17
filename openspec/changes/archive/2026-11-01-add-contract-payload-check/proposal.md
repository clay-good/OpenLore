# Contract payload check: literal request bodies against required properties

> Status: SHIPPED (2026-11-01). A slice of `add-contract-graph-projection` (payload check), in
> `certify_service_contract`; `verify_change` carrying it, graph nodes, consumer tests, and
> protobuf/GraphQL stay there.

## Why

A client call that omits a property the operation requires fails at runtime. When the body is a
literal at the call site, the omission is visible statically.

## What changes

`certify_service_contract` reads the request body at each in-repo call site of an operation whose
body requires properties: an object literal, or `JSON.stringify` of one, in `fetch(url, { body })` or
`axios.post|put|patch(url, body)`. Each missing required property is an advisory
`contract-payload-missing-required` finding; a call with no body is one too; any other body (a
variable, a spread, a computed key) is listed as not assessed, never as conforming.

## Impact

- Specs: `mcp-handlers` — 1 ADDED.
- Finding: `contract-payload-missing-required` (advisory, registered).
