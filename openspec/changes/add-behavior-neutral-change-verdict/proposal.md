# Add behavior-neutral change verdict: prove the no-op half of a diff is a no-op

> Status: PROPOSED (2026-07-27, ecosystem research sweep). Per changed symbol, a deterministic
> verdict: `provably-neutral` (comments/formatting/optional-syntax only — normalized trees
> identical) vs `not-proven-neutral`. Downstream, blast radius and churn stop treating a
> prettier run as behavioral change. Prior art: structural no-op suppression in tree-sitter
> diff tooling (https://difftastic.wilfred.me.uk/;
> https://semanticdiff.com/docs/what-is-semanticdiff/).

## The gap

Every change-shaped conclusion treats "the bytes moved" as "the behavior moved."
`structural_diff`, `blast_radius`, `briefing_since`, and the churn/volatility classifiers all key
on changed symbols — so a reformat-only commit, a comment sweep, or a license-header pass lights
up the whole repo: full blast radius, full test selection, `hub-change` tiers in the briefing,
inflated churn history for every file it touched. The substrate already owns everything needed to
prove the opposite for the mechanical half: per-symbol spans, the merge-base old content
(`StructuralDiffReadsOldContentAtTheMergeBase`), the parsed trees, and a length-preserving
comment-stripping normalizer (`src/core/analyzer/comment-blanking.ts`) built for exactly this
kind of comparison.

## What changes

- **A per-symbol neutrality check inside `structural_diff`** (no new tool): parse the before and
  after spans of each changed symbol, drop comment nodes, normalize whitespace, compare the
  serialized trees. Byte-identical normalized trees ⇒ `provably-neutral`; anything else —
  including any parse error on either side — ⇒ `not-proven-neutral`. The claim direction is
  asymmetric by construction: `neutral` is only ever *proven*; the other class asserts nothing.
- **A closed, per-language normalization vocabulary**, started deliberately tiny: comments and
  whitespace only. Optional-syntax equivalences (trailing commas, redundant parens, quote style)
  are added one at a time, each behind its own conformance fixture, each listed in the disclosed
  vocabulary — never a heuristic bucket. Languages outside the loaded-grammar set fail soft to
  `not-proven-neutral` (`unsupported` disclosed, per the language-support discipline).
- **Consumers subtract the proven no-ops**: `blast_radius` and `select_tests` seeded by a diff
  exclude `provably-neutral` symbols (disclosed: "14 of 30 changed symbols proven neutral,
  excluded"); `briefing_since` labels them instead of tiering them; the churn join can
  optionally discount neutral-only commits (disclosed when it does).

Deliberately NOT borrowed from the diff-tooling lineage: diff *rendering* (no side-by-side view —
this is a verdict, not a viewer), move/rewrite detection heuristics, and any per-language
semantic model beyond the closed vocabulary (the prior art shows those get deep fast; an
unproven equivalence stays `not-proven-neutral`).

## Why this is in scope

The strongest possible form of the house honesty contract — a claim made only when it is a proof
— applied to de-noising every change-shaped conclusion at once. Deterministic, local, no new
artifact: computed live from spans + trees the substrate already holds.

## Impact

- Touches: `structural-diff.ts` (verdict + disclosure), a small normalizer module beside
  `comment-blanking.ts`, consumers (`blast-radius.ts`, `briefing-since.ts`, diff-seeded test
  selection) — each change is a labeled subtraction, never a silent one.
- No new tool; no tool-count change.
- Specs: `analyzer` — 1 ADDED requirement (the proof rule); `mcp-handlers` — 1 ADDED requirement
  (the consumer subtraction discipline).
- Risk: a false `neutral` is a soundness bug (mitigated: proof = normalized-tree byte equality
  only, closed vocabulary, per-language fixtures, parse-failure ⇒ not-proven); vocabulary creep
  (mitigated: the spec fixes the vocabulary as disclosed-and-closed; additions need fixtures).
