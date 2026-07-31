# Tasks — harden-federation-freshness

## Implementation
- [x] `evaluateRepoState` (registry.ts:169-177): an empty stored fingerprint with a live index
      returns a new explicit `unbaselined` state, never plain `indexed`; existing
      `stale`/`unindexed`/`missing` verdicts unchanged
- [x] Baseline adoption on observation: when a status/consult path computes the live fingerprint
      for an empty-fingerprint entry with an index present, write the live hash back via the
      existing atomic `saveRegistry` (registry.ts:97-104) — making the registry.ts:173-174
      "adopt on next refresh" comment true
- [x] `repoStatus` (registry.ts:180-) and `spec_store_status`'s target resolution
      (spec-store.ts:220-226 sibling path) surface `unbaselined` with a remediation string;
      consultable but labeled (staleness not yet assessable)
- [x] `handleFederationStatus` (federation.ts:13): wrap `listRepos` in try/catch; a `loadRegistry`
      throw (registry.ts:80-88) degrades to a `registry-unreadable`-shaped conclusion with path +
      remediation, mirroring spec-store.ts:300-309 — never a raw error through
      tool-dispatch.ts:123

## Verification
- [x] Test: register a repo before its first analyze (empty fingerprint), then build its index →
      status reports `unbaselined`; querying status adopts the live hash; subsequent index drift
      now reports `stale` (the forever-`indexed` blind spot is closed)
- [x] Test: an empty-fingerprint entry whose repo has NO index still reports `unindexed` (adoption
      only fires when a live fingerprint exists)
- [x] Test: adoption write is skipped/harmless on a read-only registry (no crash; state still
      reported honestly)
- [x] Test: corrupt `.openlore/federation.json` → `federation_status` returns the
      registry-unreadable conclusion (path + remediation), does not throw; `spec_store_status`
      behavior unchanged
- [x] Full suite green (`npm run test:run`)

## Spec
- [x] `mcp-handlers` delta: ADD RegisteredRepoFreshnessIsBaselined,
      FederationStatusDegradesToConclusion
