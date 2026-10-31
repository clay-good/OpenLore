# Tasks — add merge semantic certificate

> As built (`merge-semantic-certificate.ts`): builds the call graph at the merge-base and each side
> via `git show` + `CallGraphBuilder`, computes each side's removed / breaking-signature symbols
> with the `public-surface` classifier, and cross-joins one side's changed/removed symbols × the
> OTHER side's ADDED call edges, both directions. Family `coordinate`, opt-in `coordination` preset.

## Implementation
- [x] Cross-branch join: for each of (ours, theirs) vs merge-base, compute changed-signature /
      removed symbol sets (reuse `public-surface.ts` `classifySignatureChange`); join each side's
      set against the other side's ADDED call edges, both directions (pure `changedSymbols` /
      `addedEdges` / `crossJoin`). A within-branch rename does not cross the branch boundary, so a
      migrated rename is not a false conflict and a call the other branch adds to the old name is.
- [x] Verdicts: `incompatible` (removed / breaking signature) / `potentially-incompatible`
      (unprovable) per finding with the edge and the rule; never a silent "compatible"
- [x] Base resolution via `git merge-base ours theirs` (or an explicit `base`); fatal on a bad base
- [x] Not-assessed disclosure for unresolvable refs, unindexed languages, dynamic-dispatch
      boundaries (the overall verdict is a sound lower bound, never "safe")
- [x] Register `merge-semantic-conflict` in `FINDING_CODE_REGISTRY` (advisory default)
- [x] `certify_merge` MCP handler + dispatch; `coordination` preset (budget 2,650 → 3,100); family
      `coordinate`; class `conclusion`; `_RO` annotation; epistemic-lease weight; sibling
      cross-reference to `map_in_flight_conflicts` and the merge-tree oracle; full-surface tool
      count, payload budget, Pi surface, TLS line, delivery-parity, tool-driver, and docs updated
- [ ] Retained (non-added) edges into a changed symbol — deferred (an author's own blast-radius
      concern; added-edge conflicts are the merge-specific core)
- [ ] Perf: scope the branch builds to the diff union via the hash-keyed Pass-1 cache (today it
      builds the full graph at three refs) — deferred
- [ ] `openlore certify-merge --ours <ref> --theirs <ref> [--base <ref>] [--json]` CLI — deferred
      (today the capability ships as the MCP tool)

## Verification
- [x] Cross-join: an added call into a removed symbol → `incompatible`; into a potentially-breaking
      change → `potentially-incompatible`; into an unchanged symbol → nothing (both directions)
      (`merge-semantic-certificate.test.ts`)
- [x] `changedSymbols` reports removals, ignores unchanged + external; `addedEdges` returns only
      edges new in the side graph, excluding external/overrides
- [x] tool-registration guards green (contract, annotations, presets incl. coordination membership,
      payload budget, doc-claim-sync, tool-count, epistemic-lease, Pi parity, TLS, delivery-parity,
      tool-driver)
- [ ] Real-repo fixture with two branches (full git integration) — deferred with the CLI

## Spec
- [x] `mcp-handlers` delta: ADD MergeSemanticCompatibilityIsCertified (retained-edge conflicts,
      perf scoping, and the CLI remain, so the change stays open)
