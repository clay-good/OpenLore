# Tasks — harden-review-render-and-action

## Implementation
- [x] Code-span-safe encoder in review.ts: neutralize backticks, escape HTML-significant chars,
      strip the `<!-- openlore-review -->` marker substring; apply at every interpolation site
      (review.ts:230, 236, 240, 243, 263, and the drift/decision `clip(...message...)` lines
      at :284-292); `clip()` (review.ts:169-171) keeps truncating, escaping happens separately
- [x] Analyze step failure marker: action.yml:44 records failure (step output/env var) instead of
      exiting 0 with only an echo; the review step passes it through so it lands as a briefing
      caveat
- [x] Stale-index disclosure: composeReview renders the shared blast-radius confidence-boundary
      marker when graph-relevant source has diverged from the index build commit, appending
      "blast radius reflects a stale index (built at <sha>)" to the existing caveat channel
- [x] Gate delivery: reserve CLI exit code 3 for an intentional `blastRadius.block` result; let
      the Action attempt to publish the briefing before propagating that gate, while keeping
      comment API and unrelated CLI failures advisory without suppressing the configured policy
- [x] Rewrite `.github/workflows/openlore-review.yml.example:16-21`: warn against
      pull_request_target + head checkout; document the two-workflow workflow_run pattern;
      recommend pinning `openlore-version` (default `latest`, action.yml:24-27) whenever a write
      token is in scope

## Verification
- [x] Hostile-filename tests: a symbol/file name containing backticks, `@user`, HTML tags, and
      the literal sticky-marker substring renders inert (no span breakout, no second marker, no
      mention) in `renderMarkdown` output
- [x] Snapshot: benign briefings render byte-identically except at pathological names
- [x] Stale-index test: a shared confidence-boundary staleness marker → briefing carries the
      stale-index caveat with the build sha; no marker → no caveat
- [x] Failed-analyze test: analyze failure marker set → caveat present in the composed briefing
- [x] Retained guards still pass: comment double-clamp (review.ts:315-318, action.yml:80-86) and
      sticky self-heal tests unchanged and green
- [x] Action contract tests: analyze failure stays advisory, an intentional gate attempts to post before it
      fails, arbitrary execution errors are not gates, unresolved release placeholders fail
      closed, and checkout/review use the same PR-head commit
- [x] Full suite green (`vitest run src examples`; resource-sensitive lock/fuzz files also pass
      in a separate partition without unrelated worker contention)

## Spec
- [x] `cli` delta: ADD ReviewMarkdownEscapesHeadControlledText, ReviewDisclosesStaleOrFailedAnalysis
- [x] `mcp-security` delta: ADD ReviewActionWriteTokenTrustBoundary
