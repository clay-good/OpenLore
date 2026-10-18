# Complexity trend over git history — a rising/flat/falling label on the churn+complexity OpenLore already mines

> Status: SHIPPED (2026-10-18). Proposed 2026-07-03 (e2e audit pass 4, enhancement). OpenLore already computes
> per-function cyclomatic complexity (the CFG-overlay walk, `call-graph-complexity.ts`) and
> per-file churn/volatility (`get_change_coupling`, the `volatilityLevel` classifier). It only ever
> reports *current* complexity, so it can't answer the question hotspot analysis actually turns on:
> is this getting worse? repowise's `--trend` and the Code Health Meter's longitudinal signature
> both validate the shape — sampling complexity at a few historical commits per hotspot yields a
> descriptive trend label. This fits the `briefing_since` precedent exactly: a tier/label from
> existing evidence, no composite score, no new tuning constant.

## The gap

- Complexity is a snapshot. A function at complexity 20 that has been 20 for two years and one that
  climbed 8→20 over the last month are the same to every current tool, though the second is the
  real hotspot. The evidence to tell them apart — git history plus a deterministic complexity
  measure — is already in the box; nothing joins them over time.
- The `add-knowledge-map-and-coupling-upgrades` borrow (CodeScene) covers bus-factor/knowledge-loss
  and coupling noise, not complexity-over-time. This is the one genuinely new signal beyond that
  borrow.

## What changes

1. **Sample complexity at N historical commits per hotspot.** For a bounded set of hotspot files
   (high current complexity ∧ nonzero churn), re-parse the file at a few prior commits
   (deterministic: `git show <commit>:<path>` → the same complexity estimator) and compute a
   descriptive trend: `rising` / `flat` / `falling`, with the sampled points attached as raw
   evidence. Bounded sampling (a few commits, a capped hotspot set), disclosed — not a full-history
   walk.
2. **A `declining-health` governance finding** (registered code, advisory by default): a function
   whose complexity is both high AND rising over the sampled window. Emitted in the standard
   finding shape, so `enforce`/`enforcement.policy` can opt into gating on it.
3. **Honest withholding.** The trend label is withheld (not guessed) when history is too shallow to
   sample (fewer than N non-bulk commits touching the file), exactly as `briefing_since` withholds
   `surprising-change` on shallow history. No trend is claimed from one data point.

## Why this is in scope

Deterministic hotspot signals are the CodeScene-lineage capability OpenLore already committed to;
complexity trend is the missing time axis, computed from data it already mines, with the same
descriptive-label-not-score discipline as the rest of the classifier family. No ML, no calibration
corpus (unlike repowise's opaque 1-10 defect score, which this deliberately does not adopt).

## Impact

- Files: a small trend module reusing `call-graph-complexity.ts`'s estimator over
  `git show`-fetched historical file contents; the `get_change_coupling` / behavioral-hotspots
  surface (or `briefing_since`) to carry the label; `enforcement-policy.ts` (the `declining-health`
  code).
- Specs: `analyzer` — 1 ADDED (ComplexityTrendIsDescriptiveAndBounded).
- No new tool (extends an existing hotspot/coupling surface); the trend adds a bounded label +
  sample points per hotspot — measure against the payload budget. Risk: low-medium — the cost is
  the historical re-parses; keep the hotspot set and sample count capped and disclosed. Honest
  bound: git doesn't follow renames on a path-exact join (caveat as `briefing_since` does). Verify:
  a function that climbed in complexity reports `rising`; a stable one reports `flat`; a file with
  one commit of history reports no trend (withheld, not guessed).
