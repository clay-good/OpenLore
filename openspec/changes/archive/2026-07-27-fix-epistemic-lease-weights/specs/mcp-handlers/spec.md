# mcp-handlers spec delta

## ADDED Requirements

### Requirement: LeaseWeightTableIsComplete

The epistemic lease's cognitive-load weight table (`TOOL_WEIGHTS`) SHALL cover every tool
registered in `TOOL_DEFINITIONS`, and SHALL contain no entry for a tool that is no longer
registered. Completeness SHALL be enforced by a CI test cross-checking the table against the live
registry in both directions — the same closed-table discipline applied to `TOOL_OUTPUT_CLASS` and
`TOOL_CAPABILITY_FAMILY` — so a newly added tool without a declared weight fails CI rather than
silently falling to the minimum-weight fallback. A new tool's weight SHALL be assigned by analogy
to its nearest existing entry in the same traversal-depth class (lightweight read, structural
read, graph traversal, deep architectural trace), never as a newly invented constant; tools
documented as near-twins (e.g. `find_path` and `trace_execution_path`) SHALL carry the same
weight. The runtime fallback for an unknown name MAY remain as defense in depth, but SHALL never
be the mechanism by which a registered tool is scored.

#### Scenario: A new tool without a weight fails CI

- **GIVEN** a change that registers a new tool in `TOOL_DEFINITIONS` without adding a
  `TOOL_WEIGHTS` entry
- **WHEN** the completeness test runs
- **THEN** it fails, naming the unweighted tool
- **AND** the failure is independent of whether the runtime fallback would have produced a value

#### Scenario: A stale weight entry fails CI

- **GIVEN** a tool removed from (or renamed in) `TOOL_DEFINITIONS` whose old name remains in
  `TOOL_WEIGHTS`
- **WHEN** the completeness test runs
- **THEN** it fails, naming the stale entry

#### Scenario: Near-twin tools accrue equal load

- **GIVEN** two tools documented as answering the same class of question at the same traversal
  depth (e.g. `find_path` and `trace_execution_path`)
- **WHEN** each is invoked once in a session
- **THEN** each contributes the same weight to the session's cognitive load

#### Scenario: Load accounting reflects actual work on the default surface

- **GIVEN** a session invoking only default-surface tools, including graph traversals
  (`find_path`, `blast_radius`) and lightweight reads (`recall`)
- **WHEN** the lease accumulates cognitive load
- **THEN** the traversals contribute their declared structural/architectural weights, not the
  minimum fallback, so degrade/stale thresholds fire when the declared tier model says they should
