# Test-coverage gaps — the untested surface, ranked, no runtime

`report_coverage_gaps` (MCP, opt-in `--preset full`) and `openlore coverage-gaps` (CLI) report
**important code that no test reaches**, ranked by structural significance. It is the deterministic,
graph-derived **inverse** of [`select_tests`](test-impact-selection.md): where `select_tests` walks
the call graph *backward* from a change to the tests that reach it, this walks *forward* from every
test to the reachable set, then reports the internal code **outside** it.

No test execution. No coverage instrumentation. No working runtime. No LLM. Deterministic — a fixed
graph yields a byte-identical report.

## What it answers

- "I was told to improve coverage — **where do I start?**" → the ranked untested hubs.
- "Is the **risky part of this change** untested?" → scope to a diff (`changedSymbols` / `diffRef`).
- "Audit this module's untested surface." → scope to a region (`filePattern`).

## How it works

1. **Seeds** = every test node, plus the production side of every `tested_by` edge (a function a test
   imports/asserts on is associated with that test even when it is not a direct call-graph caller).
2. **Forward reachability** (BFS over `calls` + inheritance + synthesized edges, same adjacency as
   `select_tests`) → the **test-reachable set**.
3. **Gaps** = internal code nodes (non-test, non-external/IaC, with generated / vendored / `.d.ts`
   paths excluded) **minus** the test-reachable set.
4. **Ranking** reuses the [`landmark-signals`](../src/core/analyzer/landmark-signals.ts) classifiers:
   load-bearing code (`hub` / `chokepoint`) ranks first, then by raw fan-in, then a stable
   file+name tiebreak. **No composite score, no tuning constant** — only labels and raw evidence.

## Honesty contract

- **Gaps-only — never "tested".** A symbol with no reaching test definitely has a gap (the
  falsifiable, sound direction). The report **never** claims a symbol *is* tested or covered:
  structural reachability from a test means a test *can reach* the code, not that any test *asserts*
  its behavior. That distinction is stated in every response's `soundness.caveats`.
- **Untested ≠ dead.** A gap that is *also* unreachable from any liveness root is labeled
  `alsoFlaggedDead: true` — that subset is [`find_dead_code`](reachability-dead-code.md)'s domain.
  An untested entry point (a live, framework-invoked root) is reported as a real gap, *not* dead.
- **A scope that matched nothing says so.** A `changedSymbols`/`diffRef`/`filePattern` that resolves
  to zero in-scope symbols returns an explicit `note` ("nothing matched", NOT "no coverage gaps"), so
  a typo'd symbol never reads as "my change is fully covered".
- **Scoped counts are scoped.** `analyzedSymbols` and `reachableFromTest` range over the *in-scope*
  set, so a scoped call's denominator matches its scoped gaps (never the whole repo behind one gap).
- **Partial test detection is disclosed.** When some languages have no detected test files, the report
  names *only* those languages (not the well-tested ones) and flags that their gaps may be
  over-reported. With no tests detected at all, `testDetection: "none"` says the surface looks
  untested because detection found nothing — not because the code is genuinely untested.
- **Over-report is the safe direction.** Dynamic dispatch, reflection, and DI can make a symbol
  reachable-by-test through an edge static analysis cannot see; such a symbol may be falsely reported
  as a gap. Pass `directResolvedOnly: true` to ignore synthesized edges and get a stricter (more
  gaps, more certain) report; the `alsoFlaggedDead` label is computed on the same edge basis.

## Distinct from `get_test_coverage`

`get_test_coverage` is a **spec/scenario tag-based** report (which OpenSpec scenarios have a tagged
test, via `generate_tests`). `report_coverage_gaps` is **pure call-graph structural reachability**.
They answer different questions and do not overlap.

## CLI

```bash
openlore coverage-gaps                              # whole repo, ranked
openlore coverage-gaps --max 50                     # cap the list (default 100, capped 500)
openlore coverage-gaps --file-pattern src/core/auth # region scope
openlore coverage-gaps --base main                  # diff scope: gaps among symbols changed vs main
openlore coverage-gaps --symbols parseConfig,login  # diff scope: only these changed symbols
openlore coverage-gaps --json                       # machine-readable (stable shape) for CI / an orchestrator
```

Read-only and advisory — it is a report and **never blocks**.

## Scope (single-repo, by design)

Cross-repo / federated coverage gaps are deliberately out of scope (single-repo first); the tool does
not take the `federation` flag. Executed-line/branch coverage (a runtime concern) and test *quality*
(does the reaching test actually assert anything) are also out of scope — this surfaces *where* a gap
is, deterministically, not whether an existing test is good.
