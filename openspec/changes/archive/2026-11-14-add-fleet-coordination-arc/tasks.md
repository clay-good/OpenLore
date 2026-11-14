# Tasks — add fleet coordination arc

> As built (`fleet-coordination.ts`): a typed verification-record store + a drift re-classification
> that reuses the SAME freshness lease `recheckCertificate` uses (`AnchorContext` + `memoryFreshness`
> over the record's anchors), and a `fleet_status` conclusion. Family `coordinate`, opt-in
> `coordination` preset. Depends on `certify_merge` (#610, merged).

## Implementation
- [x] Typed coordination verification record `{ id, verdict, branch, baseCommit, producedBy,
      anchors }` in a coordination-scoped JSON store, written through the `recordVerification` API;
      no tool calls it yet
- [x] Base-drift resolution: `classifyRecords` maps the freshness-lease verdict to `still-valid` /
      `invalidated` / `needs-reverification` (carry is handled upstream by the anchor system, so a
      moved-but-unchanged symbol reads fresh → still-valid); a verdict is NEVER served fresh without
      the check (no graph → every record is needs-reverification, not silently fresh)
- [x] `fleet_status` composing conclusion: the classified records + the arc references
      (plan_parallel_work → map_in_flight_conflicts → certify_merge) named, and the `branches` input
      echoed; references components, re-derives nothing
- [x] Boundary disclosure: no-graph and unanchored records → needs-reverification; advisory
- [x] `fleet_status` MCP handler + dispatch; `coordination` preset (budget 3,100 → 3,400); family
      `coordinate`; class `conclusion`; `_RO` annotation; epistemic-lease weight; Pi NAV/review
      group/glance (+ Pi `all` budget 8,700 → 9,400); TLS line; delivery-parity; tool-driver; tool
      count 79 → 80; payload budget (104,000 → 105,200 B) + KB/token + standing-context docs
- [x] Store lifecycle: records end on the same evidence as a peer-board entry (built in #698)
- [x] Addendum 2026-10-31 (built in #648 and #698): verification records move to the git-common-dir store (via
      `add-peer-footprint-board`); branch-landed expiry shares the board rule

## Verification
- [x] `stateForFreshness` maps fresh → still-valid, drifted → invalidated, orphaned →
      needs-reverification; unknown/unanchored → needs-reverification (never silently fresh)
- [x] `classifyRecords` with no graph view → every record needs-reverification; carries the
      producing tool + base commit onto each classified record (`fleet-coordination.test.ts`)
- [x] tool-registration guards green (contract, annotations, presets incl. coordination membership,
      payload budget, doc-claim-sync, tool-count, epistemic-lease, Pi parity + budget, TLS,
      delivery-parity, tool-driver)

## Spec
- [x] `mcp-handlers` delta: ADD FleetVerificationMemorySurvivesBaseDrift (lifecycle built in #698;
      the distinct `carried` state + invalidating commit, live arc execution, and the CLI are cut)

## Dependencies
- [x] Requires `add-merge-semantic-certificate` (`certify_merge`) — merged (#610)


> Archived 2026-11-14. Unbuilt tasks were removed before archiving; they are listed in the
> "Not doing" table of `ROADMAP.md` with the commit to restore them from (`0dd75dbef`).
