# Tasks — add refactoring-aware churn

## Implementation
- [ ] Commit-range identity walk over the continuity matcher: pair-wise across commits touching
      the queried files; per-symbol chains with per-link verify receipts; memoized per content
      hash
- [ ] Closed catalog: `rename`/`move` from continuity verify semantics; `extract` only with
      duplicate-detector clone evidence; everything else stays `removed`/`added` — no guessed
      operations
- [ ] Ambiguity ends the chain (no first-match binding); consumer falls back to path-exact with
      the break disclosed
- [ ] Re-key consumers on chains with disclosure: `briefing_since` churn join +
      surprising-change tier, `get_change_coupling`, volatility classifier; narrow the existing
      blanket rename caveat to the per-symbol ambiguous cases

## Verification
- [ ] Rename fixture: pre-rename churn attributed through the chain; surprising-change no longer
      over-flags the renamed hub; disclosure names the followed rename
- [ ] Move-across-files fixture: coupling groups survive the move
- [ ] Extract without clone evidence → reported `removed`+`added`, never `extract`
- [ ] Ambiguous same-name candidates → chain ends, path-exact fallback disclosed
- [ ] Determinism: chains byte-identical across runs; memo hit on unchanged range
- [ ] Range cost bounded: walk touches only files in the queried set

## Spec
- [ ] `analyzer` delta: ADD HistorySignalsFollowSymbolIdentityChains
