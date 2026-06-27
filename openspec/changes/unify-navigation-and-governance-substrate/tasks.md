# Tasks — unify navigation and governance as one substrate

## Spec (this change)
- [x] `architecture` spec: ADD `UnifiedStructuralSubstrate` requirement (one graph / one anchored-fact store / one freshness lease; read-face vs write-face)
- [x] `mcp-quality` spec: ADD `CapabilityFamilyTaxonomy` requirement (closed family set; full surface grouped by family)
- [x] `mcp-quality` spec: ADD `NoRedundantConclusions` requirement (distinct-question disclosure or consolidation)
- [x] `mcp-quality` spec: MODIFY `Tool Surface Size and Progressive Disclosure` to define the `substrate` both-faces default, gated on the benchmark

## Implementation (later, separate change — NOT in this proposal)
- [ ] Add a source-declared `family` field to each tool definition (closed enum: navigate/change/remember/verify/coordinate/federate)
- [ ] Add the `substrate` preset = `navigation` core + `recall` + `verify_claim` + `blast_radius`
- [ ] Render the full tool surface grouped by family (tools/list + docs)
- [ ] `tool-contract.test.ts`: every tool declares a valid `family`; same-family adjacency carries a distinct-question sentence
- [ ] Run the agent benchmark on `substrate` vs `navigation`; flip the active default only if no regression
- [ ] Update CLAUDE.md / docs tool table to group by family

## Verification
- [x] No new tool, dependency, LLM call, or persisted artifact introduced by the spec change
- [ ] `openspec validate unify-navigation-and-governance-substrate` passes
