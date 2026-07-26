# Workspace shards and a portable warm cache: a monorepo stops paying for the whole repo on every analyze

> Status: PROPOSED (2026-07-25, known-limitations closure #5 of 6). "Large monorepos may take
> several minutes to `analyze`" is the README's plainest limitation, and the in-flight work
> attacks it by making the *pipeline* faster — a parallel extraction pool (shipped), a
> content-hash memo of Pass-1 (shipped), single-pass tree reuse, incremental early cutoff,
> partial serving. All of those make the same unit of work cheaper. This change attacks the
> **unit of work itself**: a monorepo is not one program, it is N packages, and OpenLore has
> no concept of a package. Analyze the shard you touched, keep the cross-shard edges, and let
> a *portable* warm cache carry Pass-1 facts between machines and CI runs — the discipline
> every monorepo build tool converged on a decade ago.

## The gap

- **There is no notion of a package anywhere in the analyzer.** No `workspaces`, `packages/`, or
  monorepo handling exists in the file walker, the config manager, or the constants — the
  repository is one flat corpus bounded only by `includePatterns` / `excludePatterns` and
  `DEFAULT_MAX_FILES = 100_000` (`src/core/services/config-manager.ts:100-102`,
  `src/constants.ts:160`). A 40-package monorepo where one package changed re-walks all 40.
- **The Pass-1 memo is explicitly machine-local.** `pass1-fact-cache.ts:39` states it plainly:
  "No cross-machine cache sharing and no dependency graph of derived queries." That is the right
  conservative first step, and it means a CI runner starts cold on every job, and every engineer
  on a team pays the same first-analyze independently — the cost is multiplied by the size of the
  team and the CI matrix, which is exactly the population that has a monorepo.
- **Path-based scoping exists but is unsound for a graph.** A user can already point analyze at a
  subdirectory with include patterns, but doing so silently amputates cross-package edges: calls
  into the excluded packages resolve to `external::` or vanish, so a scoped analyze produces a
  *different, quietly wrong* graph rather than a smaller correct one. There is no supported way to
  say "recompute this package, keep everything else."
- **The prior art is unanimous and old.** Bazel, Buck2, Nx, Pants, and Turborepo all converge on
  the same three primitives: a **package/target graph**, **content-addressed caching**, and
  **only rebuild what a change can reach** (comparison at https://monorepo.tools/compare;
  Turborepo's content-addressed remote cache and Nx Cloud's cache-plus-distribution are the
  mainstream instances). OpenLore already has the hardest of those three — a content-addressed
  fact cache with a purity-stamped key. It is missing the package graph and the portability.

## What changes

**1. Workspace shards, detected — never configured by hand first.** Analyze detects package
boundaries from manifests already present in the repository (npm/pnpm/yarn `workspaces`, Cargo
`members`, Go modules, `pyproject.toml`, Gradle/Maven modules) and treats each as a **shard**:
a named subset of files with a declared root. Detection is deterministic and reported; an
explicit `workspace.shards` config block overrides it, and a repository with no detectable
packages is exactly one shard — i.e. today's behavior, byte-identically.

**2. Shard-scoped analyze that stays a whole graph.** `openlore analyze --shard <name>` (and the
automatic selection of affected shards from a diff) recomputes only that shard's files, then
**re-resolves the cross-shard edge frontier**: edges whose caller or callee lies in the
recomputed shard. Everything outside the frontier is retained from the store, unmodified. The
soundness obligation is stated in the spec and enforced in test: *a shard-scoped analyze SHALL
produce the same graph as a full `analyze --force` for the recomputed shard and its frontier, and
SHALL mark anything it could not reconcile explicitly stale* — the same converge-or-flag contract
the incremental watcher already lives under, applied at shard granularity. It never silently
narrows the graph, which is what a naive include-pattern scope does today.

**3. A portable warm cache.** The Pass-1 fact cache gains an **export/import** path: its entries
are already keyed by content hash plus an extractor-purity stamp, so they are inherently portable
to any machine running the same OpenLore version. `openlore cache export/import` writes and reads
a single content-addressed archive (reusing the shipped `.olbundle` validate-or-rebuild
discipline), so CI restores it as an ordinary build-cache artifact and a new engineer's first
analyze is warm. Trust rules are inherited, not invented: a mismatched purity stamp, a mismatched
schema version, or a corrupt entry is **ignored and recomputed**, never served — the same posture
`harden-bundle-import-trust` established for graph bundles. No server, no network protocol, no
hosted service: OpenLore writes a file, and the user's existing cache infrastructure moves it.

**4. Honest reporting of what was skipped.** Every shard-scoped analyze reports the shards it
recomputed, the shards it retained, the frontier size, and any region it marked stale — so a
partial analyze is never mistaken for a full one, and `openlore status` shows per-shard freshness.

**Explicitly NOT built:** distributed/remote *execution* (only cache transport); a hosted cache
service; a build-system integration or plugin (Bazel/Nx rule authoring is a user's job, and
`openlore analyze --shard` is the primitive it would call); cross-repository sharding (that is
federation, already shipped); and any change to the single-package path, which must stay
byte-identical.

## Why this is in scope

Sequencing note: this change is complementary to, and should land after, the pipeline-cost work
(`optimize-parallel-extraction-pool`, `optimize-analyze-pipeline-passes`,
`optimize-incremental-and-coldstart-scale`, `refine-first-run-partial-serving`). Those reduce the
cost of analyzing N files; this reduces N, and amortizes the remainder across a team and a CI
matrix. Both are needed: at monorepo scale, a constant-factor win still leaves minutes on the
table, and the "strong fit" audience named in the README's own qualification table — large,
polyglot, private codebases — is disproportionately the audience running a monorepo.

## Impact

- **Files:** a `workspace-shards.ts` detector (manifest readers, deterministic ordering), shard
  awareness in the file walker and analyze pipeline, frontier re-resolution in the call-graph
  builder, per-shard attestation/freshness in the store and `openlore status`, an export/import
  path on `pass1-fact-cache.ts` plus an `openlore cache` command, config
  (`workspace.shards`), and `docs/cli-reference.md` / `docs/ci-cd.md` / `docs/configuration.md`.
- **Specs:** `analyzer` — 2 ADDED (WorkspaceShardsAreDetectedDeterministically,
  ShardScopedAnalyzeConvergesOrMarksStale); `cli` — 1 ADDED
  (PortableFactCacheIsContentAddressedAndTrustChecked).
- **Tool surface:** unchanged — no new MCP tool. Two CLI additions (`analyze --shard`,
  `openlore cache export|import`).
- **Backward compatibility:** a repository with no detectable packages is one shard and takes the
  existing code path; the single-shard graph must be byte-identical to today's.
- **Risk:** (a) *an unsound scoped graph* — the central risk, mitigated by the
  converge-or-flag obligation, an equivalence test against `analyze --force` on multi-package
  fixtures, and explicit stale marking for anything unreconciled. (b) *a poisoned imported cache*
  — mitigated by inheriting the existing purity-stamp and validate-or-rebuild trust rules, with
  an ignore-and-recompute default and a documented `--force` bypass. (c) *shard detection
  misreading a repository* — mitigated by deterministic manifest-only detection, a reported
  shard list, a config override, and the single-shard fallback.
