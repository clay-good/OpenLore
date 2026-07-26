# analyzer spec delta

## ADDED Requirements

### Requirement: ReachabilityStructureIsComputedAtAnalyzeTime

Analyze SHALL compute an SCC condensation and topological order of the resolved call graph and
persist a compact integer-indexed forward/backward adjacency representation, carrying per-edge
kind/confidence so existing edge filters remain expressible. The structure SHALL be written under
the same atomic-write and analysis-lock discipline as the sibling artifacts, and SHALL be stamped
with a content digest of the `llm-context.json` it accompanies so it can never be served over a
graph it was not built from.

Because forward and backward adjacency are not transposes of one another — an edge whose caller
is not itself a node of the graph contributes to backward adjacency only — a condensation SHALL
be computed per direction, over exactly the adjacency that direction traverses.

Analyze SHALL write the structure strictly after the artifact it is stamped against, not
concurrently with it, so the structure's modification time can never precede the context's. That
ordering is what lets a reader rule out a superseded structure with a stat instead of digesting a
multi-MB artifact; written concurrently the comparison would be meaningless, so the ordering is a
requirement rather than an incidental detail.

The watcher's incremental flush SHALL NOT rebuild the structure, because that lane never changes
the call graph: rebuilding it would produce a bit-identical structure while holding the analysis
lock, at a cost that grows with the graph. A flush therefore leaves the persisted structure
stamped for superseded context bytes, and a later read builds in memory until the next full
analyze — a slower answer, never a stale one.

#### Scenario: A superseded structure is ruled out without reading it

- **GIVEN** a persisted structure and an incremental flush that has rewritten the analysis
  context since it was written
- **WHEN** a reader considers using it
- **THEN** the modification times alone establish that it is superseded, so neither the context
  digest nor the structure itself is read — the cost of rejecting it does not scale with the
  size of the artifacts

#### Scenario: The structure tracks the graph, never leads or trails it

- **GIVEN** a persisted structure and a graph being served
- **WHEN** a traversal handler asks for the structure
- **THEN** it is used only if its digest matches the exact artifact bytes that graph was parsed
  from, so a reader can never observe a structure/graph pair from different generations

#### Scenario: Edge filters survive the representation change

- **GIVEN** a traversal that today excludes `synthesized` edges
- **WHEN** it runs over the precomputed structure
- **THEN** the excluded edges are skipped via the per-edge mask and the result equals the
  filtered per-call BFS answer — including the edges the per-call builder drops because the
  filter also removed the callee that would have made their caller addressable

#### Scenario: An unusable persisted structure degrades to a rebuild, never to a wrong answer

- **GIVEN** a persisted structure that is absent, oversized, truncated, altered in its own bytes,
  carrying an index outside the bounds of the array it addresses, written by another schema
  version, byte-ordered for another host, or stamped for another generation
- **WHEN** a traversal handler asks for the structure
- **THEN** it is refused and the structure is rebuilt in memory from the served graph, so the
  answer is unchanged and only its cost differs
