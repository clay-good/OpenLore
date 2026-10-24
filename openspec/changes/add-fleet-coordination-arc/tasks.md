# Tasks — add fleet coordination arc

> As built (`fleet-coordination.ts`): a typed verification-record store + a drift re-classification
> that reuses the SAME freshness lease `recheckCertificate` uses (`AnchorContext` + `memoryFreshness`
> over the record's anchors), and a `fleet_status` conclusion. Family `coordinate`, opt-in
> `coordination` preset. Depends on `certify_merge` (#610, merged).

## Implementation
- [x] Typed coordination verification record `{ id, verdict, branch, baseCommit, producedBy,
      anchors }`, recorded for a clean `blast_radius` / stable `certify_public_surface` / passed
      `certify_merge`, in a coordination-scoped JSON store (`recordVerification`)
- [x] Base-drift resolution: `classifyRecords` maps the freshness-lease verdict to `still-valid` /
      `invalidated` / `needs-reverification` (carry is handled upstream by the anchor system, so a
      moved-but-unchanged symbol reads fresh → still-valid); a verdict is NEVER served fresh without
      the check (no graph → every record is needs-reverification, not silently fresh)
- [x] `fleet_status` composing conclusion: the classified records + the arc references
      (plan_parallel_work → map_in_flight_conflicts → certify_merge) per in-flight branch, each line
      attributed to its producing tool; references components, re-derives nothing
- [x] Boundary disclosure: no-graph and unanchored records → needs-reverification; advisory
- [x] `fleet_status` MCP handler + dispatch; `coordination` preset (budget 3,100 → 3,400); family
      `coordinate`; class `conclusion`; `_RO` annotation; epistemic-lease weight; Pi NAV/review
      group/glance (+ Pi `all` budget 8,700 → 9,400); TLS line; delivery-parity; tool-driver; tool
      count 79 → 80; payload budget (104,000 → 105,200 B) + KB/token + standing-context docs
- [ ] Store lifecycle: expire records when a branch lands/closes — deferred (today records persist
      until overwritten by id)
- [ ] `carried` as a distinct surfaced state (vs. subsumed in `still-valid`) + the invalidating
      commit on `invalidated` — deferred (needs the per-anchor verdict detail surfaced)
- [ ] Live per-branch arc EXECUTION in `fleet_status` (today it references the arc tools to run per
      branch) + the `openlore fleet-status` CLI — deferred

## Verification
- [x] `stateForFreshness` maps fresh → still-valid, drifted → invalidated, orphaned →
      needs-reverification; unknown/unanchored → needs-reverification (never silently fresh)
- [x] `classifyRecords` with no graph view → every record needs-reverification; carries the
      producing tool + base commit onto each classified record (`fleet-coordination.test.ts`)
- [x] tool-registration guards green (contract, annotations, presets incl. coordination membership,
      payload budget, doc-claim-sync, tool-count, epistemic-lease, Pi parity + budget, TLS,
      delivery-parity, tool-driver)
- [ ] Full lease integration over a real moved/changed symbol (with the carried-state + invalidating
      commit work)

## Spec
- [x] `mcp-handlers` delta: ADD FleetVerificationMemorySurvivesBaseDrift (lifecycle, the distinct
      `carried` state + invalidating commit, live arc execution, and the CLI remain — change stays open)

## Dependencies
- [x] Requires `add-merge-semantic-certificate` (`certify_merge`) — merged (#610)
