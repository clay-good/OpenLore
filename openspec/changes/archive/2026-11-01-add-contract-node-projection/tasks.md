# Tasks — add-contract-node-projection

## Graph
- [x] Normalize discovered OpenAPI documents into operation nodes (`language: OpenAPI`), stable addresses
- [x] `implements_endpoint` edges from indexed route handlers by method + normalized path template
- [x] `consumes_endpoint` edges from the HTTP projection's literal client calls
- [x] Every refusal disclosed on the build (unmatched, unresolved, ambiguous, unread, unbound, caps), each list bounded with an exact total
- [x] An unmatched conclusion withheld while any input was not assessed
- [x] An ambiguous address binds nothing; an absolute-URL call binds only a host the document declares
- [x] Contract nodes excluded from the code candidate sets; contract edges excluded from fan-in/fan-out — in the in-memory build and the persisted graph
- [x] An operation reaches the agent as a typed cross-domain neighbour, not as a code function
- [x] Contract edges preserved by a subset rebuild, which cannot re-project them
- [x] `verify_claim` answers `unverifiable`, not `refuted`, when the graph disagrees with its scan
- [x] A handler bound to a declared operation is a reachability root
- [x] Language-support capability `contractSchemas`

## Spec
- [x] `analyzer` delta: ADD ContractOperationsAreGraphNodesBoundToHandlers
- [x] `analyzer` delta: ADD UnboundContractElementsAreDisclosed
- [x] `analyzer` delta: ADD ContractElementsAreNotRankedAsCode
- [x] `analyzer` delta: ADD ClientCallsAreBoundToTheOperationsTheyConsume

## Docs
- [x] `docs/contracts.md`: the projection, the two edge kinds, and the limits
