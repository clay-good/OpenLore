# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ArchitectureRuleVocabulary

The architecture checker SHALL evaluate, in addition to `layers`/`forbidden`/`allowedOnly`, the
declarative rule kinds `required`, `circular`, `reachable`, `orphan`, and `moreUnstable` over the
cross-language dependency graph, with `$1` capture groups usable between a rule's path patterns.
All rules SHALL remain author-declared and totally parsed (malformed entries become warnings).
Every violation SHALL be emitted as a `GovernanceFinding` with a stable code registered in
`FINDING_CODE_REGISTRY`, advisory by default and blocking only via operator `enforcement.policy`.
Instability SHALL be derived solely from stored fan-in/fan-out (I = fanOut / (fanIn + fanOut)) with
no new constant or threshold. A verdict resting on lower-confidence edges (e.g. `name_only`) SHALL
disclose that confidence, and `orphan`/`reachable` conclusions SHALL cross-reference
`find_dead_code` as their sibling rather than duplicating its report.

The config shapes SHALL be `required: [{ from, to, reason? }]`,
`circular: [{ scope, allowed?: string[], reason? }]`,
`reachable: [{ from, to, reason? }]`, `orphan: [{ scope, reason? }]`, and
`moreUnstable: [{ scope, reason? }]`. `required` SHALL require a direct dependency from every
matched source file. For `reachable`, `from` SHALL name the permitted origin prefix and `to` the
protected target prefix. A path pattern MAY contain one whole-segment `$1` capture; target patterns
MUST NOT reference `$1` unless the source pattern binds it. No general regular expression SHALL be
evaluated.

#### Scenario: A required dependency is missing

- **GIVEN** a rule `{ kind: "required", from: "src/handlers/", to: "src/sanitizer" }` and a handler
  file with no path to the sanitizer
- **WHEN** `check_architecture` runs
- **THEN** an `architecture-required-missing` finding names the handler file

#### Scenario: A cycle is flagged unless excepted

- **GIVEN** a `circular` rule over `src/` with an `allowed` exception list, and a dependency cycle
  A → B → A outside the exceptions
- **WHEN** the checker runs
- **THEN** an `architecture-cycle` finding lists the cycle's members in a deterministic order
- **AND** a cycle whose members match an `allowed` entry is not flagged

#### Scenario: A reachability breach and an orphan are distinct findings

- **GIVEN** a `reachable` rule "nothing outside `src/public/` may transitively reach `src/internal/`"
  and an `orphan` rule over `src/lib/`
- **WHEN** an outside file transitively reaches `src/internal/` and a `src/lib/` module has no
  incoming edges
- **THEN** the breach yields `architecture-unreachable-breach` with the offending path, and the
  orphan yields `architecture-orphan` cross-referencing `find_dead_code` for the deletion question

#### Scenario: A capture group expresses the same-folder invariant once

- **GIVEN** a rule with `from: "domains/$1/"` allowing only `["domains/$1/", "shared/"]`
- **WHEN** `domains/billing/a.ts` imports `domains/orders/b.ts`
- **THEN** a violation is emitted, while an import within `domains/billing/` or from `shared/` is not

#### Scenario: An instability inversion is flagged without a threshold

- **GIVEN** a `moreUnstable` rule over `src/core/` and a module whose instability (from stored
  fan-in/fan-out) is strictly lower than a module it depends on
- **WHEN** the checker runs
- **THEN** an `architecture-instability-inversion` finding reports both instability values
- **AND** no configurable threshold participates in the verdict

#### Scenario: Findings are policy-governed, advisory by default

- **GIVEN** any architecture violation and no operator `enforcement.policy` naming its code
- **WHEN** `openlore enforce` runs
- **THEN** the finding is reported but does not block
- **AND** a policy mapping the code to `blocking` makes the same finding gate
