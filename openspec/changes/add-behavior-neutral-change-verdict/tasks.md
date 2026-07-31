# Tasks — add behavior-neutral change verdict

## Implementation
- [ ] Normalizer module (beside `comment-blanking.ts`): strip comment nodes, normalize
      whitespace; serialize trees for byte comparison; closed per-language vocabulary table,
      disclosed in output
- [ ] `structural_diff`: per changed symbol, parse before (merge-base content) and after spans;
      `provably-neutral` iff normalized trees byte-identical; parse error on either side ⇒
      `not-proven-neutral`; unloaded grammar ⇒ `unsupported`, not-proven
- [ ] Consumers: diff-seeded `blast_radius` / test selection exclude proven-neutral symbols with
      the count disclosed; `briefing_since` labels instead of tiers them
- [ ] Optional churn discount for neutral-only commits, disclosed when applied

## Verification
- [ ] Reformat-only fixture (per loaded grammar): every changed symbol proven neutral; blast
      radius empty with the subtraction disclosed
- [ ] One-token behavioral change amid a reformat → that symbol `not-proven-neutral`, others
      neutral
- [ ] String-literal content change → never neutral (whitespace inside strings is behavior)
- [ ] Parse-failure side → `not-proven-neutral` with the failure disclosed
- [ ] Vocabulary closure test: normalizations in code = normalizations disclosed in output
- [ ] Determinism: verdicts byte-identical across two runs on a fixed tree

## Spec
- [ ] `analyzer` delta: ADD NeutralityIsProvenNeverGuessed
- [ ] `mcp-handlers` delta: ADD ConsumersSubtractProvenNeutralChangesDisclosed
