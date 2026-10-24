# analyzer spec delta

## ADDED Requirements

### Requirement: PrecisionOrderConsistencyInvariant

The system SHALL provide an offline (CI/dogfood), ground-truth-free invariant checker over the
call-graph resolution ladder, built by driving the existing builder with one resolution mechanism
disabled and comparing the result to the full build. The ladder SHALL be monotone: (1) for a
refining mechanism (type inference, re-export resolution), every call site the conservative
(mechanism-off) build resolves to an internal target SHALL still be resolved internally by the full
build — the full build SHALL NOT drop a resolution the conservative one made, nor re-target it to
an unresolved/external leaf; (2) for the over-approximating CHA mechanism, enabling it SHALL only
add `overrides` edges and SHALL leave every non-`overrides` edge unchanged. Any violation SHALL be
emitted as the registered governance finding `callgraph-precision-order-violation` (advisory by
default, blocking only via `enforcement.policy`), naming the edge, its confidence class, and the
repo. The check SHALL be deterministic, local, require no ground truth, and SHALL NOT run in any
serving path.

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

#### Scenario: A clean ladder passes silently

- **GIVEN** builds whose configurations satisfy the monotone invariant
- **WHEN** the checker runs in CI
- **THEN** no finding is emitted and the job passes

### Requirement: ExecutionWitnessedRecallCalibration

The system SHALL maintain a dev-only calibration harness that measures call-edge recall per
edge-confidence class against an execution-witnessed public benchmark, and SHALL publish the
measured numbers in a committed document recording the benchmark commit hash. Wherever a
calibrated recall number is cited, the system SHALL state (1) the coverage boundary — only the
benchmark's Python and JavaScript suites apply; no TypeScript suite exists — and (2) that an
execution-covered graph is a recall floor, not a soundness proof. The harness and benchmark data
SHALL NOT ship in the published package, and recall SHALL NOT be extrapolated to unmeasured tiers
or languages.

#### Scenario: Recall is measured, not asserted

- **GIVEN** the harness run against a pinned benchmark commit
- **WHEN** results are published
- **THEN** each measured edge-confidence class carries its recovered percentage of
  execution-witnessed edges, and the document names the benchmark commit hash

#### Scenario: The number never overstates itself

- **GIVEN** documentation citing a calibrated recall figure
- **WHEN** a reader encounters it
- **THEN** the partial language coverage and the recall-floor caveat appear alongside the number
