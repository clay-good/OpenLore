# Tasks — add-edit-loop-breakage-verdict

## Implementation
- [ ] `argCount` (+ lower-bound marker for spread/splat) on `RawEdge`/`CallEdge`
      (`call-graph-types.ts:47-55`, `:144-163`), captured in the TS/JS/Python extractors at the
      call node; absent elsewhere; persisted through the EdgeStore and SCIP moniker path
      (retire the `moniker.ts:154-156` TODO)
- [ ] Verdict derivation in `mcp-watcher.ts` after the atomic swap (`:629-653`): diff
      `oldNames`/old signatures vs new nodes; broken references from surviving resolved edges;
      arity check per the provable-only rule; import-breakage from the import facts; reaching
      tests via the existing `select_tests` reachability scoped to edited symbols
- [ ] Verdict store beside the artifacts (atomic write, content-hash key, latest-per-file)
- [ ] `check-edit` command: default read + `--json`; `--hook` with the impact-certificate
      discipline (`impact-certificate.ts:162-181` — never block on infra, stderr rendering,
      opt-in blocking via `enforcement.policy`); daemon-absent fallback = one-file scoped
      `structural_diff` computation, disclosed
- [ ] Register `edit-broken-reference` / `edit-arity-mismatch` / `edit-import-breakage` in
      `FINDING_CODE_REGISTRY` (advisory defaults, source-declared severity, remediation-ready
      messages naming the caller sites)
- [ ] Opt-in hook install in `setup.ts` (PostToolUse-shaped; never reintroduce analysis inside
      the hook — read-only)

## Verification
- [ ] Debounce-to-verdict test: delete an exported function with two callers → verdict names
      both `file:line` after one watcher flush; `check-edit` serves it with no re-parse
- [ ] Arity honesty fixtures: required-param mismatch fires; defaults / variadics / spread /
      overloads / non-scope languages are silent; spread lower-bound never treated as exact
- [ ] Import-breakage test: removing an export consumed elsewhere fires; renaming with an
      updated consumer does not
- [ ] Hook-discipline tests: infra failure exits non-blocking; blocking only when policy
      classes a code blocking; stderr contract
- [ ] False-positive budget: run the derivation across this repo's full git history sample —
      zero findings on non-breaking commits (the provable-only rule holds in the wild)
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD CallSitesCarryArgumentCounts
- [ ] `mcp-handlers` delta: ADD EditVerdictIsDerivedAtPatchTime
- [ ] `mcp-handlers` delta: ADD EditVerdictNeverGuessesIncompatibility
