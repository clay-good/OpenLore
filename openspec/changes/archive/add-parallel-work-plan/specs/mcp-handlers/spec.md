# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ParallelWorkPlanTool

The system SHALL provide an opt-in MCP tool, `plan_parallel_work`, that accepts a directory and a
caller-supplied list of task descriptors and returns a computed plan for running the tasks
concurrently. The tool SHALL NOT invent, decompose, or expand the task list beyond each descriptor's
declared seeds; it consumes the footprint projection and the pairwise hazard classifier. The returned
plan SHALL contain, as the computed answer rather than a graph to traverse:

- each task's footprint (write-set, read-set, affected-set, coupling-neighbors);
- a conflict graph giving, for each task pair, the hazard verdict (WAW / shared-append / RAW / WAR /
  soft-coupling) with witnessing symbols and, for RAW, the direction;
- a wave schedule: an ordered list of waves in which each wave is a maximal set of tasks with no WAW
  conflict among them and all RAW predecessors placed in earlier waves (shared-append, WAR, and
  soft-coupling do not split a wave and ride along as advisories); and
- a critical path: the longest RAW-ordered chain, expressed as the minimum number of sequential rounds
  achievable even with unlimited agents.

The tool SHALL be classified as a conclusion tool in the tool contract. It SHALL land in an opt-in
preset and SHALL NOT be a member of the minimal tool set or the lean first-run default. Every plan
SHALL carry a known-unknowable disclosure that footprints are predicted, that the plan reduces but
does not eliminate conflict probability, and that integration tests remain the ground truth.

The schedule (waves and critical path) SHALL always be complete, while the supporting-evidence lists
(the conflict graph, advisories, governance findings, and per-task footprint regions) — which can grow
as the square of the task count — SHALL be bounded with authoritative uncapped counts so the response
stays within the MCP transport byte budget and is never silently truncated. Governance findings (WAW
conflicts and unorderable cycles) SHALL be emitted in the unified governable-finding shape so the
**calling agent or CI** can resolve them against its own `enforcement.policy`; the diff-based commit
gate does not run the planner and therefore does not block on them.

#### Scenario: A very large plan stays within the response budget without losing the schedule

- **GIVEN** a task list large enough that its pairwise conflict graph or footprint detail would exceed
  the MCP response byte budget
- **WHEN** `plan_parallel_work` is called with it
- **THEN** the full wave schedule and critical path are returned along with authoritative uncapped
  counts, the oversized supporting-evidence lists are capped (and per-task footprint sample lists may be
  collapsed to their counts) with an explicit truncation disclosure, and the serialized response stays
  within the transport budget

#### Scenario: Disjoint tasks plan into a single wave

- **GIVEN** three task descriptors whose footprints pairwise classify as `none`
- **WHEN** `plan_parallel_work` is called with them
- **THEN** the plan places all three in wave 1 and reports a critical path of one round

#### Scenario: A write-write conflict splits tasks across waves

- **GIVEN** two task descriptors whose write-sets intersect (WAW)
- **WHEN** `plan_parallel_work` is called with them
- **THEN** the plan places them in different waves and the conflict graph records the WAW verdict with
  the shared symbol as witness

#### Scenario: Concurrent appends to a registration site stay in one wave

- **GIVEN** two task descriptors whose only write-set overlap is a registration symbol (such as a
  dispatcher or a tool-registry array) that both declare with `writeMode: append`
- **WHEN** `plan_parallel_work` is called with them
- **THEN** the plan keeps them in the same wave, classifies the pair as shared-append, and emits an
  advisory rather than serializing them across waves

#### Scenario: A read-after-write dependency orders the waves

- **GIVEN** task A whose write-set contains a symbol in task B's read-set (RAW, B after A), with no
  WAW between them
- **WHEN** `plan_parallel_work` is called with them
- **THEN** B is scheduled in a wave after A's, and the critical path length reflects the A→B chain

#### Scenario: Same-file disjoint symbols stay parallel

- **GIVEN** two task descriptors that modify different symbols in the same file with no read/write
  overlap
- **WHEN** `plan_parallel_work` is called with them
- **THEN** both appear in wave 1 and the plan emits a low-risk (WAR) advisory rather than serializing
  them

#### Scenario: The plan is stateless and re-rendered, not held

- **GIVEN** a plan produced for a set of tasks
- **WHEN** the caller re-invokes `plan_parallel_work` with only the tasks that remain
- **THEN** a fresh plan is computed deterministically from the inputs, with no lease, no task
  assignment, and no memory of the previous call

#### Scenario: The plan is advisory by default

- **GIVEN** a plan that contains a WAW conflict within a proposed dispatch set
- **WHEN** no `enforcement.policy` opts the corresponding finding into blocking
- **THEN** the tool returns the plan and blocks nothing; gating occurs only when an operator opts the
  finding into a blocking class

#### Scenario: An unorderable read-after-write cycle is disclosed, never silently broken

- **GIVEN** three or more task descriptors whose footprints form a read-after-write cycle (each task
  reads a symbol the next one writes, closing back on the first)
- **WHEN** `plan_parallel_work` is called with them
- **THEN** the plan emits a finding disclosing the unorderable cycle and its members, and places those
  members in mutually exclusive waves rather than asserting a wave order that violates one of the
  dependencies, so the schedule never claims a member runs before a task it depends on
