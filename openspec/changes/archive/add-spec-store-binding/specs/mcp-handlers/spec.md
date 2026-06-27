# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SpecStoreBinding

The system SHALL support an optional, additive binding between an OpenLore-indexed environment and an
external spec repository that declares the code repositories its plans target and reference. The binding
SHALL consist of the store's name, its local path, a list of declared **target** repositories, and an
optional list of declared **reference** repositories. The binding SHALL be configuration only: the
system SHALL read the store's declared relationships and SHALL NOT clone, write to, synchronize, or
fence the store or any target. When no binding is configured, single-repository behavior SHALL be
unchanged.

#### Scenario: A binding declares targets and references

- **GIVEN** an OpenLore environment configured with a spec-store binding naming two target repositories
  and one reference repository
- **WHEN** the binding is loaded
- **THEN** the system records the store name, path, targets, and references, and makes no modification to
  the store or any target

#### Scenario: Absent binding preserves single-repo behavior

- **GIVEN** an environment with no spec-store binding configured
- **WHEN** OpenLore runs
- **THEN** behavior is identical to the unbound single-repository case and no binding error is raised

### Requirement: SpecStoreNameResolution

The system SHALL resolve declared target and reference names to local repository indexes via the
multi-repository federation index-of-indexes, and resolved targets SHALL join the binding's federation
set so that cross-repository structural facts are computable across the plan's targets. A declared name
that does not resolve to a local index SHALL produce a `dangling` finding rather than an error, and the
remaining names SHALL still resolve.

#### Scenario: One target is missing

- **GIVEN** a binding declaring three targets, one of which has no local index
- **WHEN** names are resolved
- **THEN** two targets resolve into the federation set and exactly one `dangling` finding is reported for
  the missing target

### Requirement: SpecStoreHealthCheck

The system SHALL provide a deterministic, read-only, conclusion-shaped health check for a spec-store
binding that reports, per declared target, whether it resolves, whether its index is present, and
whether its index is fresh relative to its working tree; per declared reference, whether it is present;
and any dangling declared names. Each finding SHALL carry a stable code and a pasteable remediation. The
check SHALL NOT block and SHALL degrade infrastructure failures (no federation, not a repository, a
corrupt federation registry) to a typed finding rather than throwing — on every surface, including the
MCP dispatch path, not only the CLI. The check SHALL compose existing analyses only, with no LLM.

#### Scenario: A healthy binding reports no findings

- **GIVEN** a binding whose every target resolves to a present, fresh index and whose references are all
  present
- **WHEN** the health check runs
- **THEN** it returns zero findings and a sound verdict

#### Scenario: A stale target index is surfaced

- **GIVEN** a binding whose target index is older than that target's working tree
- **WHEN** the health check runs
- **THEN** it returns exactly one finding with the stable code `index-stale` and a remediation, and does
  not block

#### Scenario: A corrupt federation registry degrades to a finding, never a throw

- **GIVEN** a configured binding and a corrupt or malformed `.openlore/federation.json`
- **WHEN** the health check runs (including via the MCP dispatch path)
- **THEN** it returns a report carrying a `registry-unreadable` finding rather than throwing, and does
  not emit a misleading `target-unresolved` finding for each declared target
