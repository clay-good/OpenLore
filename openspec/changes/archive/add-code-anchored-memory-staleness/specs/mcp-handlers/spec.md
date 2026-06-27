# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AnchoredMemoryWriteAndRecall

The system SHALL provide a `remember` tool that persists a durable, code-anchored memory and a
`recall` tool that returns relevant memories for a task. `remember` SHALL accept memory `content`,
optional explicit `anchors` (symbol references), and an optional `kind` (`note` by default;
`decision` flows through the existing decision consolidation and sync pipeline unchanged). On write,
the system SHALL resolve a structural anchor for the memory deterministically (per the analyzer
`StructuralMemoryAnchor` requirement).

`recall` SHALL select relevant memories using the existing deterministic retrieval used by `orient`
and SHALL return, for each, the memory `content`, its freshness verdict, and its anchor — a
conclusion-shaped response. Neither tool SHALL return a node-and-edge graph for the agent to
traverse, and both SHALL be registered only in an opt-in `memory` preset — never in the minimal or
first-run default tool surface.

#### Scenario: A note is persisted with a resolved anchor

- **GIVEN** a `remember` call with content and an anchor naming an existing function
- **WHEN** the memory is persisted
- **THEN** the stored memory carries a symbol-level structural anchor for that function

#### Scenario: Recall returns memories with a freshness verdict

- **GIVEN** persisted memories relevant to a task
- **WHEN** `recall` is invoked for that task
- **THEN** each returned memory includes its `content`, freshness verdict, and anchor, and the
  response contains no raw graph dump

#### Scenario: Memory tools are opt-in

- **GIVEN** `openlore mcp` started with no flag (or `--minimal`)
- **WHEN** the active tool set is selected
- **THEN** `remember` and `recall` are not registered; they appear only under the `memory` preset

### Requirement: NoSilentStaleMemory

The system SHALL NOT present an `orphaned` memory as authoritative context in any recall path,
including `recall` and `orient`. Every memory surfaced by `orient` (`orient.ts:388-447`) and `recall`
SHALL carry a freshness verdict. An `orphaned` memory SHALL be withheld from the authoritative
context section — listed separately as "needs re-anchoring" or shown with an explicit unverifiable
label — and a `drifted` memory SHALL carry a `verify` flag. This is the guarantee that makes recalled
context bullet-proof: a stale memory is structurally impossible to serve silently as fact.

#### Scenario: Orphaned memory is never authoritative

- **GIVEN** a memory whose anchor is `orphaned`
- **WHEN** `orient` or `recall` produces its response
- **THEN** the memory does not appear in the authoritative context section unlabeled; it is either
  withheld to a separate "needs re-anchoring" list or shown with an explicit unverifiable label

#### Scenario: Drifted memory is surfaced with a verify flag

- **GIVEN** a memory whose anchor is `drifted`
- **WHEN** `orient` or `recall` surfaces it
- **THEN** it carries a `verify` flag indicating the described code changed since the memory was recorded

#### Scenario: Every surfaced memory carries a verdict

- **GIVEN** any memory returned by `orient` or `recall`
- **WHEN** the response is produced
- **THEN** the memory carries a freshness verdict (`fresh`, `drifted`, or `orphaned`)
