# mcp-quality spec delta

## ADDED Requirements

### Requirement: StandingSurfaceCostIsMeasuredAndBudgeted

The standing context cost of each tool preset — the token cost of the exact served `tools/list`
result a client loads at session start, before any tool is called — SHALL be measured
deterministically and offline, with no model call and no network request. The measurement SHALL use
a stated, version-pinned tokenizer approximation, so that the same registry yields the same number.

Each preset SHALL declare a standing-cost budget in the same source-declared form as the preset
itself. Continuous integration SHALL fail when a preset's measured standing cost exceeds its
declared budget. Raising a budget SHALL be an explicit, reviewed edit accompanied by its
justification; the budget SHALL NOT be raised as an incidental consequence of the change that
exceeded it.

The measured standing cost of each preset SHALL be published, and a documentation guard SHALL fail
when a published figure does not equal the measured one. A published standing-cost figure SHALL NOT
be an estimate stated as a measurement.

#### Scenario: A description edit that inflates the surface fails the build

- **GIVEN** a preset at or near its declared standing-cost budget
- **WHEN** a tool description or input schema is enlarged so the preset exceeds that budget
- **THEN** continuous integration fails
- **AND** the failure names the preset, its measured cost, and its budget

#### Scenario: The measurement is a property of the registry

- **GIVEN** an unchanged tool registry
- **WHEN** the standing cost is measured repeatedly
- **THEN** the same number is produced each time, with no network access

#### Scenario: Raising a budget is deliberate

- **GIVEN** a change that raises a preset's declared budget
- **WHEN** it is reviewed
- **THEN** the justification for the new budget is present in the same change
- **AND** the budget was not adjusted merely to accommodate the code that exceeded it

#### Scenario: The published figure matches the measured one

- **GIVEN** documentation stating a preset's standing context cost
- **WHEN** the documentation guard runs
- **THEN** the published figure equals the measured figure
- **AND** a stale published figure fails the guard

### Requirement: BothDeliveryFacesAreFirstClassAndReachTheSameConclusion

The command-line surface and the tool surface SHALL both be supported first-class delivery paths
for structural context, and the documentation SHALL state the trade-off between them: the tool
surface lets a model decide when to retrieve mid-conversation at a standing context cost, and the
command-line surface costs nothing until it is invoked. Neither SHALL be documented as deprecated
in favour of the other.

For every conclusion capability exposed on both faces, their common input projection SHALL yield
the same successful semantic conclusion before transport serialization, including its disclosed
boundaries, semantic truncation receipts, and staleness signals. The two faces SHALL use one
dispatch implementation, not two implementations that agree by convention. Protocol-specific
error envelopes and MCP's transport byte cap are not semantic conclusions and MAY differ. A guard
SHALL enumerate paired and face-only capabilities, declare face-only input controls, and fail when
the shared dispatch inputs or semantic conclusion diverge.

#### Scenario: The two faces agree

- **GIVEN** a conclusion capability available on both the command-line and the tool surface
- **WHEN** the same common inputs produce a successful result on each
- **THEN** the pre-transport conclusions are identical, including semantic boundaries and staleness signals

#### Scenario: An unpaired capability is declared, not silent

- **GIVEN** a registered conclusion capability present on one face and absent from the other
- **WHEN** the parity guard runs
- **THEN** the build fails unless the asymmetry is declared with its reason

#### Scenario: The zero-standing-cost path is documented as a choice

- **GIVEN** a user deciding how to ground an agent
- **WHEN** they read the delivery documentation
- **THEN** it states when the command-line path is preferable and when the tool surface is
- **AND** neither is presented as superseding the other
