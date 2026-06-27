# mcp-handlers spec delta

## ADDED Requirements

### Requirement: FederationScopedConclusions

`analyze_impact`, `find_path`, `find_dead_code`, and `select_tests` SHALL accept an optional federation
scope and, when given, compute their conclusion across the indexed repositories in scope. The response
SHALL remain conclusion-shaped (an impacted set, a path, a verdict, a test list) — never a cross-repo
graph dump — SHALL respect an optional token budget, and SHALL name which repositories were consulted
and which were skipped (unindexed/stale). Federation capability SHALL be registered only behind an
opt-in `federation` preset, never in the minimal or first-run default surface.

#### Scenario: Cross-repo impact names its coverage

- **GIVEN** a change to a symbol published from repo A and consumed by indexed repos B and C
- **WHEN** `analyze_impact` runs with a federation scope
- **THEN** the impacted set spans B and C, the response lists the repositories consulted, and no union
  graph is returned

#### Scenario: Federation is opt-in

- **GIVEN** `openlore mcp` started with no flag or `--minimal`
- **WHEN** the active tool set is selected
- **THEN** no federation capability is registered; it appears only under the `federation` preset

### Requirement: FleetLevelAnchoredMemory

> **⚠ DEFERRED — group 4, NOT implemented in this change. Do NOT merge into the live
> `openspec/specs/mcp-handlers/spec.md` at archive time.** It depends on bitemporal
> typed memory (`add-bitemporal-typed-memory-operations`, PR #163), which is not yet
> in `main`. It is recorded here only as the full-proposal intent. Archiving this
> requirement into the live spec would make `audit_spec_coverage` report a phantom
> unimplemented requirement. Re-home it into its own change once PR #163 lands; see
> `tasks.md` group 4.

A memory or decision SHALL be anchorable to a published interface via its cross-repo stable ID and
SHALL surface in consumer repositories when recall runs there, carrying its freshness verdict per the
authoritative-recall invariant. A fleet-level memory whose anchor symbol no longer exists in the
producer SHALL be treated as `orphaned` and withheld from authoritative context, identically to a
single-repo memory.

#### Scenario: A producer-side memory surfaces in a consumer

- **GIVEN** a memory anchored to an interface exported by repo A
- **WHEN** an agent recalls relevant memory while editing consumer repo B
- **THEN** the memory surfaces in B with a freshness verdict, and is withheld if its anchor is orphaned
