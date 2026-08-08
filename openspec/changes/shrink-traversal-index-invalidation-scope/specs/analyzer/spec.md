# analyzer spec delta

## ADDED Requirements

### Requirement: TraversalStructureIsKeyedToTheGraphItDescribes

Analyze SHALL compute a digest over exactly the call-graph facts the precomputed traversal
structure depends on — the node id set, and each usable edge's caller, callee, and
synthesized-ness in `cg.edges` order — persist it as a field of the analysis context, and stamp
the traversal structure with the same value. A reader SHALL establish the structure's currency by
comparing that field to the structure's stamp, and SHALL NOT digest the analysis artifact to do
so.

A writer that changes the call graph SHALL recompute the digest in the same write. This invariant
is what makes the narrower key sound, so it SHALL be enforced by a test that fails when a write
path assigns the call graph without recomputing it, not left to reviewer attention.

A context that carries no such digest SHALL yield no key, so no persisted structure is consulted
and the traversal is built in memory.

#### Scenario: An edit that cannot change the structure does not invalidate it

- **GIVEN** a persisted traversal structure and an incremental flush that rewrites the analysis
  context without changing the call graph
- **WHEN** a traversal handler next runs from a cold read
- **THEN** the structure is still accepted and served, because the key it is compared against
  describes the graph rather than the bytes of the artifact the graph travels in

#### Scenario: An edit that does change the graph invalidates it

- **GIVEN** a persisted traversal structure and a re-analysis that changes any node id, any
  edge endpoint, any edge's synthesized-ness, or the order of the edges
- **WHEN** a traversal handler next runs
- **THEN** the digests disagree, the structure is refused, and the traversal is built from the
  graph being served

#### Scenario: Establishing currency costs nothing on the read path

- **GIVEN** a cold read of the analysis context
- **WHEN** the reader establishes which graph the persisted structure belongs to
- **THEN** it reads the digest from the already-parsed context and performs no hashing of its
  own, so a tool that never traverses pays nothing for the structure's existence

## MODIFIED Requirements

### Requirement: ReachabilityStructureIsComputedAtAnalyzeTime

Analyze SHALL compute an SCC condensation and topological order of the resolved call graph and
persist a compact integer-indexed forward/backward adjacency representation, carrying per-edge
kind/confidence so existing edge filters remain expressible. The structure SHALL be written under
the same atomic-write and analysis-lock discipline as the sibling artifacts, and SHALL be stamped
with the graph digest defined by TraversalStructureIsKeyedToTheGraphItDescribes — the same value
analyze writes into the `llm-context.json` it accompanies — so it can never be served over a graph
it was not built from.

Because forward and backward adjacency are not transposes of one another — an edge whose caller
is not itself a node of the graph contributes to backward adjacency only — a condensation SHALL
be computed per direction, over exactly the adjacency that direction traverses.

The order in which analyze writes the structure relative to the context it is stamped against
SHALL NOT be constrained: currency is established by comparing the graph digest carried in the
context to the structure's stamp, not by comparing modification times, so the structure MAY be
written concurrently with the other artifacts.

The watcher's incremental flush SHALL NOT rebuild the structure, because that lane never changes
the call graph: rebuilding it would produce a bit-identical structure while holding the analysis
lock, at a cost that grows with the graph. Because the structure is keyed to the graph rather than
to the context bytes, a flush that leaves the call graph unchanged leaves the structure valid, and
a later read serves it rather than rebuilding it in memory.

#### Scenario: The structure is stamped with the graph digest the context carries

- **GIVEN** a completed analyze
- **WHEN** the structure is persisted
- **THEN** it is stamped with the same graph digest analyze wrote into `llm-context.json`, so a
  reader establishes currency from the parsed context without digesting the artifact

#### Scenario: Edge filters survive the representation change

- **GIVEN** a traversal that today excludes `synthesized` edges
- **WHEN** it runs over the precomputed structure
- **THEN** the excluded edges are skipped via the per-edge mask and the result equals the
  filtered per-call BFS answer — including the edges the per-call builder drops because the
  filter also removed the callee that would have made their caller addressable
