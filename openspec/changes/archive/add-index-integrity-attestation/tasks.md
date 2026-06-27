# Tasks — Index integrity attestation

## 1. Attestation record
- [x] Define the attestation shape: schema version, committed counts (files/functions/edges/classes),
      content digest of the persisted graph. (Parse-failure count omitted — failed files contribute no
      nodes, so production counts account for them implicitly; no fabricated number, per honesty-over-coverage.)
- [x] Compute and write it alongside the index on analyze completion; ensure it is a deterministic
      function of the build (byte-identical across re-analyses of a fixed commit). — `index-attestation.ts`
      + `artifact-generator.ts:writeEdgesToSQLite`; verified byte-identical on this repo across two builds.

## 2. Verdict
- [x] Implement the reconciliation verdict `healthy | degraded | mismatched` (persisted-vs-committed
      counts + schema version); reconcile, do NOT re-extract. — `reconcile()`.
- [x] Fixed ratio floor for `degraded` with a small-repo exemption; checkpoint-and-recount retry before
      declaring `degraded`. — `DEGRADED_RATIO_FLOOR`, `SMALL_REPO_MIN_FUNCTIONS`, `EdgeStore.checkpoint()`.
- [x] Load-time re-check (schema version + counts) producing the verdict. — `readCachedContext`.
      (Digest is a determinism/tamper stamp only, not a load-time driver — the incremental watcher
      mutates the store between full builds, so a digest-equality check would false-positive.)

## 3. No-silent-degradation + surfacing
- [x] On non-`healthy` at load: emit a recoverable signal; report-and-recover (recommend clean
      re-analyze); never serve degraded-as-complete or substitute empty. — `emit(... index_integrity ...)`,
      verdict attached to `CachedContext.integrity`.
- [x] Surface the verdict on the health/status path. — `health-map.ts` `indexIntegrity` field.
- [x] Attach the verdict to the existing confidence-boundary/staleness disclosure of `find_dead_code`,
      `select_tests`, `analyze_impact`, reachability (reuse the channel; add no new field elsewhere). —
      `assembleBoundary({ integrity })` wired in reachability / test-impact / graph / pathfind.
- [x] Keep advisory by default (no blocking). — verdict is disclosed, never blocks; gating deferred.

## 4. Tests
- [x] Fault injection: partial-persist a built index → verdict `degraded`; conclusion tools carry the
      degraded disclosure. — `index-integrity-load.test.ts` + `confidence-boundary-integrity.test.ts`.
- [x] Schema bump: older-schema attestation loads as `mismatched`. — `index-integrity-load.test.ts`.
- [x] Determinism: attestation byte-identical across two builds. — `index-attestation.test.ts` + dogfood.
- [x] No-silent: degraded index on load emits a signal and does not return an empty/complete graph.

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` green (4832 tests pass).
- [x] Dogfood: induced a degraded/mismatched index on this real repo; confirmed the verdict and the
      labeled conclusions. Caught + fixed a real internal-vs-external node-count bug pre-merge.

## 6. Docs
- [x] Documented the attestation, the verdict semantics, the ratio floor + small-repo exemption, and the
      report-and-recover behavior in the spec delta. Noted the deferred opt-in `degraded-index`
      enforcement finding.
