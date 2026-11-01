# Tasks — add-contract-graph-projection

## Graph (OpenAPI)
- [ ] Project operations, params, and fields onto graph nodes (`language: OpenAPI`), stable addresses, `$ref` edges
- [ ] `implements_endpoint` edges from indexed route handlers by method + normalized path template
- [ ] `consumes_endpoint` edges from HTTP-projection client calls, including operations with no in-repo handler
- [ ] Generated-client calls bound via `operationId` when the module is a generated file sourced from the spec
- [ ] Language-support capability `contractSchemas`

## Briefings and consumers
- [x] `orient` / `blast_radius`: operations served by routes in scope — shipped in `add-contract-briefings`
- [ ] `blast_radius`: contract elements a changed specification file touches
- [ ] `certify_service_contract`: reaching tests per consumer; federated consumers by stable id
- [x] `contract-payload-missing-required` in `certify_service_contract` — shipped in `add-contract-payload-check`
- [ ] `verify_change` carries payload findings for call sites the diff adds or changes

## Formats
- [ ] protobuf v3 reader, implements edges from generated-server registrations, rule-table additions (field number/type, `reserved`, removed RPC)
- [ ] GraphQL SDL reader, implements edges from literal resolver maps; directives unassessed

## Spec
- [ ] `analyzer` delta: ADD ContractSchemasAreDiscoveredAndNormalized (protobuf, GraphQL)
- [ ] `analyzer` delta: ADD ContractElementsAreGraphNodesBoundToHandlers
- [ ] `analyzer` delta: ADD ClientCallsAreBoundToTheOperationsTheyConsume
- [ ] `mcp-handlers` delta: ADD ContractConsumersCarryTheirTestsAndFederatedPeers
- [ ] `mcp-handlers` delta: ADD VerifyChangeCarriesPayloadFindings
