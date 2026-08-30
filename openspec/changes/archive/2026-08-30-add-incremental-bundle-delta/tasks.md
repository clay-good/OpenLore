# Tasks — add incremental bundle delta

## Implementation
- [x] Ancestor branch in `currencyDecision` consumers: verified-ancestor bundle → apply-then-catch-up
      instead of `rebuild`/`stale`; diverged (non-ancestor) unchanged
- [x] Delta set: `git diff --name-only <bundleCommit>..HEAD` ∩ indexed set, plus working-tree
      modifications; deletions removed from the imported index, additions re-analyzed
- [x] Catch-up through the watcher's converge-or-flag path (reverse-dependency closure,
      added-symbol rebinding, work budget, explicit-stale remainder) — factored so import and
      watcher share one implementation
- [x] Validation ladder untouched: any format/integrity/schema/digest failure still degrades to
      full rebuild before currency is even considered
- [x] Import report: path taken (fresh / delta / rebuild), delta file count, closure size,
      explicit-stale remainder; oversized delta may elect full rebuild, disclosed

## Verification
- [x] Equivalence oracle: for an in-budget delta, apply+catch-up produces the same graph as
      `analyze --force` at HEAD (nodes, edges, cfgs — the snapshot-oracle discipline)
- [x] Over-budget fixture: remainder carries explicit stale flags, never served as fresh
- [x] Deleted/added/renamed files across the delta window handled (identity continuity applies)
- [x] Diverged-bundle fixture: full rebuild with the existing `unrelated-commit` disclosure
- [x] Tampered/schema-mismatched bundle still rebuilds (ladder regression)
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD IncrementalBundleCatchUp
