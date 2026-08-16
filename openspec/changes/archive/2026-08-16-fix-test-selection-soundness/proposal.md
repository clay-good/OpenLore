# select_tests soundness receipts: identity-keyed seed coverage, disclosed depth cap, disclosed substring widening

> Status: **BUILT** (2026-08-16). Extends `add-test-selection-safeguard-tiers`
> (pass 3) with receipts and correctness that change's tiers do not cover (its scope is the test's
> own file / brand-new tests): the sibling-test fallback is keyed on bare NAMES so a same-named
> function elsewhere shadows an untested seed; the backward walk's depth cap and the seed
> resolver's substring widening are both silent, while the sibling tool discloses each.

## The defect(s)

1. **Sibling-test fallback keyed on bare name membership.**
   `src/core/services/mcp-handlers/test-impact.ts:216-229` — the check deciding whether a seed
   already has a reaching test is
   `const seedHasTest = [...byTest.values()].some(t => t.viaPath.includes(s.name))` (`:218`):
   true if ANY selected test's path contains a node merely NAMED like the seed. Two functions
   named `render` in different files, only file A's reached by tests; file B's `render` changes →
   B's seed is deemed tested, the low-confidence same-file fallback never fires, and its honesty
   caveat (`:254-256`) is never emitted — B's sibling tests are omitted with no disclosure. The
   misnamed, dead `reachedSeedFiles` (built from `viaPath` names at `:216`, `void`ed at `:229`)
   is the fossil of the correct per-seed check.
2. **Undisclosed depth cap that contradicts the sibling tool.** The backward walk caps at
   `maxDepth ?? 12` (`test-impact.ts:104`) and stops expanding at the cap (`:159`), but no caveat
   ever says "reachability truncated at depth N" — even when the BFS frontier was non-empty at
   cutoff. Meanwhile `report_coverage_gaps`' `reachAll` is UNBOUNDED
   (`coverage-gaps.ts:66-84`), so the two tools can contradict each other on the same symbol: one
   13+ hops from its only test gets "may be genuinely untested" from `select_tests` (`:258`)
   while coverage-gaps counts it reachable-from-test. The tool agents act on (select, then run)
   under-selects silently.
3. **Silent substring widening of the seed set.** `seedsFromSymbols`
   (`test-impact.ts:62-65`) falls back from exact (case-insensitive) name match to SUBSTRING
   match with no receipt; `report_coverage_gaps` discloses this exact behavior
   (`coverage-gaps.ts:256-260` — "a short or partial symbol name may widen the scope"). A short
   symbol like `on` silently widens the seed set — and `blast_radius`'s composed selection with
   it — so the returned test list answers a different question than the one asked.

`add-test-selection-safeguard-tiers` adds always-select tiers, per-test reasons, and flakiness
disclosure; none of its tasks touch the seed-coverage predicate, the depth-cap receipt, or seed
resolution. This change is the complement; do not modify that change's files.

## What changes

- **Identity-keyed seed coverage.** Track which SEED each selected test actually reached — seed
  IDs recorded during the backward walk (the walk already knows the seed at depth 0 of each
  path), or minimally a `(file, name)` pair comparison — and key the fallback (and its caveat) on
  that. Delete the dead `reachedSeedFiles` fossil (`:216`, `:229`) as part of the fix.
- **Depth-cap receipt.** When the BFS frontier is non-empty at the cap, emit a
  `truncatedAtDepth: N` boundary field plus a caveat ("backward reachability truncated at depth
  N; deeper tests may exist — raise maxDepth or consult report_coverage_gaps"). The
  "may be genuinely untested" caveat (`:258`) is qualified by the truncation receipt when
  truncation occurred, so the two sibling tools stop contradicting each other undisclosed.
- **Substring-widening receipt.** When any seed resolved via the substring fallback, emit the
  same caveat `report_coverage_gaps` already ships (`coverage-gaps.ts:256-260`), naming the
  widened symbols. `blast_radius` inherits all three receipts through composition.

## Why this is in scope

`select_tests` is the substrate's action-driving conclusion — agents run exactly what it returns.
Decision `c6d1ad07` grounds every conclusion in static analysis with honest boundaries; here the
analysis is sound but its receipts are not: a name collision silently disables the one honesty
caveat built for untested seeds, and two disclosures the sibling tool already ships (unbounded vs
capped reach, exact vs substring seeds) are missing on the tool where they matter most. All fixes
are deterministic bookkeeping over the existing walk — no new algorithm, no new constant, nothing
blocking.

## Impact

- Files: `src/core/services/mcp-handlers/test-impact.ts` (seed-coverage tracking, truncation
  receipt, substring caveat, dead-code removal); tests alongside. `blast_radius` and the
  footprint/briefing compositions inherit the receipts.
- Specs: `mcp-handlers` — 2 ADDED requirements (SeedTestCoverageIsIdentityKeyed,
  TestSelectionBoundsAreDisclosed).
- Tool surface: unchanged (no new tool; response gains optional boundary fields within the
  existing payload budget).
- Risk: low. The fallback fires in strictly more (correct) cases — selections can only grow, at
  low confidence with the existing caveat; new fields are additive.

## Hardened in review

Three independent adversarial passes tightened the implementation without changing its scope:

- Seed coverage is computed only inside the existing impacted subgraph, avoiding a second
  repository-wide traversal while preserving node-identity semantics.
- `blast_radius`, `briefing_since`, impact certificates, and review output preserve the new
  receipts in both structured and human-readable forms, including zero-test results.
- Empty symbol names are rejected, substring receipts show a bounded sample and point to the full
  seed list, and the shared response cap preserves selection-boundary receipts.
