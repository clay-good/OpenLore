# mcp-handlers spec delta

## ADDED Requirements

### Requirement: TaskScopedOrientationIsAmortizedNotDuplicated

Task-scoped context injection SHALL produce its orientation by reusing the existing orient handler in
its lean form (Spec 27), not by introducing a second orientation code path. The injected orientation
for a task SHALL be the same conclusion the agent would obtain by calling `orient` for that task,
presented in a bounded, injection-shaped form. The orientation algorithm, ranking, and result schema
SHALL be unchanged; injection is a presentation-and-gating wrapper over existing output.

#### Scenario: Injected orientation matches the orient conclusion

- **GIVEN** a task and an analyzed repository
- **WHEN** task-scoped injection produces its block and `orient --lean` is called for the same task
- **THEN** the injected block carries the same relevant functions, call neighbours, and insertion
  points as the lean orient result, bounded by the injection token budget

### Requirement: InjectedContextIsInformationalNotCoercive

An injected orientation block SHALL be framed as information the agent may act on or ignore, never as
an instruction. It SHALL open with an explicit informational/ignorable statement, the same facts-not-
coercion posture applied across OpenLore (decision `8e95746d`). Injection SHALL be deterministic and
SHALL NOT invoke an LLM.

#### Scenario: The injected block does not command the agent

- **GIVEN** a task-scoped injection block emitted for a task
- **WHEN** the block is read
- **THEN** it presents structural facts under an explicit "informational; you decide whether to act on
  it" framing and contains no directive to take a specific action
