# Tasks — add-peer-footprint-board

## Implementation
- [ ] Board store at `<git-common-dir>/openlore/board/` (atomic write, fail-open read, bounded);
      entry shape `{ actorId, worktree, branch, writeSet, readSet, hashes, title, declaredAt,
      lastSeenAt }`
- [ ] `declare_footprint` MCP tool + `openlore footprint declare|release|list`; resolution through
      `change-footprint.ts`; hazards vs live peers returned in the same response
- [ ] Wiring checklist: conclusion classification, family `coordinate`, `coordination` preset only,
      Pi surfaced-or-excluded, lease weight, payload budget, docs table row, sibling cross-references
- [ ] `map_in_flight_conflicts` reads live entries as agent descriptors; `plan_parallel_work` option
      to plan against them; `fleet_status` lists them
- [ ] Ledger publishes edited-symbol hashes to the board; after-tools hook names peer edits that hit
      this agent's read-set or served set
- [ ] `duplicate-intent` hazard + registered finding (advisory)
- [ ] Lease end: release, branch merged/deleted, `lastSeenAt` expiry; `moved-since-declared` state
- [ ] Title redaction + instruction-shaped withholding (memory-push rules); `local-unreviewed`
      provenance on every served peer field
- [ ] Move fleet verification records to the board directory (with a one-time read of the old path)

## Verification
- [ ] Two worktrees of one clone see each other's entries; a separate clone does not
- [ ] Peer edits a symbol in my read-set → my next after-tools receipt names it; an unrelated edit →
      nothing
- [ ] Two entries creating the same function name → `duplicate-intent`
- [ ] Merged branch → its entry ends; stale `lastSeenAt` → ends
- [ ] Instruction-shaped title → withheld; credential in title → redacted
- [ ] Fleet record proved in worktree A is visible with its drift verdict in worktree B
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD PeerFootprintsAreSharedAcrossWorktrees
- [ ] `mcp-handlers` delta: ADD PeersAreToldWhenASymbolTheyReadChanges
