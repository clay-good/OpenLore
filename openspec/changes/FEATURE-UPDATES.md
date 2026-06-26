# Change set: feature updates — invest in the layer competitors don't build

This is a second set of change proposals from the competitive survey, written under a different lens
than `STRUCTURAL-CONTEXT-PATTERNS.md`. That first set closed substrate *coverage* gaps (a style
fingerprint, a language registry, integrity attestation, a shareable artifact, cross-service edges).
This set is deliberately strategic: the fastest peer systems have optimized the *substrate* — tree-
sitter → graph → store — to the floor, and the substrate is becoming a commodity. OpenLore does not
win by out-indexing a native, multi-threaded engine. It wins on the layer those systems do not build:
**durable memory that survives refactors, contracts an agent can be held to, conclusions an agent can
trust, and a complete-enough graph to make those conclusions correct.**

So every proposal here is chosen to either (a) **deepen a moat a competitor structurally lacks** —
self-invalidating memory, decision/spec governance, claim verification, conclusion-shaped tools — or
(b) **raise substrate correctness**, because the value proposition is "trustworthy conclusions," and a
conclusion is only as trustworthy as the graph under it. None of these competes on throughput, scale,
or language count. None introduces a learned model, a clock-dependency, or a graph-dump tool.

## The five

| # | Change | Lens | What competitors do / lack | Primary domain |
|---|--------|------|----------------------------|----------------|
| 1 | `add-symbol-identity-continuity` **(SHIPPED 2026-06-25 — deterministic rename/move continuity detector + carry-forward of memory/decision anchors at `openlore analyze`, with `carriedAcross` provenance + `possiblyMovedTo` disclosure; no new MCP tool)** | Moat (memory) | Peers soft-delete a renamed symbol and re-stamp it; anchored *notes* still orphan. OpenLore can carry memory across a rename instead. | analyzer + architecture |
| 2 | `add-public-api-surface-contract` **(SHIPPED 2026-06-25 — `certify_public_surface` MCP tool + `openlore certify-public-surface` CLI: public-surface listing + deterministic breaking-change verdict on a base-ref diff, renamed exports detected via continuity, in-repo consumers named, external consumers disclosed known-unknowable; conservative `potentially-breaking` when compatibility can't be proven; opt-in `full` preset)** | Moat (contract) | Peers expose `EXPORTS`/overrides but don't certify "did this change break the public contract?" | analyzer + mcp-handlers |
| 3 | `add-change-significance-briefing` | Moat (review) | A peer ranks "what changed while I was away" by structural significance with a coverage budget; OpenLore's change tools only see *your own* diff. | analyzer + mcp-handlers |
| 4 | `add-call-resolution-recall` **(SHIPPED 2026-06-25 — re-export/barrel resolution threaded into Pass 2 + `re_export` provenance; items 2/3 found already-delivered by the CHA pass)** | Substrate correctness | A peer resolves calls through imports/re-exports/inheritance in-process (no language server); OpenLore misses these edges, so its negative conclusions are softer than they look. | analyzer |
| 5 | `add-test-coverage-gap-report` **(SHIPPED 2026-06-25 — `report_coverage_gaps` tool + `openlore coverage-gaps` CLI)** | Moat (quality) | Peers have test edges and dead-code; none surfaces "important code with no reaching test," ranked by significance. | analyzer + mcp-handlers |

## Why these and not the obvious others

The substrate-correctness item (4) is first among equals: every conclusion OpenLore is trusted for —
`find_dead_code`, `analyze_impact`, `select_tests`, `blast_radius` — is only sound if the call graph is
complete. A graph that silently misses re-export and interface-dispatch edges makes "nothing reaches
X" a *false* negative, which is the most dangerous kind of wrong for a tool whose whole pitch is
honesty. Improving resolution recall (honestly, with every recovered edge labeled by how it was
resolved and every irresolvable one disclosed) raises the floor under the entire moat.

The three moat items defend or extend categories competitors are not in. Symbol-identity continuity
(1) directly protects the memory moat: today a benign rename orphans every anchored memory, decision,
and spec on that symbol — accumulated knowledge silently evaporates on refactor. The public-API-surface
contract (2) makes OpenLore answer the single highest-value question for a library or service author —
"did I just break my consumers?" — deterministically. The significance briefing (3) opens a new lens
(catch-up / review / onboarding) that the existing your-own-diff tools don't cover.

## Deliberately considered and deferred (so the reasoning is visible)

- **Exception / error-propagation graph** ("what can throw out of here, where is it caught"). Genuinely
  useful for debugging agents and rides the existing CFG overlay — but exception semantics diverge
  sharply across languages (checked vs. unchecked, `finally`, `Result`/`Option` types, panics), so a
  sound version is narrow and a broad version risks unsound edges. Worth a focused follow-up scoped to
  the CFG-overlay languages, not this set.
- **Configuration / environment usage graph** (env var and config-key reads as edges; "what breaks if I
  remove this flag"). Real value, but largely an extension of the existing `get_env_vars` inventory into
  edges; lower novelty than the five above.
- **Ownership / expertise mapping from git history** ("who knows this code"). Deterministic and useful,
  but it answers a *human* routing question, not an agent's structural one — off the north star.
- **A structured graph query language** (a read-only query escape hatch). A peer ships one; OpenLore
  deliberately does not, because returning a queryable graph for the agent to traverse is the exact
  anti-pattern the conclusion-over-graph contract exists to prevent. Excluded on principle.
- **Exposing the existing near-clone detector as a conclusion tool.** Still worth doing (noted in the
  first set), but it is a thin exposure of `duplicate-detector.ts`, not a moat, so it stays a one-off.

## Constraints inherited by every proposal here (same as the first set)

- **Determinism is a hard constraint.** No learned/statistical/predictive model; no clock; re-analysis
  of a fixed repository state is byte-identical.
- **Conclusion over graph.** New tools return the computed answer (a continuity map, a breaking-change
  verdict, a ranked briefing, a coverage-gap list) — never a node-and-edge dump.
- **Honesty over coverage.** A recovered call edge is labeled by *how* it was resolved; a multi-target
  dispatch yields labeled *candidates*, never a guessed single edge; an ambiguous rename is *not*
  carried forward; a structural-coverage report claims only the sound direction ("no reaching test"),
  never "this is tested." Below-evidence signals report "no signal," consistent with the
  `confidence-boundary` and authoritative-recall invariants.
- **No new tuning constants or composite scores.** Ranking uses *labels from existing classifiers*
  (`landmark-signals.ts` hub/chokepoint/volatile) plus raw evidence (fan-in counts, churn), never a new
  weighted salience number — the discipline set in `STRUCTURAL-CONTEXT-PATTERNS.md` and the navigation
  set's README.
- **Tool-surface discipline.** New MCP tools default to opt-in (a named preset), never `MINIMAL_TOOLS`
  or the first-run default.
- **Additive, no schema break.** New fields optional; older stores/indexes load without migration.

At implementation time, call `record_decision` before writing code for any proposal that introduces a
new tool, data structure, scoring rule, or on-disk field (per project `CLAUDE.md`).
