# Tasks — harden-artifact-write-atomicity

## Implementation
- [x] Atomic-write helper: same-directory temp file + fsync + rename (same-filesystem atomicity);
      orphan cleanup; one home, no per-site duplication — REUSED the tree's existing
      `atomicWriteFile` (`src/core/decisions/atomic-store.ts`, already used by
      `index-attestation.ts`) rather than inventing a second `writeFileAtomic`
- [x] Adopt it for every artifact write in `generateAndSave` (artifact-generator.ts) and the late
      writes (duplicates.json, refactor-priorities.json in `generateLLMContext`)
- [x] Adopt it in the watcher's `persistContext`; migrate the four inline `tmp + rename` sites
      (dependency-graph patch + delete, style-fingerprint, parse-health) to the shared helper
- [x] Analysis-directory cross-process lock reusing the decision-store pattern (lock.ts:
      exclusive-create, stale-steal, bounded wait, best-effort on timeout — same constants, no new
      tuning): `acquireAnalysisLock`/`withAnalysisLock`, keyed on the analysis output directory,
      taken around analyze's save-set and the watcher's change and deletion lanes, so the
      watcher-spawned `analyze --force` serializes instead of racing. `persistContext` stays
      lock-free (runs inside a lane that already holds the lock — no re-entrant acquire)

## Verification
- [x] Torn-write test: `atomicWriteFile` leaves the previous or the new complete version, never
      truncated JSON (existing `atomic-store.test.ts`, now the shared primitive both writers use)
- [x] Concurrent-writer test: `withAnalysisLock` serializes two set-writers of the same directory —
      the event log is never interleaved and the final set is one writer's homogeneous output
      (`lock.test.ts`)
- [x] Writer-adoption guard: both writers route every artifact write through `atomicWriteFile` and
      fence their lanes with `withAnalysisLock`; no bare `writeFile`, no inline `tmp + rename`
      remains (`artifact-write-atomicity.test.ts`)
- [x] Lock reuse test: analysis-lock stale-steal and bounded-wait match the decision store's shape
      (shared `acquireLockAt`, not a re-implementation); analysis lock is independent of the
      decisions lock (`lock.test.ts`)
- [x] Full suite green; watcher parity tests unaffected

## Spec
- [x] `architecture` delta: ADD ArtifactWritesAreAtomic, ConcurrentArtifactWritersSerialize
      (also added to the committed `openspec/specs/architecture/spec.md`, alongside the sibling
      `harden-index-store-lifecycle` store-durability requirements)
