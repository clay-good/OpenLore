# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SharedStateConclusionsAreASoundLowerBoundNotARaceVerdict

The system SHALL provide a shared-state conclusion that reports, per module-level mutable binding,
the line-precise sites that read and write it, the enclosing functions, the upstream callers that
reach a writer, and the reaching tests — computed deterministically from the persisted control-flow
and definition-use overlay and the cached call graph, with no runtime instrumentation and no LLM.
It SHALL additionally report, as a structural shape with its evidence lines, an update to a shared
binding that is separated by a suspension point within one function. The conclusion SHALL be a
sound lower bound: writes through aliases, dynamic or reflective assignment, unresolved receivers,
unanalyzable callees, and any truncation SHALL be disclosed as boundaries, and the system SHALL
NOT state or imply that a binding is unshared, race-free, or safe. The system SHALL NOT infer
locksets, alias sets, happens-before ordering, deadlock, or lock ordering. Languages without the
required overlay support SHALL receive an explicit unsupported result rather than an empty one.

#### Scenario: The census names every visible reader and writer

- **GIVEN** a module-level counter written by two functions and read by three
- **WHEN** the shared-state conclusion is requested for that binding
- **THEN** all five sites are returned with file, line, enclosing function, and access direction
- **AND** the callers that transitively reach a writer are returned with the reaching tests

#### Scenario: A suspension-separated update is reported with evidence, not as a verdict

- **GIVEN** a function that reads a shared binding, awaits, then writes the same binding
- **WHEN** the conclusion is requested
- **THEN** the shape is reported with the read, suspension, and write lines
- **AND** it is not labeled a bug, scored, or emitted as a gating finding

#### Scenario: An invisible write is disclosed rather than implied absent

- **GIVEN** a shared binding mutated only through an alias the analysis cannot resolve
- **WHEN** the conclusion is requested for that binding
- **THEN** the writer set omits the alias write, the boundary is disclosed with its location where
  known, and the result is presented as a lower bound
- **AND** no statement that the binding is unshared or safe is returned

#### Scenario: An unsupported language is explicit

- **GIVEN** a symbol in a language without the required overlay support
- **WHEN** the conclusion is requested
- **THEN** an explicit unsupported result is returned rather than an empty hazard set
