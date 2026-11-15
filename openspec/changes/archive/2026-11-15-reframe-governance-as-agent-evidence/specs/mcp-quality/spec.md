## ADDED Requirements

### Requirement: MomentsAreQuietAndEveryFindingIsActionable

A hook moment SHALL emit no finding unless the finding is new (not yet stated in the same harness
session) and real (it carries proof: a file and line, a graph edge, or a receipt). Each emitted
finding SHALL state its proof and exactly one action: `fix`, `decide`, or `raise`. The rule SHALL
hold for every harness that runs the moments.

#### Scenario: Nothing new prints no finding

- **GIVEN** a session in which a finding was already stated
- **WHEN** a later moment computes the same finding and nothing else
- **THEN** the moment gives the agent no finding; the before-stop receipt for the user may list it once

#### Scenario: An emitted finding has proof and an action

- **GIVEN** an edit that adds a reference to a symbol that does not exist
- **WHEN** the after-edit moment reports it
- **THEN** the finding names the file and line and carries the action `fix`

#### Scenario: The three actions are defined

- **GIVEN** an emitted finding
- **WHEN** its action is read
- **THEN** `fix` means the agent repairs it, `decide` means the agent records a decision with a
  link to the proof, and `raise` means the agent tells a human in its final message or
  pull-request body

#### Scenario: A finding without proof is dropped

- **GIVEN** a check that returns a result with no file, edge, or receipt
- **WHEN** the moment builds its receipt
- **THEN** that result is not printed

### Requirement: PluginToolSetIsFixedAndSmall

The server SHALL define a `plugin` preset of at most 12 tools for the Claude Code plugin, and it
SHALL contain `orient`, `blast_radius`, `verify_change`, `verify_claim` and `recall`. Every `plugin`
tool SHALL also be in the `substrate` preset, and the `plugin` preset SHALL NOT contain a
spec-generation tool. The npm default SHALL stay the `substrate` preset; it SHALL keep its current
members and SHALL add `verify_change` once the benchmark protocol shows no regression. Every tool outside the `plugin`
preset SHALL stay registered under its current name and callable through the other presets, the
full surface, and Pi. A CI test SHALL guard the set.

#### Scenario: The plugin preset lists 11 tools

- **WHEN** `openlore mcp --preset plugin --list-tools` runs
- **THEN** it lists exactly `orient`, `search_code`, `get_subgraph`, `analyze_impact`, `find_path`,
  `get_function_skeleton`, `suggest_insertion_points`, `recall`, `verify_claim`, `blast_radius`
  and `verify_change`

#### Scenario: The npm default gains only verify_change

- **WHEN** `openlore mcp` starts with no preset
- **THEN** the active surface is the `substrate` preset: its 15 tools from before this change, plus
  `verify_change`

#### Scenario: The plugin set is a subset of the default

- **WHEN** the presets are compared
- **THEN** every tool in `plugin` is also in `substrate`
- **AND** `prepare_spec_generation` and `prepare_spec_repair` are not in `plugin`

#### Scenario: A hidden tool stays reachable

- **GIVEN** a server started with `--preset plugin`
- **WHEN** the client calls `certify_public_surface`
- **THEN** the tool error names a preset that contains the tool and the rewire command
- **AND** the same tool runs under `openlore mcp --preset full` and in Pi

### Requirement: CertificatesAreEvidenceSourcesBehindMoments

The before-stop moment SHALL be able to use `certify_public_surface`, `certify_service_contract`
and `change_impact_certificate` as evidence sources, each under its current name, each only when
its trigger holds, and each inside its own time limit and the moment's limits. A source that fails
or passes its limit SHALL add nothing and SHALL NOT be reported as a clean result. No source SHALL
run before an edit or after an edit.

#### Scenario: Each source has one trigger

- **GIVEN** the three evidence sources
- **WHEN** the before-stop moment decides what to run
- **THEN** `certify_public_surface` runs only when the session diff touches a TypeScript,
  JavaScript or Python file, `certify_service_contract` only when it touches a service-contract
  file, and `change_impact_certificate` only when a covering surface is declared in configuration

#### Scenario: A public-API break is stated before stop

- **GIVEN** a session diff that removes an exported TypeScript function with an indexed consumer
- **WHEN** the before-stop moment runs
- **THEN** the receipt carries the breaking finding, the consumer as proof, and an action

#### Scenario: No trigger means no cost

- **GIVEN** a session diff that touches only Markdown files and no declared surface
- **WHEN** the before-stop moment runs
- **THEN** none of the three sources runs

#### Scenario: A slow source is silent

- **GIVEN** a source that does not finish inside its time limit
- **WHEN** the before-stop moment builds its receipt
- **THEN** the receipt has no item from that source and does not claim the check passed
