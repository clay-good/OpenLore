# Tasks — add verification feedback loop

## Implementation
- [ ] Diff resolution: working-tree or `--staged` against a base from `resolveBaseRefDisclosed`;
      fatal on a bad base
- [ ] Composition layer: run `blast_radius`, `select_tests`, `check_spec_drift`,
      `certify_public_surface`, and `structural_diff` (deprecatedCalls + footprint escapes) over
      the diff's changed/reachable symbols; map each result into a common receipt item
      `{ subject, producingCheck, severity, nextAction }`
- [ ] Ordering + budget: severity-rank items, apply the whole-response budget, disclose the
      truncated count; never drop a higher severity for a lower one
- [ ] Versioned receipt schema (documented) so a hook/CI/agent can consume it mechanically
- [ ] Reuse the finding codes the component checks already register; invent none; advisory by
      default, gateable via `enforcement.policy`
- [ ] `verify_change` MCP handler (`verify` preset; family `verify`; class `conclusion`; sibling
      cross-reference to each composed tool) + `openlore verify-change [--base <ref>] [--staged]
      [--json]` + an opt-in pre-landing gate hook

## Verification
- [ ] Fixture: surface narrowing + deprecated call + spec drift → one receipt, surface break
      ranked first, each item carries subject/check/severity/next-action, tests-to-run named
- [ ] Oversized diff → budgeted receipt with disclosed omitted count; no higher severity dropped
      for a lower one
- [ ] Unresolvable `--base` → fatal verification with disclosed reason, not a fallback verify
- [ ] Clean diff → empty receipt that still discloses what it could not assess (unindexed files,
      dynamic-dispatch boundaries inherited from the component tools)
- [ ] The tool runs no tests and writes no files (grader-not-author guarantee)
- [ ] tools/list payload budget re-asserted or bumped with rationale

## Spec
- [ ] `mcp-handlers` delta: ADD ChangeVerificationReceiptIsComposedAndActionable
