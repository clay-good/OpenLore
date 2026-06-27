# Test coverage gap report: surface important code with no reaching test, deterministically, no runtime

> Status: SHIPPED (2026-06-25) — `report_coverage_gaps` MCP tool (opt-in `--preset full`; full-surface
> tool count 65→66) + `openlore coverage-gaps` CLI. Inverts `select_tests` backward reachability over
> the whole graph; ranks by `landmark-signals` hub/chokepoint (no composite score); gaps-only
> soundness; also-dead vs untested-not-dead distinction; diff/region scope. Dogfooded on OpenLore
> (844/2484 gaps; the tested hub `estimateTokens` correctly ABSENT, the untested private helper
> `tokenCount` correctly surfaced). Dogfood caught + fixed an over-broad partial-detection caveat that
> named well-tested languages. See `tasks.md` (all checked).
>
> Status: HARDENED (2026-06-25, adversarial review round on PR #204). Fixed: (1) scoped denominators —
> `analyzedSymbols`/`reachableFromTest` now range over the in-scope set, not the whole repo, so a
> scoped call reads "1 gap of 1 analyzed"; (2) zero-resolution honesty — a diff/region scope that
> matches nothing returns an explicit `note` ("nothing matched", not a reassuring "0 gaps"); (3)
> `filePattern` echoed whenever applied (incl. layered on a diff); (4) `directResolvedOnly` threaded
> into `deadCodeIds` so `alsoFlaggedDead` shares the gap partition's edge basis; (5) fuzzy
> symbol-resolution caveat. +5 regression tests (13 total). Docs hardened: README cheat-sheet row +
> narrative + `docs/coverage-gaps.md` deep-dive + CLI example block; 7 stale "65" doc counts fixed
> (CLAUDE.md, install.md, agent-setup, cli-reference, cli/spec.md) and the doc-count guard broadened
> (hyphenated `N-tool` form + CLAUDE.md/install.md now guarded) so the class can't recur.
>
> Status: DRAFT (2026-06-24). Part of the `FEATURE-UPDATES.md` set. Adds a deterministic,
> graph-derived report of code with **no reaching test**, ranked by structural significance, as an
> opt-in conclusion tool. Reuses the existing backward-reachability test-selection path and the
> `landmark-signals` classifiers. No runtime coverage, no graph-schema change, no LLM. Decision to be
> recorded before code.

## Why

OpenLore can already answer the forward question — `select_tests` does backward reachability to find the
tests that reach a change. It cannot answer the equally useful inverse: **which important code has no
test reaching it at all?** That is the question a reviewer gating a PR asks ("is the risky part of this
change tested?"), an agent asked to "improve test coverage" needs answered to know where to start, and a
team auditing a codebase wants ranked rather than as a flat list. Today the only way to get coverage
information is to run the test suite under a coverage tool — slow, requires a working build and runtime,
and produces line-level noise rather than a structural, ranked answer.

The graph already contains the answer, deterministically. A function that is in the **backward-reachable
set of no test node** has no test exercising it through the call graph. Inverting the test-selection
reachability over the whole graph yields the set of structurally-untested functions for free, with no
runtime. The missing pieces are (a) computing the inverse set and (b) **ranking it by significance** so
the output is "the untested hubs and chokepoints" — actionable — rather than "5,000 untested leaf
functions" — noise. OpenLore has both the reachability machinery and the significance classifiers; it
has simply never composed them into this conclusion. A competitor surfaces dead-code and test edges
separately; none turns the graph into a *ranked untested-surface* answer.

## What changes

1. **A structural coverage-gap computation.** Over the whole indexed graph, the system computes the set
   of functions that are **not in the backward-reachable set of any test node** — i.e. no test
   transitively calls them. This is the exact inverse of the `select_tests` reachability, run once over
   the graph. It is deterministic and needs no test execution, no coverage instrumentation, and no
   working runtime.

2. **Ranked by significance labels (not a score).** The untested set is ordered using the same
   existing-classifier labels the rest of this set uses — `hub` (high fan-in), `chokepoint` (betweenness)
   — so untested **load-bearing** code floats to the top, while untested trivial leaves sink. Ordering is
   by label tier then raw fan-in (evidence), with no composite score and no new tuning constant, per the
   set-wide discipline. Each reported symbol carries its labels and raw evidence.

3. **Sound direction only — claim "no reaching test," never "tested" (honesty).** The report makes only
   the sound claim: a symbol with no reaching test definitely has a coverage gap. It SHALL NOT make the
   unsound inverse claim that a symbol *with* a reaching test is "tested" — structural reachability from a
   test means a test *can reach* the code, not that the test *asserts its behavior*. The report's contract
   is explicit about this: it finds gaps (the falsifiable, sound direction), and it discloses that
   "reachable from a test" is not "verified by a test." This is the same honesty posture as the
   confidence-boundary and authoritative-recall invariants.

4. **Honest exclusions.** Generated, vendored, and the test files themselves are excluded from the
   untested surface (a test helper need not be tested). Entry points and framework-invoked handlers, which
   have no in-repo caller, are NOT excluded merely for being uncalled — an untested entry point is a real
   gap — but the report labels *why* a symbol is untested (no reaching test) distinctly from *dead*
   (no caller at all, which is `find_dead_code`'s domain), so the two conclusions stay separate.

5. **One opt-in MCP conclusion tool, `report_coverage_gaps`** (and a CLI equivalent). Returns the ranked
   untested surface (symbol, labels, raw evidence), optionally scoped to a region or to the symbols a
   given diff touches ("is the risky part of *this change* untested?"). It is a conclusion — a ranked
   list with its soundness caveat — not a graph. Opt-in preset only.

## Decision

**Structural coverage from graph reachability, ranked by existing labels, claiming only the sound
direction.** The report defines "untested" as "no test node reaches it in the call graph" — a property
the graph already encodes — rather than executed-line coverage, which would require a runtime OpenLore
deliberately does not depend on. It accepts the precision limit honestly: structural reachability
over-counts "tested" (a reaching test may not assert behavior), so the tool reports only *gaps* (the
under-approximated, sound side) and never certifies the inverse. Ranking reuses the significance labels
to make the output actionable without introducing a score. If an internal coverage analyzer already
exists, this exposes its gap output as a ranked conclusion; otherwise it computes the inverse reachability
directly.

## Scope contract — do not break these things

This change must NOT:
- Claim a symbol is "tested" or "covered." It reports only "no reaching test" — the sound direction — and
  discloses that reachable-from-a-test is not behavior-verified.
- Require running the test suite, a coverage tool, or any runtime. Static graph reachability only.
- Introduce a composite significance score or a new tuning constant. Labels + raw evidence only.
- Conflate untested with dead. An uncalled-by-anyone symbol is `find_dead_code`'s concern; this reports
  has-no-reaching-test, labeled distinctly.
- Enter the minimal/first-run tool surface. The tool is opt-in. No graph-schema change.

## Out of scope (deferred)

Executed-line / branch coverage (requires a runtime — out of scope by design); test *quality* assessment
(does the reaching test actually assert anything); generating the missing tests (the existing
test-generator's job — this surfaces *where* to generate, not the generation); and cross-repo/federated
coverage gaps (single-repo first).

## Implementation status

Tracked in `tasks.md`. Verified by a fixture with a tested hub, an untested hub, and untested leaves
(the untested hub ranks top, leaves sink, the tested hub is absent), a soundness test (the tool never
reports any symbol as "tested"), an exclusions test (test/generated/vendored files excluded; an untested
entry point is still reported, labeled untested-not-dead), and a determinism test.
