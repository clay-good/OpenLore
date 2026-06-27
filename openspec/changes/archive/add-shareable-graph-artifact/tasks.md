# Tasks — Shareable graph artifact

> SHIPPED 2026-06-26. Codec: `src/core/analyzer/index-bundle.ts`. CLI: `src/cli/export/bundle.ts`
> (`export bundle`), `src/cli/commands/import.ts` (`import`). Tests: `src/core/analyzer/index-bundle.test.ts`.
> Docs: `docs/shareable-bundle.md`.

## 1. Artifact format
- [x] Define the portable artifact: serialized persisted graph + bundled integrity attestation (schema
      version, source commit, committed counts, content digest). Self-describing, compact. — gzipped JSON
      envelope `{ manifest, payload }`; manifest carries a freshly re-attested `IndexAttestation` +
      `payloadDigest`; payload is base64 per file (excludes WAL sidecars and the LanceDB subdirs).
- [x] Ensure export is byte-stable (same index → identical artifact). — sorted file order, no wall-clock
      field, fixed gzip level; covered by a determinism test.

## 2. Export / import CLI
- [x] `openlore export bundle [--out <path>]` — serialize the current index + attestation.
- [x] `openlore import <artifact>` — validate-or-rebuild (see §3); materialize the index without
      re-analyzing when valid and commit-current.

## 3. Validate-or-rebuild
- [x] Reject incompatible schema version → `mismatched` → local rebuild. (`preMaterializeRebuildReason`)
- [x] Reject content-digest mismatch (corrupt/tampered/hand-merged) → local rebuild. (payload-digest byte
      check + graph-content digest recomputed from the materialized store vs. bundled attestation)
- [x] Commit matches HEAD → import as-is; stale (ancestor) → full rebuild (incremental-delta deferred);
      diverged/unknown → rebuild. Never serve stale-as-current. (`currencyDecision`)
- [x] Any validation failure degrades transparently to a local rebuild (`runAnalysis`).
- [~] Stale path uses an *incremental* update of only the changed files — DEFERRED. v1 falls back to a
      full rebuild (spec-sanctioned), which trivially matches a fresh analyze at HEAD. See proposal scope
      note.

## 4. Conflict-free git discipline
- [x] Document + tooling-support a `.gitattributes` entry that prevents line-merging the artifact. (export
      prints the recommended `*.olbundle -diff -merge` line; documented in `docs/shareable-bundle.md`)
- [x] Document the canonical divergence resolution: re-export at the merge commit (never hand-merge).

## 5. CI bootstrap
- [x] Document the CI path: import → validate against checkout commit → use directly or rebuild; offline,
      deterministic. (`docs/shareable-bundle.md` CI recipe)

## 6. Tests
- [x] Round-trip: export → parse → materialize reproduces a content-identical graph that reconciles
      healthy (digest + counts). (proves the "identical index" property at graph-content granularity)
- [x] Stale import: ancestor commit → rebuild decision (verified e2e via a child-commit worktree).
- [x] Version skew: incompatible-schema / incompatible-bundle-version → rebuild reason.
- [x] Tamper: flipped payload byte → payload-digest mismatch.
- [x] Security (adversarial review): path-traversal payload name rejected at parse (no write);
      manifest/payload mismatch rejected; attestation missing digest / non-numeric counts rejected;
      corrupt-but-consistent db → degrades to rebuild (not a crash). e2e-verified + unit tests.

## 7. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (5258 passed; the 3 intermittent
      failures are the pre-existing property-based `memory-invariant` flake, unrelated — pass in
      isolation), `npm run build` green.
- [x] `export bundle --out` into a not-yet-existing directory creates the parent dir instead of
      throwing an uncaught `ENOENT`; the `.gitattributes` hint falls back to the `*.olbundle` glob
      when the artifact is written outside the repo (no meaningless `../…` pattern). Regression test
      added (`writes the artifact into a not-yet-existing --out directory`).
- [x] Dogfood: exported OpenLore's own index (22 files, 5.92 MB), imported into a fresh worktree at the
      same commit → verified `import-fresh`, 5728 nodes / 13958 edges, no re-analyze; ancestor-commit and
      diverged-commit worktrees → rebuild; corrupt/missing file → clean error.

## 8. Docs
- [x] Document export/import, validate-or-rebuild, the regenerate-don't-merge discipline, and the CI
      bootstrap recipe. (`docs/shareable-bundle.md`; `docs/cli-reference.md` entries)
