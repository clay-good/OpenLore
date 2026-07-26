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
