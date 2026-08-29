# mcp-quality spec delta

## ADDED Requirements

### Requirement: DefaultSurfaceDecisionsRideTheBenchmarkProtocol

Any change to the composition of the default MCP tool surface (the preset wired by a bare
`openlore mcp` / `openlore install`) SHALL be gated by the checked-in benchmark protocol: a
decision rule pre-registered before any measured run, evaluation on a distractor-aware task
corpus across both repo tiers and at least two models, and a results artifact checked in with the
change and cited by the governing ADR. Scoring SHALL be deterministic — independent oracles and
post-hoc trajectory metrics computed from logged runs — with no LLM-as-judge in any scoring path.
A default-surface change without a conforming benchmark run SHALL NOT be merged on assertion.

#### Scenario: A proposed default-surface widening must present a conforming run

- **GIVEN** a change proposing to add a tool to the default preset
- **WHEN** the change is reviewed
- **THEN** it carries a results artifact from the protocol (pre-registered rule, distractor-aware
  corpus, both tiers, two models) and the ADR cites that run

#### Scenario: The decision rule cannot be tuned after the results

- **GIVEN** a benchmark run whose results narrowly miss the pre-registered rule
- **WHEN** the outcome is evaluated
- **THEN** the verdict is HOLD under the pre-registered rule
- **AND** relaxing the rule requires a new pre-registration and a fresh run, stated in the change

#### Scenario: Selection accuracy is measured against distractors

- **GIVEN** a task whose corpus entry declares an expected tool and required distractor tools
- **WHEN** the selection benchmark runs against a surface missing a declared distractor
- **THEN** the run reports the absent distractor rather than silently scoring the task
