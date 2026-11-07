# Tasks — add-contract-graph-projection

## Graph (OpenAPI)
- [x] Project operations onto graph nodes (`language: OpenAPI`), stable addresses — shipped in `add-contract-node-projection`
- [x] Named schemas (messages and types) as nodes, with `$ref` edges — shipped in `add-contract-schema-elements`; per-FIELD nodes deliberately not projected (the property-level verdict is `certify_service_contract`'s)
- [x] `implements_endpoint` edges from indexed route handlers by method + normalized path template — shipped in `add-contract-node-projection`
- [x] `consumes_endpoint` edges from HTTP-projection client calls, including operations with no in-repo handler — shipped in `add-contract-node-projection`
- [x] Generated-client calls bound via `operationId` when the module is a generated file sourced from the spec — shipped in `add-generated-client-operation-binding`
- [x] Language-support capability `contractSchemas` — shipped in `add-contract-node-projection`

## Briefings and consumers
- [x] `orient` / `blast_radius`: operations served by routes in scope — shipped in `add-contract-briefings`
- [x] `blast_radius`: contract elements a changed specification file touches — shipped in `add-blast-radius-changed-contracts`
- [x] `certify_service_contract`: reaching tests per consumer — shipped in `add-contract-consumer-tests`
- [x] `certify_service_contract`: federated consumers by stable id — shipped in `add-contract-federated-consumers`
- [x] `contract-payload-missing-required` in `certify_service_contract` — shipped in `add-contract-payload-check`
- [x] `verify_change` carries payload findings — shipped in `add-verify-change-payload-findings`

## Formats
- [x] protobuf v3 reader, implements edges from generated-server registrations, rule-table additions (field number/type, `reserved`, removed RPC) — shipped in `add-contract-protobuf-reader`; gRPC client calls (`consumes_endpoint`) deliberately not read, a disclosed boundary
- [ ] GraphQL SDL reader, implements edges from literal resolver maps; directives unassessed

## Spec
- [~] `analyzer` delta: ADD ContractSchemasAreDiscoveredAndNormalized (protobuf, GraphQL) — added with the protobuf half (plus RpcsAreBoundToTheImplementationTheirServerRegistrationNames, and `mcp-handlers` ProtobufChangesAreGradedByWireIdentity) in `add-contract-protobuf-reader`; the GraphQL reader MODIFIES it
- [x] `analyzer` delta: ADD ContractElementsAreGraphNodesBoundToHandlers + ContractReferencesAreStructuralAndAttributedByAddress, and broaden ContractElementsAreNotRankedAsCode to every surface that ranks or counts code — shipped in `add-contract-schema-elements`
- [x] `analyzer` delta: ADD ClientCallsAreBoundToTheOperationsTheyConsume — the generated-client half shipped; the path-matching half shipped in `add-contract-node-projection`
- [x] `mcp-handlers` delta: ADD ChangedSpecificationsAndFederatedConsumersSurface — the changed-specification half shipped as `ChangedSpecificationsSurfaceTheirBoundCode`; federated consumers shipped in `add-contract-federated-consumers` (#681)
