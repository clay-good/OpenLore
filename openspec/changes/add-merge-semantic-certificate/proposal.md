# Add merge semantic certificate: two branches that merge cleanly can still disagree

> Status: PROPOSED (2026-07-27, ecosystem research sweep). `certify_merge`: a deterministic
> verdict on whether two branches are structurally compatible — the "git merges cleanly, the
> combination is broken" failure that textual merge cannot see. Completes the coordination arc:
> `plan_parallel_work` (before dispatch) → `map_in_flight_conflicts` (in flight) →
> **certify_merge (at landing)**. Trend evidence: one-worktree-per-agent is the dominant 2026
> fleet pattern, and its canonical failure is exactly this cross-branch semantic skew
> (https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace).

## The gap

Every existing OpenLore coordination conclusion reasons about *footprint overlap*: WAW /
shared-append / RAW hazards from write-set intersection (`interference-map.ts`), and the open
`add-merge-tree-conflict-oracle` adds "will git textually conflict." None of them catches the
disjoint-footprint failure: branch A adds a call to `parseConfig` assuming today's signature;
branch B — touching entirely different files — renames a parameter, narrows its type, or deletes
the export. Each branch is green alone; the merge is green textually; the combination is broken.
The classifier that decides exactly this question already exists — `certify_public_surface`'s
closed `breaking | non-breaking | potentially-breaking` rules
(`src/core/analyzer/public-surface.ts:40-41`, conservative by construction) — but it only ever
compares one diff against one base, never two diffs against each other.

## What changes

A new `certify_merge` conclusion tool (opt-in `coordination` preset) + `openlore certify-merge
--ours <ref> --theirs <ref> [--base <ref>]` CLI:

- **Inputs**: two refs; base defaults to their merge-base, resolved via the shared
  `resolveBaseRefDisclosed` discipline (bad base → fatal for a certification, per the CLI
  conclusion-honesty rule).
- **Cross-join, both directions**: symbols whose signature/export A changed (the existing
  breaking-change rules) × call/import edges B *added or retained* into them — and vice versa.
  Renames resolve through symbol-identity continuity before comparison, so a rename with a
  complete in-branch caller migration is not a false conflict; a caller added by the *other*
  branch to the old name is.
- **Verdict per finding**: `incompatible` (B calls a symbol A removed; added required parameter
  at a B call site with the old arity) or `potentially-incompatible` (narrowed types and
  everything unprovable — never silently compatible), each with the two commits, the edge, and
  the classification rule as the receipt. Overall: a certificate in the
  `change_impact_certificate` shape, with a `merge-semantic-conflict` finding code registered in
  `FINDING_CODE_REGISTRY` so a merge queue can gate via `enforcement.policy` (advisory default).
- **Honest boundaries**: unresolved dynamic dispatch, unindexed languages, and diff-fetch
  failures are disclosed as not-assessed (the `map_in_flight_conflicts` "never 'no conflict'"
  rule); the verdict is a sound lower bound — "no *detected* incompatibility," never "safe."

Deliberately NOT borrowed: merge-queue orchestration itself (ordering/landing stays with the
forge; OpenLore only certifies), and any test-running or build-running probe of the merged tree.

## Why this is in scope

Pure graph diffing over machinery that already exists (hazard vocabulary, breaking-change
classifier, continuity, merge-base structural diff per
`StructuralDiffReadsOldContentAtTheMergeBase`) — no LLM, local, conclusion-shaped. It closes the
one coordination phase the substrate doesn't cover, with the cross-reference discipline:
`add-merge-tree-conflict-oracle` answers "will git conflict"; this answers "what breaks when it
doesn't" (NoRedundantConclusions — each names the other as sibling).

## Impact

- New: cross-branch join module (reusing `public-surface.ts` classification + continuity +
  merge-base diff), `certify_merge` handler + CLI. Registered in `TOOL_CAPABILITY_FAMILY`
  (`coordinate`), classified `conclusion` in `tool-contract.ts`; tools/list payload budget
  re-asserted or consciously bumped.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: cost of materializing two branch graphs (mitigated: hash-keyed Pass-1 memo makes
  re-parse touch only changed files; scope is the union of the two diffs, not the repo);
  false-conflict noise on renames (mitigated: continuity resolution first, and the conservative
  class is `potentially-incompatible`, clearly labeled).
