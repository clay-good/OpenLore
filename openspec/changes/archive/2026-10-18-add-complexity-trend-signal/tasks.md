# Tasks — add-complexity-trend-signal

## Implementation
- [x] `complexity-trend.ts`: hotspots = complexity >= HIGH_COMPLEXITY_THRESHOLD in a churned file,
      highest first, at most `limit` functions from 10 files; per file one `git log --no-merges
      --full-diff --name-only` (bulk commits over COUPLING_BULK_THRESHOLD skipped), up to 4 samples
      via `git show <sha>:<path>` + the analyze extractor; label rising/falling/flat/mixed
- [x] `declining-health` finding code (advisory default): rising and high in the latest sample
- [x] Withheld below 3 samples (`shallow-history`), `history-unavailable` on git failure, and the
      whole block withheld without churn data; caveats name the bounds, committed-only samples,
      and the rename-unfollowing path join
- [x] Carried on `get_health_map` (`complexityTrend`, `summary.decliningHealthCount`)

## Verification (`complexity-trend.test.ts`)
- [x] Rising, flat, and shallow-history over a real git history; finding only for the rising one
- [x] Bulk commits skipped; at most TREND_SAMPLES samples
- [x] Only high-complexity functions in churned files are sampled
- [x] Health map carries trend + advisory finding; withheld without churn data
- [x] No schema change (no tool input added), so payload budgets are unchanged

## Spec
- [x] `analyzer` delta: ADD ComplexityTrendIsDescriptiveAndBounded
