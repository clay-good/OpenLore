# Tasks — refine-first-run-partial-serving

## Implementation
- [x] Partial index module (`src/core/runtime/partial-index.ts`): flush, re-stamp, read, clear,
      and the receipt. Written OUTSIDE the analysis directory (`.openlore/runtime/partial-analysis/`)
      so no artifact reader, exporter, attester, or fingerprint can see it; each flush commits
      through the same `publishGeneration` content-digest primitive the real analysis uses, and
      the receipt is written AFTER the commit so a half-written flush is unobservable
- [x] Flush lane in `analysis-core.ts`: one flush at the extractors boundary, `buildPhase`
      re-stamped on the artifacts heartbeat, armed only when the caller opts in AND neither a
      published generation nor an analysis artifact exists. Wholly fail-soft — composing the
      flush is inside the boundary, not just writing it
- [x] Lane gating: `--partial-serving` (hidden) passed by the background auto-init build,
      default-on for an interactive `openlore analyze`, off under `--embedded`/CI and for the API
- [x] Serve the facts: `readDependencyGraphOrPartial` / `readAnalysisArtifactOrPartial` fall back
      to a live partial index only after the published read returns null, so a repository with an
      index pays nothing. Wired into `get_architecture_overview`, `get_file_dependencies`, and
      orient's architecture-rule scan
- [x] Absent-case context serving in `readCachedContext`, only when no analysis artifact is
      present — never masking one that failed a gate — and failing closed by discarding any
      call-graph-shaped field a partial context carries
- [x] Receipt attached in `dispatchTool`, below the handlers and above the transports, so stdio
      MCP, the serve daemon, every CLI wrapper and the API all carry it. Request-scoped
      (`AsyncLocalStorage`), so a concurrent daemon can never attribute one request's partial
      answer to another request's complete one
- [x] Not-ready results consult the receipt too: a tool that cannot answer says the build is
      running rather than telling the caller to start it
- [x] Negative-conclusion guard: `find_dead_code` and `report_coverage_gaps` withhold and cite
      the partial boundary
- [x] Export refuses a partial index explicitly (`BundleError` `partial-index`), keyed on "live
      partial AND nothing published" so a failed cleanup cannot block export of a complete index
- [x] Read as untrusted repository content, including the generation-manifest reads that verify
      it (`readCurrentGeneration` / `digestOf` used a plain `readFile` and ran FIRST, defeating
      every later ceiling). The shared bounded reader moved to a leaf module and gained
      `O_NONBLOCK`: `O_NOFOLLOW` refuses a symlink but a FIFO is not a symlink, and opening one
      read-only blocks inside `open()` on a libuv worker that `process.exit` cannot interrupt —
      reproduced as an unkillable hang, now refused. A pre-existing hole in the serving hot path
- [x] Write and delete confined by REAL path: `.openlore/runtime` can be a committed symlink, and
      Node resolves symlinked directory components — so the cleanup, which runs after EVERY
      successful analyze including CI and `--embedded`, deleted recursively wherever it pointed
- [x] No repository-supplied text in the server's voice: the receipt's "does not yet hold" list
      is owned by the reader, `buildPhase` is validated against a known set, and the stamp is
      bound to the analysis directory it was written for
- [x] Honest dependency graph: the flush is skipped when the import-derived graph has no edges,
      because on a language whose graph is built from synthesized call edges (Swift, C, C++) it
      would answer "no dependencies" for every file as an ordinary positive result; the receipt
      names the edges as a lower bound
- [x] Deleted rather than kept: the `ConfidenceBoundary.partial` marker (it sent the same
      paragraph a third time on a withheld answer and no positive answer ever carried it) and the
      import-side bundle check (a bounded prefix scan cannot decide a question about
      attacker-chosen key order; the structural argument stands on its own)
- [x] Honest receipt: no completeness percentage (the honest denominator is the call-graph pass,
      which has not started); `phase` describes the FACTS and only `buildPhase` moves with the
      heartbeat, so the index cannot advertise a completeness its bytes do not have
- [x] Completion path: publish first, then clear — unconditionally, so an index leaked by a
      killed run is collected by the next successful analyze whether or not that run armed the lane

## Verification
- [x] Facts test: `get_architecture_overview` mid-build answers with the real file, cluster and
      edge counts from the flushed graph — the regression guard for the zeroed answer
- [x] Transport test: `dispatchTool` attaches the receipt to an answered call and to a
      not-ready call, and attaches nothing when no partial index exists
- [x] Integrity tests: tampered bytes, uncommitted bytes, a dead owner, an unrefreshed stamp, a
      future-dated stamp, a malformed stamp, and a failed commit are each refused
- [x] Hardening test: graph-shaped fields are discarded from a partial context
- [x] Precedence test: a present analysis artifact is never masked by a partial index
- [x] Resurrection test: a late stamp refresh after cleanup cannot recreate a live partial index
- [x] Negative-guard test: `find_dead_code` / `report_coverage_gaps` withhold and cite the
      boundary
- [x] Convergence test: flushing and non-flushing builds produce byte-identical artifacts, with
      a NON-VACUITY assertion that the flushing run actually flushed
- [x] Guard tests: export refused mid-first-build, and allowed for a published index even when a
      partial one survived cleanup
- [x] Fail-soft test: an unwritable partial location produces no index, no throw, and a normally
      published analysis
- [x] Bounded-read tests: a symlink, a directory, and a FIFO are each refused rather than
      followed, read unbounded, or blocked on
- [x] Untrusted-text tests: a repository cannot supply the receipt's prose, an out-of-set
      `buildPhase` is refused, and a partial index written for another repository is refused
- [x] Confinement test: a symlinked `.openlore/runtime` makes the flush refuse and leaves the
      symlink's target untouched by the cleanup
- [x] Cold-path tests: `orient` (which refuses BEFORE reading the context, so the request-scoped
      receipt cannot cover it) and a handler returning a bare `{error}` both carry the receipt
- [x] Verified end to end on a real first run of this repository: 2.5s into a 15s build, the
      architecture overview answered with 1293 files / 82 clusters / 4285 edges and the full
      receipt, the not-ready call carried the same receipt, and the partial index was gone on
      completion
- [x] Full suite green (unit, equivalence, integration, lint, typecheck)

## Spec
- [x] `architecture` delta: ADD FirstRunServesPartialWithACompletenessReceipt

## Deliberately not built
- [x] A partial CALL GRAPH. Pass 1 extracts every file before the merge and resolution passes
      run, so a mid-pass flush would have to re-run merge+resolution over a prefix — extra work
      on every build, and a second code path through the machinery the determinism oracle guards.
      The receipt therefore NAMES the call graph and the search index as not yet built rather
      than implying it has them, and `orient` (which gates on the search index) keeps returning
      not-ready — now with the build's progress instead of a dead end. Recorded here so a later
      change starts from the reason, not the gap.
