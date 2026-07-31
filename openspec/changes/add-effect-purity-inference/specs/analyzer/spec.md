# analyzer spec delta

## ADDED Requirements

### Requirement: EffectFactsAreCompositionalAndSound

The analyzer SHALL compute a per-function effect fact from a closed vocabulary (`pure`,
`mutates-params`, `module-state`, `io`, `unknown`) — direct effects extracted syntactically in
the existing walk (non-local assignment, parameter writes, a closed I/O call-pattern table)
and closed transitively over resolved call edges by join. Any unresolved, external, or
dynamic-boundary callee SHALL join as `unknown`: `pure` is a proven claim over fully-resolved
subtrees only, never an assumption across an edge the graph cannot see. Languages outside the
supported set SHALL carry no effect fact — never a guess.

#### Scenario: Effects compose through the call chain

- **GIVEN** `a` calls `b`, `b` writes a module-level binding, and all edges are resolved
- **WHEN** the closure runs
- **THEN** `b` is `module-state` directly and `a` is `module-state` transitively, with the
  introducing path recoverable

#### Scenario: An unseen edge blocks purity

- **GIVEN** a function with no direct effects whose only callee is external
- **WHEN** the closure runs
- **THEN** its effect is `unknown` with the external callee as the blocking boundary — not
  `pure`
