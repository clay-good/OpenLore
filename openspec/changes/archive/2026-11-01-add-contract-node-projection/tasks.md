# Tasks — add-contract-node-projection

## Graph
- [x] Normalize discovered OpenAPI documents into operation nodes (`language: OpenAPI`), stable addresses
- [x] `implements_endpoint` edges from indexed route handlers by method + normalized path template
- [x] `consumes_endpoint` edges from the HTTP projection's literal client calls
- [x] Unmatched operations, unmatched routes, and unreadable specifications disclosed on the build
- [x] Contract nodes excluded from the code candidate sets; contract edges excluded from fan-in/fan-out
- [x] A handler bound to a declared operation is a reachability root
- [x] Language-support capability `contractSchemas`

## Spec
- [x] `analyzer` delta: ADD ContractOperationsAreGraphNodesBoundToHandlers
- [x] `analyzer` delta: ADD UnboundContractElementsAreDisclosed
- [x] `analyzer` delta: ADD ContractElementsAreNotRankedAsCode
- [x] `analyzer` delta: ADD ClientCallsAreBoundToTheOperationsTheyConsume

## Docs
- [x] `docs/contracts.md`: the projection, the two edge kinds, and the limits
