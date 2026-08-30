# Architecture Invariant Guardrails

> Spec 23. Deterministic, offline, no network. **Opt-in and inert** until a repo declares rules.
> Author-declared, never LLM-inferred.

`check_architecture` lets a repo declare architectural constraints — "the domain layer must not
import infrastructure," "nothing may depend on `legacy/`," "the API layer may depend only on core
and types" — and answers, **before** an agent writes the import, *"may I add this here?"* with a
deterministic yes/no, the rule that applies, and why. It also reports every current violation.

The distinctive angle is **when** the check happens. Architecture fitness functions (ArchUnit for
Java, dependency-cruiser for JS, import-linter for Python) express rules as test-like assertions and
run them in **CI, after** the violating code is written. OpenLore answers the agent at **edit
time** — turning an architectural rule from a post-hoc failure into a pre-write guardrail — and the
rules run over the **unified, cross-language** dependency graph rather than one language's AST.

It complements, it does not replace, your CI linters.

## Read this first

- **Opt-in.** With no rules declared the instrument is fully inert: no output, no behavior change.
- **Author-declared.** Rules come from `.openlore/architecture.json` and/or synced ADR markers.
  OpenLore never invents a rule with an LLM.
- **Deterministic vocabulary only.** Dependency / layer / module-boundary constraints — the kind a
  graph can decide. No fuzzy "semantic" rules.
- **Advisory, not authority.** It is an additional agent-facing checker; keep your CI gates.

## Declaring rules — `.openlore/architecture.json`

```json
{
  "layers": {
    "cli":   ["src/cli"],
    "core":  ["src/core"],
    "utils": ["src/utils"]
  },
  "forbidden": [
    { "from": "src/core", "to": "src/cli", "reason": "core stays UI-agnostic" }
  ],
  "allowedOnly": [
    { "module": "src/api", "mayDependOn": ["src/core", "src/types"], "reason": "transport-agnostic API" }
  ],
  "required": [
    { "from": "src/handlers", "to": "src/sanitizer" }
  ],
  "circular": [
    { "scope": "src", "allowed": ["src/generated"] }
  ],
  "reachable": [
    { "from": "src/public", "to": "src/internal" }
  ],
  "orphan": [
    { "scope": "src/lib" }
  ],
  "moreUnstable": [
    { "scope": "src/core" }
  ]
}
```

Eight deterministic rule kinds:

| Kind | Shape | Means |
|------|-------|-------|
| `layers` | ordered `{ layer: pathPrefix[] }` | Key order is **top → bottom**; a lower layer depending on an upper layer is a violation. Compiles to the same `classifyLayerEdge` primitive the analyzer already uses for `CODEBASE.md`. |
| `forbidden` | `{ from, to, reason? }` | Files under `from` must not depend on files under `to`. |
| `allowedOnly` | `{ module, mayDependOn[], reason? }` | Files under `module` may depend only on the listed prefixes (intra-module deps always allowed). |
| `required` | `{ from, to, reason? }` | Every matched `from` file must directly depend on at least one matched `to` file. |
| `circular` | `{ scope, allowed?[], reason? }` | Dependency cycles within `scope` are violations unless every member is within an allowed prefix. |
| `reachable` | `{ from, to, reason? }` | Files outside the permitted `from` prefix must not transitively reach `to`. |
| `orphan` | `{ scope, reason? }` | Matched files with no incoming dependency are reported and cross-reference `find_dead_code`. |
| `moreUnstable` | `{ scope, reason? }` | A matched file must not depend on a file with strictly higher `fanOut / (fanIn + fanOut)`. |

Paths are **directory prefixes** (matched against repo-relative paths). Trailing `/`, `/*`, `/**`,
or `*` are tolerated. A rule prefix that matches no file in the repo is reported as a warning (likely
a typo), never a crash. Malformed entries are skipped with a warning — loading rules never throws.

A pattern may contain one `$1` path-segment capture. The captured segment is substituted into the
rule's target/allowlist patterns, so `domains/$1` can keep each domain within its own folder without
maintaining one rule per domain. No general regular expressions are evaluated.

## Rules from decisions (Spec 16 tie)

A recorded architectural decision can *carry* an invariant, so the "why" (Layer 2) and the "may I?"
(Layer 3) share one source of truth. Add an `Invariant:` marker to a **synced** ADR file
(`openspec/decisions/adr-*.md` — synced, because `pending.json` fields are purged on sync):

```
Invariant: forbidden src/core -> src/cli (core stays UI-agnostic)
Invariant: allowedOnly src/api -> src/core, src/types
```

Parsed rules are tagged `source: "decision"` and merged with the config rules.

## Using the tool

**Pre-edit query** — the guardrail in the loop, before the import is written:

```jsonc
check_architecture({ directory, from: "src/core/thing.ts", to: "src/cli/view.ts" })
// → { allowed: false, rule: { kind: "forbidden", reason: "..." }, reason: "importing ... violates ..." }
```

`to` may be a file path or a bare exported symbol — a symbol is resolved to its declaring file via
the dependency graph. When the target can't be resolved, the verdict is **permissive** with an
`unresolved` note: the checker only decides what it can ground.

**Scan** — the full current-violations report:

```jsonc
check_architecture({ directory })
// → { violations: [{ kind, from, to, reason, source }], findings: [{ code, ... }], violationCount, ruleSummary, warnings }
```

**In `orient`** — when rules are declared and a task's relevant files participate in a violation,
`orient` adds an additive `architectureViolations` caution block (and suggests `check_architecture`).
Omitted entirely when no rules exist.

## Guarantees

- Offline and deterministic — no network, no API key, reproducible from a fixed graph.
- Reuses the existing dependency graph and the `classifyLayerEdge` layer primitive.
- Inert by default; additive to every existing tool.
- Findings are registered and advisory by default; only an explicit `enforcement.policy` entry can
  make an architecture code blocking.
