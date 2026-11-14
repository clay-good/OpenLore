# analyzer spec delta

## ADDED Requirements

### Requirement: EffectFactsAreCompositionalAndSound

The analyzer SHALL compute a per-function effect fact from a closed vocabulary (`pure`,
`mutates-params`, `module-state`, `io`, `unknown`), with direct effects taken from the existing
walk and closed over resolved call edges by join. Any unresolved, external or dynamic callee SHALL
join as `unknown`, so `pure` is claimed only over fully resolved subtrees. A `module-state` fact
SHALL name each binding with file and line. Unsupported languages SHALL carry no effect fact.

#### Scenario: Effects compose through the call chain

- **WHEN** `a` calls `b`, `b` writes a module-level binding, and all edges are resolved
- **THEN** `b` is `module-state` directly and `a` is `module-state` transitively, with the binding and the path recoverable

#### Scenario: An unseen edge blocks purity

- **WHEN** a function has no direct effect and its only callee is external
- **THEN** its effect is `unknown` with the external callee named, not `pure`
