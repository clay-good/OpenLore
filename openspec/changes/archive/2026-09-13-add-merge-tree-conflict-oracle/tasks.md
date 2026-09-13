# Tasks — add-merge-tree-conflict-oracle

## Implementation
- [x] Git plumbing helper (`merge-oracle.ts`): `git merge-tree --write-tree -z --name-only` between
      two tips with `--merge-base` resolved in the real repository, run in a scratch bare repository
      with an alternates file (no object writes, no repository merge drivers or attributes)
- [x] interference-map.ts: branch tips and locally present PR head commits feed a per-conflict
      `textualMerge` verdict; not-assessed for missing/ambiguous base, missing tip, agent task,
      cross-repo pair, or the 60-simulation cap, each with a detail
- [x] Landing suggestion notes a textual conflict (and never calls such a pair safe) or a clean
      auto-merge; headline counts textual conflicts

## Verification
- [x] Disjoint-edit test -> clean-automerge; same-line test -> textual-conflict (real git)
- [x] Unresolvable tests: unrelated histories, criss-cross, shallow clone, unknown tip -> not-assessed
- [x] Safety: repository merge driver never runs (with a non-vacuity control); object store unchanged;
      scratch repository removed
- [x] Statelessness: nothing persisted; the scratch repository is removed in `finally`
- [x] Payload: one bounded field per conflict; existing byte-budget backstop applies
- [x] Full suite green

## Scope notes
- Narrowed to a per-conflict-pair (file-level) verdict. Mapping conflicted hunks back to individual
  witness symbols is deferred.
- Two changes that only ADD the same path share no base symbol, so they form no hazard pair and get
  no verdict; that gap remains.

## Spec
- [x] `mcp-handlers` delta: ADD InFlightConflictsCarryATextualMergeVerdict
