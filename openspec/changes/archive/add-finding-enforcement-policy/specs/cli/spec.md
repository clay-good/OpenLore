# cli spec delta

## ADDED Requirements

### Requirement: GateConsultsTheUnifiedEnforcementPolicy

The pre-commit / pre-merge gate SHALL collect governance findings from all installed sources (the
decisions gate, the blast-radius guard, the change impact certificate, and the stale-decision-reference
check), resolve each finding's enforcement class through the single declared `enforcement.policy` using
the deterministic resolver, and fail the gate only when at least one finding resolves to the `blocking`
class. Findings SHALL be sorted by a stable key so identical inputs produce identical, reproducible
output. The gate SHALL add no LLM latency for this resolution — it is a pure policy pass.

#### Scenario: A blocking-classed finding fails the gate

- **GIVEN** a repository whose `enforcement.policy` maps `stale-decision-reference` to `blocking`, and a
  staged change introducing a live artifact that references a superseded decision
- **WHEN** the gate runs
- **THEN** the gate fails, citing the `stale-decision-reference` finding, and reports it as `blocking`

#### Scenario: The same finding stays advisory by default

- **GIVEN** the same staged change but a repository with no `enforcement.policy`
- **WHEN** the gate runs
- **THEN** the gate does not fail, and the `stale-decision-reference` finding is reported as advisory

### Requirement: SilencedFindingsRemainVisible

A finding whose resolved enforcement class is `off` SHALL NOT fail the gate, and SHALL still be listed in
the gate's output as informational, so that a deliberately silenced finding is visible to a reviewer and a
silence is never invisible. The gate output SHALL distinguish `blocking`, `advisory`, and `off` findings.

#### Scenario: An off-classed finding is shown but does not block

- **GIVEN** a repository whose `enforcement.policy` maps a finding code to `off`, and a change that
  produces that finding
- **WHEN** the gate runs
- **THEN** the gate does not fail, and the finding appears in the output marked as silenced (`off`),
  distinct from advisory findings
