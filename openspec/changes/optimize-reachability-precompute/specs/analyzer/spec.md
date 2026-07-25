# analyzer spec delta

## ADDED Requirements

### Requirement: ReachabilityStructureIsComputedAtAnalyzeTime

Analyze (and the watcher's flush) SHALL compute an SCC condensation and topological order of the
resolved call graph and persist a compact integer-indexed forward/backward adjacency
representation, carrying per-edge kind/confidence so existing edge filters remain expressible.
The structure SHALL be written under the same atomic-write and attestation discipline as the
sibling artifacts and SHALL share their invalidation key; it SHALL never survive a graph it was
not built from.

#### Scenario: The structure tracks the graph, never leads or trails it

- **GIVEN** a watcher flush that changes the call graph
- **WHEN** the flush completes
- **THEN** the persisted traversal structure was rebuilt from the new graph under the same
  attestation, and a reader can never observe a structure/graph pair from different generations

#### Scenario: Edge filters survive the representation change

- **GIVEN** a traversal that today excludes `synthesized` edges
- **WHEN** it runs over the precomputed structure
- **THEN** the excluded edges are skipped via the per-edge mask and the result equals the
  filtered per-call BFS answer
