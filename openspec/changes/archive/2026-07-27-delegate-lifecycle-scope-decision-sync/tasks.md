# Tasks — scope the decision syncer, delegate change lifecycle to OpenSpec

## Remove the out-of-scope re-implementation
- [x] Delete `src/core/changes/**` (spec-fold + change-status + tests) — orphan re-implementation
      of `openspec archive` / `openspec list`, no external importers
- [x] Revert the `OPENSPEC_CHANGES_SUBDIR` / `OPENSPEC_ARCHIVE_SUBDIR` constants (used only by the
      deleted code)

## Implementation (OpenLore-native)
- [x] Scope the decision syncer (`src/core/decisions/syncer.ts`): write the full requirement +
      Decisions block to one owning domain (first affected domain that resolves to a spec); write a
      one-line pointer reference to the other affected domains
- [ ] Prune existing cross-domain duplicate requirements the old fan-out already wrote (handled as
      corpus repair by `restore-spec-corpus-integrity`; the syncer change stops new ones)

## Process (delegate to OpenSpec — no OpenLore code)
- [ ] Adopt `openspec archive <name>` at ship time (fold deltas + move to archive); `--skip-specs`
      for tooling/doc-only changes
- [ ] Backfill: run `openspec archive` over the ~24 stranded shipped changes in reviewed batches
      (tracked by `restore-spec-corpus-integrity`)

## Verification
- [x] Syncer test: an approved decision with three affected domains yields one full requirement +
      two pointer lines; a re-sync adds no verbatim duplicate (`syncer.test.ts`)
- [x] Grep guard / review: no `openlore change`, `openlore archive`, or fold-engine surface exists
      in `src/` (verified — `src/core/changes/**` deleted, no importers)

## Spec
- [x] `architecture` delta: ADD SpecDrivenDevelopmentDelegatedToOpenSpec
- [x] `openspec` delta: ADD DecisionSyncWritesOneOwningDomain (replaces the withdrawn
      ArchiveFoldsDeltasIntoSpecs / ChangeLifecycleIsMachineReadable)
