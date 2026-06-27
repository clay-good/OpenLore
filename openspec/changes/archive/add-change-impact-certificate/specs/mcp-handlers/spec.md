# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CoveringSurfaceDeclaration

The system SHALL support an optional, additive declaration of named **covering surfaces**, where a
surface is a set of symbols, files, or published interfaces representing a semantic or governance
boundary, with an optional severity. A surface SHALL be resolvable to a concrete symbol-ID set over the
(federated) graph; an unresolved surface member SHALL degrade to a finding rather than throwing. A
covering surface SHALL be a declared boundary, not a directory-ownership glob, and SHALL be the unit a
proposed change is assessed against.

#### Scenario: A surface resolves to a symbol set

- **GIVEN** a covering surface declared as a mix of one file and two symbols
- **WHEN** the surface is resolved over the graph
- **THEN** it resolves to the expected set of symbol IDs, and any member that does not resolve produces a
  finding rather than an error

### Requirement: NewlyOpenedPathDetection

The system SHALL, given a proposed change, compute reachability to each declared covering surface in the
pre-change graph and in the post-change graph — the latter derived by applying the change's diff to the
call graph — and SHALL report the paths into each surface that exist only in the
post-change graph.

> Note (as-shipped): the post-change graph is derived by a bounded **differential edge-delta over the
> changed files** (re-parse changed files at base vs working tree; post = canonical + added − removed,
> pre = canonical − added + removed), NOT the incremental dependency graph
> (`add-watch-incremental-dependency-graph`), which is still unbuilt — see the proposal header deviation
> and the merged `mcp-handlers` spec. A new call edge can only originate from a changed file, so this
> detects every newly-opened path without a full rebuild and without that dependency. These newly-opened paths SHALL be reported distinctly from the surface's existing
callers. For each newly-opened path the system SHALL name the shortest opening path. The computation
SHALL be deterministic, with no LLM.

#### Scenario: A change opens a new transitive path into a surface

- **GIVEN** a covering surface and a proposed change whose diff adds an edge creating a two-hop path into
  that surface where none existed before
- **WHEN** newly-opened-path detection runs
- **THEN** it reports exactly that newly-opened path into the surface, naming the shortest opening path,
  and does not report it as a pre-existing caller

#### Scenario: A change touching only existing callers opens nothing

- **GIVEN** a covering surface and a proposed change that modifies only code already able to reach the
  surface
- **WHEN** newly-opened-path detection runs
- **THEN** it reports no newly-opened paths into that surface

### Requirement: ChangeImpactCertificate

The system SHALL emit, for a proposed change, a single deterministic, conclusion-shaped impact
certificate composed of: the change's blast radius (callers and layers), the newly-opened paths into
each declared covering surface, the specs the change drifts, and the tests to run. The certificate SHALL
compose existing deterministic analyses only, with no LLM, and SHALL be a briefing — counts, named
surfaces, named paths — never a raw graph. Each finding SHALL carry a stable code, and surface findings
SHALL carry the surface name and severity.

#### Scenario: A cross-boundary change is certified

- **GIVEN** a proposed change that opens a new path into a declared surface and drifts two specs
- **WHEN** the impact certificate is requested
- **THEN** it returns one conclusion-shaped certificate naming the newly-opened path and its surface, the
  two drifted specs, the affected callers and layers, and the tests to run

### Requirement: ImpactCertificateDecaysWithLease

The impact certificate SHALL be anchored to the change and its touched symbols via the existing
code-anchored freshness lease, and SHALL be marked stale when the change grows or an anchored symbol
moves. An expired certificate SHALL be treated as unverified and SHALL NOT be presented as silently
still-true. The spec-store health check SHALL surface a stale certificate as a finding so it can be
re-fired against current state.

#### Scenario: Editing an anchored symbol expires the certificate

- **GIVEN** a fresh impact certificate anchored to a set of symbols
- **WHEN** one of those symbols is subsequently modified
- **THEN** the certificate is marked stale, the health check surfaces it as a finding to re-fire, and the
  stale certificate is not reported as current
