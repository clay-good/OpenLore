# Tasks — unify navigation and governance as one substrate

## Spec (this change)
- [x] `architecture` spec: ADD `UnifiedStructuralSubstrate` requirement (one graph / one anchored-fact store / one freshness lease; read-face vs write-face)
- [x] `mcp-quality` spec: ADD `CapabilityFamilyTaxonomy` requirement (closed family set; full surface grouped by family)
- [x] `mcp-quality` spec: ADD `NoRedundantConclusions` requirement (distinct-question disclosure or consolidation)
- [x] `mcp-quality` spec: MODIFY `Tool Surface Size and Progressive Disclosure` to define the `substrate` both-faces default, gated on the benchmark

## Implementation (landed in this change)
- [x] Add a source-declared `family` field to each tool — `TOOL_CAPABILITY_FAMILY` in `tool-contract.ts` (closed enum: navigate/change/remember/verify/coordinate/federate), parallel to `TOOL_OUTPUT_CLASS`; every one of the 72 registered tools classified
- [x] Add the `substrate` preset = `navigation` core + `recall` + `verify_claim` + `blast_radius` (`TOOL_PRESETS.substrate`, 13 tools, governance READS only)
- [x] Render the full tool surface grouped by family — `family` emitted in each tool's MCP `annotations` (machine-readable grouping on the wire) + `groupToolsByFamily()` helper + docs section
- [x] `tool-contract.test.ts`: every tool declares a valid `family` (completeness + closed-set + no-stale); `ADJACENT_TOOL_GROUPS` distinct-question check — each adjacent tool names a near-sibling in its description
- [~] Run the agent benchmark on `substrate` vs `navigation`; flip the active default only if no regression — **benchmark not run here**; per the spec the active default REMAINS `navigation` and `substrate` ships as a selectable preset until the evidence exists (the flip is a one-line `LEAN_DEFAULT_PRESET` change, intentionally deferred to a benchmark run)
- [x] Update CLAUDE.md / docs tool table to group by family

## Verification
- [x] No new tool, dependency, LLM call, or persisted artifact introduced (a `family` annotation key + a preset entry; payload-budget ceilings bumped consciously, full 84_000→86_000, nav 13_300→13_700)
- [x] `npm run build` clean; full suite `vitest run src examples` green
- [x] e2e dogfood: live `tools/list` over stdio carries `annotations.family` on all 72 full-surface tools (6 families), lean default is 10 navigate tools + breadth pointer naming `substrate`, `--preset substrate` resolves to the 13 both-faces tools
- [ ] `openspec validate unify-navigation-and-governance-substrate` passes
