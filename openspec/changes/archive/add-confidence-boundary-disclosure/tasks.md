# Tasks — Confidence-boundary disclosure

> Status: IMPLEMENTED 2026-06-18 (branch `feat/confidence-boundary-disclosure`). Decision `08e71184`
> recorded the response shape before coding (API contract, per `CLAUDE.md`). Shared computation lives
> in `src/core/services/mcp-handlers/confidence-boundary.ts`; the seven conclusion handlers spread a
> `confidenceBoundary` field. Verified end-to-end against this repo's own graph (468 `cha-name-only`
> synthesized crossings disclosed on `find_dead_code`; staleness named commit + 7 changed files).

## 1. Boundary computation (deterministic)
- [x] Compute a `confidenceBoundary` for reachability/impact/path/dead-code: counts of direct vs.
      synthesized (by rule) edges traversed, plus known-unknowable crossings (synthesized-dispatch;
      `unindexed-repo` kind reserved for federation). Reuses `confidence`/`synthesizedBy`.
- [x] Test: an answer that traverses only direct edges reports a clean (`complete: true`) boundary;
      one that crosses a synthesized-dispatch site reports a known-unknowable crossing.

## 2. Proactive blind-spot flags
- [x] Attach an actionable flag when an answer leans on a recovered-heuristic dispatch boundary
      ("recovered by the \"<rule>\" rule … verify before asserting"). No LLM.
- [x] Test: `find_dead_code` whose liveness rests on a synthesized edge is flagged with a
      known-unknowable crossing, and the answer is marked `complete: false`.

## 3. Staleness boundary
- [x] When graph-relevant source changed since the index's build commit, attach "computed against the
      index built at commit X; N source file(s) changed since." Git-diff based against the build commit
      captured into `fingerprint.json` at analyze time; stays silent (no false positive) for a non-git
      repo or an index with no captured commit.
- [x] Test: `buildStalenessMarker` emits only when a commit + a positive source-change count are known;
      a current index (0 changed) and the non-git / no-commit cases stay silent.

## 4. No-false-completeness contract + docs
- [x] Guard: `confidenceBoundary.complete` is `false` whenever the answer leaned on a synthesized
      edge, crossed a known-unknowable boundary, or ran against a stale index.
- [x] Document the boundary field and contract in `mcp-handlers` + `mcp-quality` specs.
