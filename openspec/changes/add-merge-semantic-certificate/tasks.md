# Tasks — add merge semantic certificate

## Implementation
- [ ] Cross-branch join: for each of (ours, theirs) vs merge-base, compute changed-signature /
      removed / renamed symbol sets (reuse `public-surface.ts` rules + continuity); join each
      side's set against the other side's added/retained call+import edges, both directions
- [ ] Verdicts: `incompatible` / `potentially-incompatible` per finding with commits, edge, and
      rule receipt; never a silent "compatible" for the unprovable
- [ ] Base resolution via `resolveBaseRefDisclosed`; certification is fatal on a bad base
- [ ] Not-assessed disclosure for unresolvable refs, unindexed languages, dynamic-dispatch
      boundaries
- [ ] Register `merge-semantic-conflict` in `FINDING_CODE_REGISTRY` (advisory default)
- [ ] `certify_merge` MCP handler (coordination preset; family `coordinate`; class `conclusion`;
      sibling cross-reference to `map_in_flight_conflicts` and the merge-tree oracle) +
      `openlore certify-merge --ours <ref> --theirs <ref> [--base <ref>] [--json]`

## Verification
- [ ] Fixture: A adds a call to a function whose required parameter B adds → `incompatible`,
      both directions exercised
- [ ] B renames a symbol and migrates all its own callers; A adds a caller to the old name →
      conflict on A's edge only; B's migrated callers are not flagged
- [ ] Narrowed parameter type → `potentially-incompatible`, never compatible
- [ ] Disjoint, genuinely independent branches → empty certificate that still disclosens
      boundaries (dynamic-dispatch counts, unindexed files)
- [ ] Unresolvable ref → not-assessed, never "no conflict"
- [ ] tools/list payload budget re-asserted or bumped with rationale

## Spec
- [ ] `mcp-handlers` delta: ADD MergeSemanticCompatibilityIsCertified
