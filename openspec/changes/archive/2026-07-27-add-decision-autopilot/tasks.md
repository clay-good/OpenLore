# Tasks — add-decision-autopilot

## Implementation
- [x] `auto-approved` status + legality rules layered on the transition state machine
      (gate-state.ts, store.ts): `verified → auto-approved` only for actor `autopilot` with
      `governance.autopilot: true`; `rejected → *` stays human-only; all writes ride the CAS
      discipline from harden-decision-consolidation
- [x] Append-only ledger writer in store.ts: every transition appends
      `{id, title, from, to, actor: human|autopilot|agent|sync, at, commit}` to `.openlore/decisions/ledger.jsonl`
      (all modes, not just autopilot); ensure `.openlore/decisions` gitignore coverage holds
- [x] Gate autopilot path (decisions.ts --gate): verified decisions auto-approve + background
      sync; one advisory stderr line; exit 0 always in autopilot; infra failure → caveat +
      exit 0 (impact-certificate discipline)
- [x] `openlore decisions log [--json] [--since <ref>]` (ledger render, newest-first) and
      `openlore decisions review` (bulk promote/reject of auto-approved-unreviewed; reject
      retires from specs via existing supersession, queryable via asOf)
- [x] Provenance surfacing: spec renderer marks auto-approved as "auto-accepted (unreviewed)";
      recall + verify_claim decision-current carry `approvedBy: autopilot` provenance
- [x] `governance.autopilot` config key + `openlore features` listing

## Verification
- [x] Transition tests: autopilot never touches human-rejected decisions; mode off →
      byte-identical behavior to today; sync can still not promote (fix-decision-status-
      transitions composition)
- [x] Ledger tests: every transition appends exactly once; log/--since render; ledger
      survives concurrent gate + MCP writes (file lock)
- [x] Gate tests: autopilot commit never blocks; advisory line lists count; infra failure
      exits 0 with caveat
- [x] Review/revert round-trip: auto-approve → reject retires from specs, asOf still serves
      history; promote upgrades to human `approved`
- [ ] Full suite green; `openspec validate add-decision-autopilot` at archive time
