# Reconcile the substrate preset's "both faces" copy with its read-only contents

> Status: SHIPPED (2026-07-18, PR #234; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). The default `substrate` preset is billed everywhere as
> "both faces of the substrate," but it contains only governance *reads* — an agent on the default
> surface can `recall` a memory it can never `remember`, and cannot `record_decision`, while the
> *narrower* `minimal` preset does carry `record_decision`. Two steps: fix the outward copy now
> (honesty), and evaluate adding the write face benchmark-gated per the ADR-0023 process — never
> flip on assertion. Grounded in the honesty contract and the `mcp-quality` evidence-backed
> default discipline.

## The gap

The `substrate` preset (mcp.ts:2206-2211) holds the 10-tool navigation core plus `recall`,
`verify_claim`, `blast_radius` — reads only. The internal comment is honest ("Holds governance
READS only: no remember/record_decision write, no commit gate," mcp.ts:2201-2202). The outward
copy is not:

- `BREADTH_POINTER` (mcp.ts:2280-2286, the `instructions` channel every default-surface agent
  reads): "both faces of the substrate."
- `--preset` help (mcp.ts:2714): "both faces of the substrate."
- `README.md:244,460` ("both-faced out of the box"), `CLAUDE.md:47`, `docs/install.md:37`,
  `docs/agent-setup.md:142`, `docs/cli-reference.md:109,137,147`, `docs/mcp-tools.md:39`.

The two faces are defined as navigation (read the graph) and **governance/memory (anchor facts,
weigh changes)** (`unify-navigation-and-governance-substrate`; CLAUDE.md). Anchoring facts is a
write. The asymmetries this copy papers over:

- **Read-without-write memory**: `recall` is in the default; `remember` is not. The agent is told
  it has the memory face, tries to persist a durable fact, and finds the tool absent.
- **`minimal` ⊃ writes the default lacks**: `MINIMAL_TOOLS` carries `record_decision`
  (mcp.ts:2144-2146), so the surface billed as smaller is more write-capable than the default —
  and CLAUDE.md's own decisions-gate workflow needs `record_decision`, which the default omits.

Two adjacent copy defects, same root (the benchmark flip landed but stale copy survived):
the `--preset` help (mcp.ts:2714) still opens "Default (no preset) is the lean `navigation`
surface" although the shipped default is `substrate` (`LEAN_DEFAULT_PRESET = 'substrate'`,
constants.ts:222); the substrate comment tail (mcp.ts:2203-2205) still says "the *active* default
stays `navigation`"; and `docs/governance-dogfooding.md:30` still cites the navigation default /
ADR-0022.

## What changes

**Step 1 — honest copy, immediate.** Every outward "both faces" claim becomes "the navigation core
plus governance reads (`recall`, `verify_claim`, `blast_radius`)" — accurate, still a selling
point. The stale default-name copy (help, comment tail, dogfooding doc) is corrected to
`substrate`/ADR-0023 in the same pass. No preset contents change; zero tool schemas move.

**Step 2 — benchmark-gated write-face evaluation.** Evaluate adding `remember` +
`record_decision` (13 → 15 tools) to `substrate` via the same DefaultSurfaceRevealsAllFaces
harness that gated the c79ec7ca flip (ADR-0023, superseding ADR-0022): flip **only** on
no-regression evidence across both models and both repo tiers, recorded as a superseding decision.
If the benchmark shows regression, the default keeps reads-only — and the Step 1 copy is already
truthful about that. This proposal does NOT flip the default; it schedules the evidence.

## Why this is in scope

The honesty contract binds the product's self-descriptions, not just its tool outputs: a default
surface that advertises a capability face it cannot exercise is the same defect as a tool
implying completeness it lacks (NoFalseCompleteness) — located in the single most-read copy
surface (the `instructions` channel). The evidence-gated path for step 2 is the established
default-change process; proposing the flip without the benchmark would violate it.

## Impact

- Step 1: copy-only — mcp.ts (`BREADTH_POINTER`, `--preset` help, substrate comment tail),
  README.md, CLAUDE.md, docs/install.md, docs/agent-setup.md, docs/cli-reference.md,
  docs/mcp-tools.md, docs/governance-dogfooding.md. Guarded by extending the copy checks that
  already pin these strings (README honesty-contract pattern; change 1 of this audit adds the
  doc-claim sync guard the preset-size figures ride on).
- Step 2: benchmark run + decision record; on a pass, `substrate` gains 2 tools — tools/list
  payload grows, so the preset budget in `mcp-presets.test.ts` must be re-measured (13.7k ceiling
  today), and the doc "13 tools" figures update via the change-1 guard.
- Specs: `mcp-quality` — 1 ADDED requirement (DefaultSurfaceCopyMatchesItsContents).
- Risk: none in step 1 (copy). Step 2 risk is bounded by the gate itself — no evidence, no flip.
- Sibling: `fix-default-preset-claims` edits the same help strings for a different reason (the
  stale "navigation is default" claim); land together or rebase the later one.
