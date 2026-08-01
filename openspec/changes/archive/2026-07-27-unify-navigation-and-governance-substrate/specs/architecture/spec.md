# architecture spec delta

## ADDED Requirements

### Requirement: UnifiedStructuralSubstrate

OpenLore SHALL be one structural substrate with two faces, not two products. Its navigation
capabilities (reads that return conclusions about code structure) and its governance capabilities
(writes and checks that anchor facts to code and gate changes against it) SHALL be grounded in a single
shared spine:

1. **One graph.** A single deterministically-extracted structural graph — the call graph plus its IaC,
   cross-service HTTP, and type-hierarchy projections — SHALL be the sole source of structural truth.
   Every navigation conclusion and every governance check SHALL be computed from this one graph, not
   from a parallel graph maintained alongside it.
2. **One anchored-fact store.** Durable facts an agent records — code-anchored memories and recorded
   architectural decisions — SHALL share one anchoring model: each is bound to a symbol or file,
   self-invalidates when its anchor changes, and is carried across a rename or move by the same
   symbol-identity continuity mechanism. A new durable-fact type SHALL reuse this anchoring model
   rather than introduce a parallel store.
3. **One freshness lease.** A single deterministic freshness/decay mechanism SHALL govern the staleness
   of every anchored conclusion — a memory's freshness verdict, a decision citation's currency, and a
   change certificate's decay — anchored to the same touched symbols and computed by the same rule. A
   new capability that ages out SHALL decay via this lease rather than define its own staleness rule.

A new capability SHALL attach to this spine — reading the one graph, anchoring to the one fact store,
and decaying via the one lease — rather than constituting a separate product surface or a parallel
mechanism. This requirement does not constrain how tools are grouped or surfaced (see `mcp-quality`);
it constrains the underlying model so that navigation and governance remain faces of one substrate.

#### Scenario: A governance check reads the same graph as navigation

- **GIVEN** the indexed structural graph that navigation tools traverse
- **WHEN** a governance capability (claim verification, blast radius, a change certificate, the commit
  gate) computes its result
- **THEN** it derives that result from the same single graph, not from a separately-maintained one
- **AND** a change to the graph is reflected identically in both the navigation conclusion and the
  governance check

#### Scenario: A new durable-fact type reuses the shared spine

- **GIVEN** a proposed capability that records a new kind of durable, code-anchored fact
- **WHEN** it is designed
- **THEN** it anchors the fact to a symbol or file using the existing anchoring model, self-invalidates
  when the anchor changes, and ages via the existing freshness lease
- **AND** it does not introduce a parallel fact store or a second staleness rule

#### Scenario: The substrate is presented as one product

- **GIVEN** the navigation face and the governance face of the substrate
- **WHEN** the capabilities are documented or surfaced to an agent
- **THEN** they are presented as two faces of one substrate over a shared spine, not as two independent
  products
