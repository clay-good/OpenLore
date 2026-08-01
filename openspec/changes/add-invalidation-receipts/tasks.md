# Tasks — add invalidation receipts

## Implementation
- [ ] Closed cause set beside the existing endpoint fields: `anchor-content-changed |
      symbol-deleted | superseded-by <id> | claim-refuted`; written once, immutable; additive
      schema (legacy records unchanged)
- [ ] Receipt pinning: bounded walk of the anchored file's history between the last-fresh and
      first-stale fingerprint commits; first commit breaking the anchor's content hash wins;
      unresolvable → `commit: unknown` + reason, never a guessed SHA
- [ ] Wire all detectors: analyze-time continuity/orphan pass, watcher staleness, read-path
      verdicts; supersession keeps its existing writer (now also records its cause)
- [ ] `recall`: attach receipt to drifted/orphaned results; `--asOf` reports closed validity
      intervals with evidenced endpoints
- [ ] Cache: one walk per invalidation event, stored with the record

## Verification
- [ ] Delete an anchored symbol in commit C → memory carries `symbol-deleted` @ C
- [ ] Edit the anchored span in C → `anchor-content-changed` @ C; edits elsewhere in the file do
      not produce a receipt
- [ ] Supersede → `superseded-by <id>` with the commit, matching today's fields
- [ ] Shallow clone hiding C → `commit: unknown` with the disclosed reason
- [ ] `recall --asOf` before C serves the memory; after C reports the closed interval
- [ ] Receipts are immutable across re-analyze (no rewriting on later passes)

## Spec
- [ ] `drift` delta: ADD InvalidationCarriesACommitReceipt
