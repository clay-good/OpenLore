# mcp-quality spec delta

## ADDED Requirements

### Requirement: CapabilityFamilyTaxonomy

The server SHALL classify every tool into exactly one of a small, closed set of **capability families**,
and SHALL present the full tool surface grouped by family rather than as a flat list. The family set is
fixed and source-declared:

- `navigate` — read the structural graph, return a conclusion (orient, find_path, analyze_impact,
  get_subgraph, select_tests, find_dead_code, get_map, …).
- `change` — reason about a specific diff or change set (structural_diff, blast_radius,
  change_impact_certificate, change_footprint, certify_public_surface, briefing_since).
- `remember` — record and recall durable, code-anchored facts (remember, recall, record_decision and
  its lifecycle).
- `verify` — settle a claim or a decision's currency against the graph before it reaches a human
  (verify_claim).
- `coordinate` — schedule or deconflict parallel work (plan_parallel_work, map_in_flight_conflicts).
- `federate` — cross-repo / spec-store conclusions (federation_status, spec_store_status,
  working_set_context).

Each tool SHALL declare its family in source, the way each tool already declares its
`conclusion`/`explicit-topology` class. The family set is closed: a new tool SHALL join an existing
family, or the change SHALL justify and add a new family. The full surface — when enabled — SHALL be
discoverable by family so that an agent selects among a handful of families and a handful of tools per
family, never among the full undifferentiated registry.

#### Scenario: Every tool declares a valid family

- **GIVEN** the tool registry
- **WHEN** the tool-contract check runs
- **THEN** every tool declares exactly one family from the closed set
- **AND** a tool missing a family declaration fails the check

#### Scenario: The full surface is presented grouped by family

- **GIVEN** the full tool surface is enabled
- **WHEN** an agent inspects the available tools
- **THEN** the tools are grouped by capability family
- **AND** an agent selecting a tool chooses among ~6 families and the tools within one, not among the
  flat registry of all tools

### Requirement: NoRedundantConclusions

Two tools in the same capability family that could be read as answering the same question SHALL each
state its **distinct question** in one sentence within its own description and cross-reference its
near-siblings, OR be consolidated into one tool. Adjacency SHALL be resolved either by disambiguation
or by elimination; it SHALL NOT be left implicit. This requirement SHALL NOT be satisfied by merging
tools that return genuinely distinct conclusions — a tool whose answer is separately useful SHALL be
kept and disambiguated, not removed.

#### Scenario: Adjacent tools disambiguate themselves

- **GIVEN** two tools in the same family with adjacent purposes (e.g. a whole-repo audit and a scoped
  one-vs-all query over the same detector)
- **WHEN** their descriptions are read
- **THEN** each states the distinct question it answers in one sentence and names its near-sibling
- **AND** an agent can tell from the descriptions alone which one fits the task at hand

#### Scenario: A genuine duplicate is consolidated, a distinct conclusion is kept

- **GIVEN** a proposed tool whose conclusion is identical to an existing tool's
- **WHEN** the surface is reviewed
- **THEN** the duplicate is consolidated rather than added
- **AND** a tool that returns a separately-useful conclusion is retained with a distinct-question
  sentence rather than force-merged

## MODIFIED Requirements

## MODIFIED Requirements

### Requirement: Tool Surface Size and Progressive Disclosure

The server SHALL minimize the number of tools an agent must consider at once. The **default**
MCP surface (no preset selected) SHALL be a small, high-value subset and SHALL NOT be the full
`TOOL_DEFINITIONS` registry. Breadth (the full surface and every governance/memory/verify/federation
capability) SHALL remain available strictly by opt-in: a named preset, or the explicit full-surface
selector (`--preset full` / `--all-tools`). The server SHALL document which set is appropriate for
which use case.

The server SHALL define a **`substrate` surface** that spans both faces of the substrate (per the
`architecture` `UnifiedStructuralSubstrate` requirement): the `navigation` graph-traversal core plus
the highest-value governance *reads* — `recall`, `verify_claim`, and `blast_radius` — so that an
out-of-box agent receives the value of the whole substrate (navigate, recall what is known, verify a
claim, weigh a diff) and not navigation alone. The `substrate` surface SHALL remain small and SHALL
hold governance *reads* only, never write or gate tools.

The choice of the **active out-of-box default** SHALL be evidence-backed. Per decision `c79ec7ca`
(ADR-0023, superseding ADR-0022), the benchmark showed the wider default does not regress selection
accuracy or token economy, and the active default is the `substrate` preset; `navigation` remains the
selectable lean navigate-only escape. The active default surface SHALL stay roughly constant in size
as the full registry grows; growth of the *default* surface — not the full registry — is what this
requirement constrains.

A new tool SHALL default to opt-in: it joins `TOOL_PRESETS` only where it earns a clear trigger and
declares its capability family, and SHALL NOT enter the active default surface without an explicit,
evidence-backed justification.

#### Scenario: A new tool does not inflate the lean default
- **GIVEN** a newly added tool that is not essential to a first-time user's first task
- **WHEN** it is registered
- **THEN** it is placed in an opt-in preset and is absent from the active default surface unless an evidence-backed decision adds it
- **AND** the size of the active default surface is unchanged by its addition

#### Scenario: Lean default is the out-of-box surface
- **GIVEN** a new user who installs the server the documented way (`openlore install`, or a bare `openlore mcp`)
- **WHEN** the active tool surface is resolved
- **THEN** they get the lean, high-signal `substrate` surface (the navigation core plus the governance reads), not the full registry
- **AND** the docs explain how to expand to the full set (`--preset full` / `--all-tools`) and why they would

#### Scenario: The default surface spans both faces
- **GIVEN** the `substrate` surface (navigation core + recall + verify_claim + blast_radius)
- **WHEN** an out-of-box agent begins a task
- **THEN** it can navigate, recall anchored knowledge, verify a claim, and weigh a diff without widening its preset
- **AND** no write or gate tool is part of that default surface

#### Scenario: Full surface does not dilute discovery
- **GIVEN** the full tool set is enabled
- **WHEN** an agent searches for the tool matching a task
- **THEN** tools are grouped by capability family and adjacent tools state their distinct questions, so the agent's selection accuracy does not degrade
