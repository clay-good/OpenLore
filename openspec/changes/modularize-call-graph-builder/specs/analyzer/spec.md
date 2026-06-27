# analyzer spec delta

## ADDED Requirements

### Requirement: StableCallGraphBarrel

The call-graph builder MAY be decomposed across multiple source modules for maintainability, but
`call-graph.ts` SHALL remain the stable public barrel for the call-graph subsystem. Every symbol that
is importable from `call-graph.ts` before such a decomposition SHALL remain importable from
`call-graph.ts` after it — extracted internals SHALL be re-exported from the barrel so that no module
importing `call-graph.ts` is required to change its import path.

The decomposition SHALL be behavior-preserving: for a fixed repository state, the call graph produced
after the decomposition SHALL be identical to the graph produced before it (same nodes, edges, edge
confidences, CFG overlay, and serialization). The decomposition SHALL NOT change extraction ordering or
node identity. The existing analyzer test suite SHALL serve as the regression oracle and SHALL pass
unchanged.

#### Scenario: The public import surface is preserved

- **GIVEN** a module that imports a symbol from `call-graph.ts`
- **WHEN** the call-graph builder is decomposed into sibling modules
- **THEN** that symbol is still importable from `call-graph.ts` (re-exported from the barrel)
- **AND** the importing module requires no change to its import path

#### Scenario: Graph output is byte-identical after decomposition

- **GIVEN** a fixed repository state and the call graph it produced before decomposition
- **WHEN** the call graph is rebuilt after decomposition
- **THEN** the resulting nodes, edges, edge confidences, CFG overlay, and serialized form are identical
- **AND** the analyzer test suite passes unchanged
