# analyzer spec delta

## ADDED Requirements

### Requirement: PrecisionOrderConsistencyInvariant

The system SHALL provide an offline, ground-truth-free invariant checker over the call-graph
resolution ladder, built by driving the existing builder with one resolution mechanism disabled and
comparing the result to the full build. The ladder SHALL be monotone: (1) for a refining mechanism
(type inference, re-export resolution), every call site the conservative (mechanism-off) build
resolves to an internal target SHALL still be resolved internally by the full build — the full
build SHALL NOT drop a resolution the conservative one made, nor re-target it to an
unresolved/external leaf; (2) for the over-approximating CHA mechanism, enabling it SHALL only add
`overrides` edges and SHALL leave every non-`overrides` edge unchanged. Any violation SHALL be
emitted as the registered governance finding `callgraph-precision-order-violation` (advisory by
default), naming the edge, its confidence class, and a caller-supplied repository label. The check
SHALL be deterministic, local, require no ground truth, and SHALL NOT run in any serving path. It is
an exported function exercised by its own test suite; no CI job or command runs it over a
repository.

#### Scenario: A dropped resolution is detected

- **GIVEN** a call site the conservative (mechanism-off) build resolves to an internal target
- **WHEN** the full build leaves that same site unresolved (external) or absent
- **THEN** the checker emits `callgraph-precision-order-violation` identifying the edge and its
  confidence class

#### Scenario: A refinement is not a violation

- **GIVEN** a call site the conservative build resolves at a lower-confidence tier
- **WHEN** the full build resolves the same site to an internal target at any tier
- **THEN** no finding is emitted — refining or adding a resolution is allowed; only dropping one
  is not

#### Scenario: CHA stays additive

- **GIVEN** a build with CHA enabled and the same build with CHA disabled
- **WHEN** the checker compares them
- **THEN** every non-`overrides` edge matches, enabling CHA having only added `overrides` edges,
  and no finding is emitted
