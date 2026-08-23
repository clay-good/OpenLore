# Tasks — add-edit-loop-breakage-verdict

> Status: BUILT (2026-08-23). Final repository gates are tracked below.

## Implementation
- [x] `argCount` (+ lower-bound marker for spread/splat) on `RawEdge`/`CallEdge`
      (`call-graph-types.ts:47-55`, `:144-163`), captured in the TS/JS/Python extractors at the
      call node; absent elsewhere; persisted through the EdgeStore and SCIP moniker path
      (retire the `moniker.ts:154-156` TODO)
- [x] Verdict derivation in `mcp-watcher.ts` after the full coalesced atomic swap: diff
      `oldNames`/old signatures vs new nodes; broken references from surviving resolved edges;
      arity check per the provable-only rule; import-breakage from the import facts; reaching
      tests by exact ID from the retained full-analysis graph, with its basis disclosed
- [x] Verdict store beside the artifacts (atomic write, generation/content/basis hashes,
      latest-per-file retention, bounded reads/writes)
- [x] `check-edit` command: default read + `--json`; `--hook` with the impact-certificate
      discipline (`impact-certificate.ts:162-181` — never block on infra, stderr rendering,
      opt-in blocking via `enforcement.policy`); missing/stale/invalid state is disclosed and
      fails open because `structural_diff` cannot reproduce the same proof facts
- [x] Register `edit-broken-reference` / `edit-arity-mismatch` / `edit-import-breakage` in
      `FINDING_CODE_REGISTRY` (advisory defaults, source-declared severity, remediation-ready
      messages naming the caller sites)
- [x] Opt-in hook install in `setup.ts` (PostToolUse-shaped; never reintroduce analysis inside
      the hook — read-only)

## Verification
- [x] Debounce-to-verdict test: delete an exported function with two callers → verdict names
      both `file:line` after one watcher flush; `check-edit` serves it with no re-parse
- [x] Arity honesty fixtures: only a TypeScript/Python old-compatible to new-provably-incompatible
      transition fires; defaults / variadics / spread / overloads / JavaScript / heuristic
      bindings are silent; spread lower-bound never treated as exact
- [x] Import-breakage tests: exact aliases and re-exports are modeled; unresolved star exports
      are silent; a same-batch producer/consumer repair does not fire
- [x] Hook-discipline tests: infra failure exits non-blocking; blocking only when policy
      classes a code blocking; stderr contract
- [x] False-positive budget: run representative non-breaking transition fixtures covering
      comments, separators, receivers, overloads, same-line calls, aliases, re-exports,
      concurrent batches, stale closure, and weak bindings — zero unsupported findings
- [x] Four adversarial multi-agent review loops: soundness, storage, CLI/hook, race, security,
      scale, and production analyze-to-watcher behavior
- [x] Real built-CLI E2E: watcher findings, same-batch repair, policy blocking, malformed-input
      fail-open, stale-closure disclosure, and clean follow-up
- [x] Full suite green: typecheck, lint, build, 8,356 unit tests, 346 equivalence/incremental
      tests, 189 integration tests, API consumer smoke, dependency audit, and package audit

## Spec
- [x] `analyzer` delta: ADD CallSitesCarryArgumentCounts
- [x] `mcp-handlers` delta: ADD EditVerdictIsDerivedAtPatchTime
- [x] `mcp-handlers` delta: ADD EditVerdictNeverGuessesIncompatibility
