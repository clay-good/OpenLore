# Make history follow a symbol across renames

> Priority: P3 · Not built
> Reaches the agent through: `orient`, `blast_radius`
> Why it helps the agent: it sees when a function appeared, what changed it last and what changes with it, without `git log` archaeology, and a rename no longer hides that history.

Folds in `add-symbol-provenance-conclusions` (removed; restore from commit 0dd75dbef).

## Problem

OpenLore's history signals are keyed on the file path. Git churn does not follow a rename, so a
file that was just renamed reads as low-churn. `briefing_since` can then flag a hub as a surprising
change, and co-change groups break at every file move. The history that `orient` shows is also at
file grain: an agent that edits one function in a 1,000-line file gets the history of the file. To
learn when the function appeared and what changed it last, the agent runs `git log -S` and `-L`
by hand and reads raw output.

## What changes

- **Identity chains (analyzer).** For the files a query already touches, apply the shipped
  continuity matcher (`src/core/analyzer/continuity.ts`) pair-wise across the commits that touch
  them. The result is a chain per symbol, for example
  `a.ts:foo → a.ts:bar (rename @ c1) → b.ts:bar (move @ c7)`. Same matcher, same thresholds. Only
  `rename` and `move` are recognized. An ambiguous match ends the chain.
- **Churn and coupling follow the chain.** `volatilityLevel` and the co-change join in
  `src/core/provenance/change-coupling.ts` aggregate over the chain where one exists. This feeds the
  `changeCoupling` field that `orient` already returns and the surprising-change tier of
  `briefing_since`. Each answer states the links it followed ("churn follows 1 rename").
- **`orient` and `blast_radius` field `history`** on each function they already list:
  - `introduced`: commit and date, only when the scan reached the bottom of history. Otherwise
    "introduced no later than `<sha>`".
  - `lastChanged`: commit, raw subject, author, date and PR number (existing `parsePrNumber`).
  - `followedRenames` and, where a chain ends, `horizon` ("history before `<sha>` not followed").
  - Commits that touch more than `COUPLING_BULK_THRESHOLD` files are labeled `bulk` and are skipped
    for `lastChanged` and for co-change.
- The scan is `git log -L` over the symbol's current line span, bounded by `PROVENANCE_MAX_COMMITS`.

## What does not change

- No new MCP tool, preset or CLI command. `get_symbol_provenance` is not built.
- `changeCoupling`, `get_change_coupling` and `briefing_since` keep their names and current fields.
- No finding is added. The fields are evidence, and nothing blocks.
- Local git only. No LLM summary of commits: subjects are returned as written.
- Works without OpenSpec.

## Limits we disclose

- Where the matcher declines, the chain ends, the answer falls back to path-exact history, and the
  break is stated. A removal with no match stays "removed". Extract and inline are not detected.
- A shallow clone or a truncated scan never gives a birth date, only "no later than".
- Co-change stays at file grain and is correlation, not a rule.
- A symbol with no body span (external or bodyless) gets no `history`, and the answer says so. It is
  never shown as "never changed".
- Cost: the walk covers only the files in the answer and is memoized by content hash.

## Depends on

Nothing. It uses shipped code: `continuity.ts`, `git-provenance.ts`, `change-coupling.ts`.
