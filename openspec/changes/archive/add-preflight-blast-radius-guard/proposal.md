# Pre-flight blast-radius guard: catch the mistake before the edit, not after

> Status: IMPLEMENTED (2026-06-18) — shipped as its own PR on branch
> `feat/preflight-blast-radius-guard`. Decision `987286eb`. Spec deltas merged into
> `openspec/specs/mcp-handlers/spec.md` (PreflightStructuralBriefing, AdvisoryByDefault) and
> `openspec/specs/cli/spec.md` (PreflightHookIsOptInAndAdvisory).
> Phase-2 set (built after the five memory + dispatch changes). Orchestrates existing deterministic
> analyses (`analyze_impact`, `select_tests`, anchored-memory + ADR drift via `check_spec_drift`).
> The federation cross-repo-consumers input is scoped out (multi-repo federation not yet shipped) and
> surfaced as a documented no-op (`federation.evaluated: false`). See "Implementation status" at the
> foot of this file.

## Why

An agent's default loop is reactive: edit, run tests, watch them fail, fix. The expensive mistakes —
changing a hub that 58 callers depend on, altering a published interface that breaks cross-repo
consumers, removing a symbol that recorded decisions are anchored to — are knowable *before* the edit,
deterministically, from analyses OpenLore already computes. They just are not surfaced at the moment
they would prevent the mistake.

OpenLore already proved the pattern with the decisions pre-commit gate: a deterministic check at a
natural checkpoint. This change extends that pattern from *governance* to *structural safety*, and —
learning from the lean-surface change's finding that an always-on blocking gate is resented — makes it
a **non-blocking briefing by default**, not a wall.

## What changes

1. **A pre-flight structural briefing.** Given the staged or working diff, OpenLore computes a
   deterministic risk briefing: callers affected and layers crossed (`analyze_impact`), the tests to
   run (`select_tests`), the memories/decisions that this change will orphan or drift (anchored-memory
   freshness), specs that will go stale, and — under federation — the cross-repo consumers of any
   changed published interface.

2. **Conclusion-shaped, actionable.** "This change touches `validateDirectory` (58 callers, 3 layers);
   4 callers pass unsanitized input; 2 decisions anchored here will drift; run these 6 tests; 1 consumer
   repo imports this interface." Not a graph — a briefing the agent acts on before committing.

3. **Non-blocking by default.** It is a report, surfaced on demand (a tool) or via an opt-in git hook
   (like the decisions gate, but advisory). It SHALL NOT block a commit by default. A repo MAY opt into
   a blocking mode for specific high-risk patterns (e.g. orphaning an anchored decision), but the
   default posture is inform, not gate — consistent with the lean/opt-in direction.

4. **Pure orchestration, no new analysis.** Every input already exists: impact, test selection, memory
   anchoring, spec drift, federation consumers. This change wires them into a single pre-edit briefing;
   it adds no new structural computation.

## What does NOT change

- **No LLM.** The briefing is an orchestration of existing deterministic analyses; the north star
  (`c6d1ad07`) holds.
- **No new structural computation.** It composes `analyze_impact`, `select_tests`, anchored-memory
  freshness, drift, and federation consumers — all already specified.
- **Non-blocking by default; opt-in blocking only.** The default surface stays lean; the hook is opt-in
  exactly like the decisions gate's new opt-in posture (`add-lean-default-tool-surface`).
- **Conclusion-shaped.** A briefing, never a graph.

## Research basis

Static change-impact analysis and regression test selection (STARTS, Legunsen et al., FSE 2016) brought
to the pre-edit moment; the decisions-gate pattern generalized from governance to structural safety.
The novelty is a single deterministic briefing that unifies blast radius, test selection, *memory
orphaning*, and *cross-repo consumers* — the last two are uniquely OpenLore's because only OpenLore
holds code-anchored memory and a federated index.

## Application to OpenLore

- **Impact / tests** reuse `analyze_impact` and `select_tests`.
- **Memory orphaning** reuses the anchored-memory freshness from
  `add-code-anchored-memory-staleness` + `harden-memory-integrity-invariant`: which anchors this diff
  will turn `drifted` / `orphaned`.
- **Cross-repo consumers** reuse `add-multi-repo-federation`'s stable-ID resolution.
- **The hook** reuses the install pattern of the decisions pre-commit hook (`cli/commands/decisions.ts`),
  in advisory mode.

## Out of scope

- **Auto-fixing** the flagged risks. The briefing informs; the agent acts.
- **Runtime / behavioral risk.** This is structural blast radius, not test-outcome prediction.
- **A default blocking gate.** Blocking is opt-in, per high-risk pattern, never the default.

## Implementation status (2026-06-18)

**Shipped end-to-end.** Pure orchestration, no new structural computation, no LLM.

- **Core**: `src/core/services/mcp-handlers/blast-radius.ts` — `computeBlastRadius()` composes
  `getChangedFiles` (diff) → `seedsFromFiles` (changed symbols, ranked by fan-in) →
  `analyze_impact` (callers/layers/hubs/governing decisions, top-N by fan-in) → `select_tests`
  (tests to run) → `check_spec_drift` (spec staleness + anchored-memory + ADR drift in one pass).
  Output is one conclusion-shaped briefing with a headline, never a graph.
- **MCP tool**: `blast_radius` — classified `conclusion` in `tool-contract.ts`; registered in
  `tool-dispatch.ts`, `TOOL_DEFINITIONS` (`mcp.ts`), and `tool-driver.ts`. Kept OUT of the
  `minimal`/`navigation`/`memory` presets; the full-surface payload ceiling was bumped 55_000 → 57_000
  as a conscious budget decision.
- **CLI + hook**: `openlore blast-radius` (`--base`, `--json`, `--hook`, `--install-hook`,
  `--uninstall-hook`) in `src/cli/commands/blast-radius.ts`. The advisory pre-commit hook (marker
  `# openlore-blast-radius-hook`) coexists with the decisions gate, is advisory by default (exit 0),
  and blocks only on configured `blastRadius.block` patterns. Infrastructure failures (no graph, not a
  repo) never block.
- **Config**: `OpenLoreConfig.blastRadius?: { block?: ('orphans-anchored-memory' |
  'orphans-anchored-decision')[] }` (optional, additive).
- **Tests**: `blast-radius.test.ts` (7) — hub briefing, empty diff, drift-unavailable degradation,
  no-analysis error, and `triggeredBlockPatterns` (fires-on-its-pattern / advisory-otherwise /
  advisory-by-default). Full suite green (3900 pass, 2 skip).
- **Dogfood**: see `DOGFOOD-preflight-blast-radius.md`.

### Scoped deviation from the draft

- **Federation cross-repo consumers** are NOT computed (`add-multi-repo-federation` is not shipped).
  The briefing emits `federation: { evaluated: false, note }` and lists it as a caveat rather than
  silently omitting it. Wire it in when federation lands.
- **Naming**: the capability is named `blast_radius` (MCP) / `blast-radius` (CLI), not `preflight`,
  because `openlore preflight` already exists as an unrelated CI graph-staleness gate. Decision `987286eb`.
