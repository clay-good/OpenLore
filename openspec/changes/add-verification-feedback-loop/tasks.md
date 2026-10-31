# Tasks — add verification feedback loop

> Composition note (as built): `blast_radius` already composes `select_tests` (tests to run) and
> the spec/memory/decision drift passes, so `verify_change` reaches those transitively through one
> `blast_radius` call, then adds `structural_diff` (removed/re-signed functions, deprecated calls).
> `certify_public_surface` is the one named conclusion not yet folded in — a remaining task; the
> change stays open until it lands.

## Implementation
- [x] Diff resolution: via `blast_radius`/`structural_diff`, base resolved through
      `resolveBaseRefDisclosed`; an unresolvable base returns an error, never a partial pass
- [x] Composition layer: `blast_radius` (affected callers/layers/hubs + tests to run + spec drift,
      transitively `select_tests` + `check_spec_drift`) and `structural_diff` (removed/re-signed
      functions, `deprecatedCalls`) → common receipt item `{ subject, check, severity, nextAction }`
      (`verify-change.ts`, pure `projectVerifyReceipt`)
- [x] Ordering + budget: severity-rank items, cap with a disclosed `truncated` count; never drop a
      higher severity for a lower one
- [x] Documented receipt shape so a hook/CI/agent can consume it mechanically
- [x] Reuses the component checks' signals; invents no finding code; advisory (grader-not-author:
      runs no tests, edits no files)
- [x] `verify_change` MCP tool + dispatch wiring; `verify` preset membership + token budget
      re-baselined; `change` family + `conclusion` class + epistemic-lease weight; full-surface
      tool-count docs updated
- [ ] Fold in `certify_public_surface` (explicit breaking-export verdicts with affected consumers)
- [ ] `openlore verify-change [--base <ref>] [--staged] [--json]` CLI + opt-in pre-landing gate hook
      (today the capability ships as the MCP tool; the CLI + `--staged` are the remaining surface)

- [ ] Speculative `patch` input (addendum 2026-10-31): parse a unified diff, apply in memory to the
      current file contents (new files allowed within include patterns), build from the patched
      in-memory file list through the on-disk Pass-1 cache, compose every check over it; `speculative: true` + patched-file list in the
      receipt; non-applying hunk / out-of-corpus file / over-cap patch → fatal with reason; never
      writes to disk

- [ ] Addendum 2026-10-31: compose `check_architecture` violations whose edges the diff adds (not
      pre-existing ones); `secret-added` finding over added lines via `secret-redaction.ts` patterns
      (registered, advisory, value never echoed); receipt sections for the contract / weakening /
      phantom / generated families as each ships

- [ ] Reword `nextAction` strings (`verify-change.ts`) as facts naming the check or file ("tests to
      re-run: …", "consumers of the narrowed export: …"), not orders, so hooks can push them under
      the neutral-wording rule (decision 8e95746d)

## Verification
- [x] Projection test: risk + removed fn + spec drift + deprecated call → one severity-ranked
      receipt, each item carries subject/check/severity/next-action, tests-to-run named
      (`verify-change.test.ts`)
- [x] structural_diff failure → disclosed boundary, no crash
- [x] tests-unavailable surfaced honestly (not conflated with "no tests")
- [x] base-ref fallback + index staleness disclosed as boundaries
- [x] item cap holds
- [x] tool-registration guards green (tool-contract, honesty-contract budget, doc-claim-sync,
      mcp-tool-count-doc, epistemic-lease)
- [ ] CLI + gate-hook tests (with the remaining CLI surface)
- [ ] Speculative patch: a patch that removes a called function yields the same receipt items as the
      same edit written to disk; the working tree is byte-identical before and after; a hunk that
      does not apply fails the verification with the hunk named

## Spec
- [ ] `mcp-handlers` delta: ADD SpeculativePatchIsGradedInMemory
- [ ] `mcp-handlers` delta: ADD DiffScopedRuleAndSecretFindings
- [x] `mcp-handlers` delta: ADD ChangeVerificationReceiptIsComposedAndActionable (MCP tool;
      `certify_public_surface` fold-in and the CLI/`--staged` surface remain, so the change stays
      open until they land)
