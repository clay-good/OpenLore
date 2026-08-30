# Widen the architecture rule vocabulary: required, circular, reachable/orphan, captures, instability

> Status: PROPOSED (2026-07-03, e2e audit). Generalizes the deterministic rule vocabulary
> dependency-cruiser proved out (prior art: https://github.com/sverweij/dependency-cruiser) onto
> OpenLore's cross-language unified graph — declarative, advisory-by-default, no LLM.

## The gap

`check_architecture` evaluates exactly three rule kinds — `layers`, `forbidden`, `allowedOnly` —
declared in `.openlore/architecture.json` (`src/core/architecture/rules.ts:26-49`; handler summary
in `src/core/services/mcp-handlers/architecture.ts:40-48`; engine in `src/core/architecture/check.ts`).
That covers "X must not depend on Y" but none of the equally deterministic invariants teams
actually enforce, all of which dependency-cruiser demonstrates for JS and OpenLore can serve
cross-language over the graph it already stores:

| Missing rule kind | Invariant it expresses | Today |
|---|---|---|
| `required` | every module matching X MUST depend on Y (e.g. every handler imports the sanitizer) | inexpressible |
| `circular` | no dependency cycles among matched modules, with allowed exceptions | inexpressible |
| `reachable` / `orphan` | nothing outside folder A may transitively reach B; a matched module with no incoming edges is flagged | inexpressible (orphan overlaps `find_dead_code` — cross-referenced, not duplicated) |
| capture groups | a file under `domains/$1/` may only import `domains/$1/` — one rule for N domains | needs N `allowedOnly` rules, maintained by hand |
| `moreUnstable` | a stable module must not depend on a more-unstable one | inexpressible |

Violations today are a bespoke advisory report; none carries a registered `GovernanceFinding` code,
so an operator's `enforcement.policy` cannot name architecture violations and `openlore enforce`
cannot govern them — unlike every finding source added since `add-finding-enforcement-policy`
(`FINDING_CODE_REGISTRY`, `src/core/services/mcp-handlers/enforcement-policy.ts:81`).

## What changes

- **Five new rule kinds** in the same total-parse, author-declared format (`rules.ts` — malformed
  entries stay warnings, never throws): `required`, `circular` (with an `allowed` exception list),
  `reachable` (scope → target, evaluated as transitive reachability over the file-level dependency
  graph), `orphan` (no incoming edges within the matched scope), and `moreUnstable`.
- **Capture groups in path patterns:** `$1`-style back-references between a rule's `from` and `to`
  patterns, so `{ from: "domains/$1/", allowedOnly: ["domains/$1/", "shared/"] }` expresses the
  same-folder invariant once for every domain.
- **Instability is derived, not tuned:** I = fanOut / (fanIn + fanOut), computed entirely from the
  fan-in/fan-out already stored on every node/file — no new constant, no threshold; `moreUnstable`
  flags only the strict comparison I(dependency) > I(dependent), exactly dependency-cruiser's rule.
- **Registered findings:** every violation is emitted in the unified `GovernanceFinding` shape with
  a stable per-kind code registered in `FINDING_CODE_REGISTRY` (e.g. `architecture-required-missing`,
  `architecture-cycle`, `architecture-unreachable-breach`, `architecture-orphan`,
  `architecture-instability-inversion`, plus the three existing kinds gaining codes). Advisory by
  default; blocking only via operator `enforcement.policy`, per the registry's contract.
- **Honest edges:** each violation disclosure carries the resolution confidence of the edges it
  rests on — a verdict that depends on `name_only` edges says so; `orphan`/`reachable` results
  cross-reference `find_dead_code` as the sibling conclusion (NoRedundantConclusions) instead of
  re-reporting dead code.

Deliberately NOT borrowed from dependency-cruiser: its JS/TS-only resolver stack (OpenLore's own
cross-language graph is the substrate), its full regex rule DSL (path prefixes + `$1` captures
only — total parsing must stay trivially auditable), and its error/warn severity ladder (OpenLore's
enforcement classes are owned by the operator's policy, with the source declaring only the default).

## Why this is in scope

Pure widening of an existing deterministic, opt-in, declarative capability — no LLM, no network,
no new dependency. It also closes a governance inconsistency: architecture violations become
policy-nameable findings like every other finding source, serving the north star's "agents get
grounded, enforceable structure" and the advisory-by-default doctrine.

## Impact

- `src/core/architecture/rules.ts` (+types, total parse), `check.ts` (five evaluators; cycle
  detection and reachability reuse the existing dependency-graph adjacency), `mcp-handlers/architecture.ts`
  (finding emission), `enforcement-policy.ts` (registered codes with source-declared defaults).
- Specs: `mcp-handlers` — 1 ADDED requirement (ArchitectureRuleVocabulary), one scenario per rule kind.
- Risk: cycle detection cost on large graphs (bounded: file-level graph, standard SCC pass);
  capture-group misuse (mitigated: total parse demotes malformed patterns to warnings). No tool
  count change, so no tools/list payload budget impact.
