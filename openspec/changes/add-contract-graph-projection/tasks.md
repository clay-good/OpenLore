# Tasks — add-contract-graph-projection

## Graph (OpenAPI)
- [ ] Project operations, params, and fields onto graph nodes (`language: OpenAPI`), stable addresses, `$ref` edges
- [ ] `implements_endpoint` edges from indexed route handlers by method + normalized path template
- [ ] `consumes_endpoint` edges from HTTP-projection client calls, including operations with no in-repo handler
- [ ] Generated-client calls bound via `operationId` when the module is a generated file sourced from the spec
- [ ] Language-support capability `contractSchemas`

## Briefings and consumers
- [ ] `orient`: the contract element of a handler in scope (required params/properties, type, enum, format, bounds), budgeted
- [ ] `blast_radius`: contract elements touched by the diff, budgeted
- [ ] `certify_service_contract`: reaching tests per consumer; federated consumers by stable id
- [ ] `contract-payload-missing-required` registered (advisory); non-literal bodies disclosed

## Formats
- [ ] protobuf v3 reader, implements edges from generated-server registrations, rule-table additions (field number/type, `reserved`, removed RPC)
- [ ] GraphQL SDL reader, implements edges from literal resolver maps; directives unassessed

## Spec
- [ ] `analyzer` delta: ADD ContractSchemasAreDiscoveredAndNormalized (protobuf, GraphQL)
- [ ] `analyzer` delta: ADD ContractElementsAreGraphNodesBoundToHandlers
- [ ] `analyzer` delta: ADD ClientCallsAreBoundToTheOperationsTheyConsume
- [ ] `mcp-handlers` delta: ADD ContractElementsSurfaceInTheBriefings
- [ ] `mcp-handlers` delta: ADD LiteralPayloadsAreCheckedAgainstRequiredProperties
