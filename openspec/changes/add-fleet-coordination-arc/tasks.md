# Tasks — add fleet coordination arc

## Implementation
- [ ] Typed coordination verification record: anchored fact carrying `{ verdict, baseCommit,
      provenSymbols, producingTool }`, recorded for a clean `blast_radius` / stable
      `certify_public_surface` / passed `certify_merge`
- [ ] Base-drift resolution: on base advance, classify each record `still-valid` / `carried` /
      `invalidated` (with invalidating commit) / `needs-reverification` using the freshness lease +
      symbol-identity continuity; never serve a verdict as fresh past its base without this check
- [ ] Store lifecycle: coordination-scoped, keyed to in-flight branches, expired when a branch
      lands or closes (bound growth)
- [ ] `fleet_status` composing conclusion over a set of in-flight branches: dispatch plan +
      conflict map + landing certificates + still-valid records, each line attributed to its
      producing tool; references components, re-derives nothing
- [ ] Boundary disclosure: unindexed languages, dynamic-dispatch edges, diff-fetch failures →
      not-assessed
- [ ] `fleet_status` MCP handler (`coordination` preset; family `coordinate`; class `conclusion`;
      sibling cross-reference to `plan_parallel_work`, `map_in_flight_conflicts`, `certify_merge`)
      + `openlore fleet-status [--json]`

## Verification
- [ ] Verdict proven against base X; base advances touching unrelated code → `still-valid`, reused
      without re-verification
- [ ] Base change touches a proven symbol → `invalidated` with the invalidating commit
- [ ] Proven symbol renamed/moved without body change → `carried`, anchors re-pointed
- [ ] Lost anchor → `needs-reverification`, neither served fresh nor dropped
- [ ] `fleet_status` composes the four phases with per-line tool attribution; no component finding
      re-derived into a disagreement
- [ ] Records expire when their branch lands/closes (store growth bounded)
- [ ] tools/list payload budget re-asserted or bumped with rationale

## Spec
- [ ] `mcp-handlers` delta: ADD FleetVerificationMemorySurvivesBaseDrift

## Dependencies
- [ ] Requires `add-merge-semantic-certificate` (`certify_merge`) for the landing verdict recorded
      here; sequence after it
