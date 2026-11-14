# State how much of a diff is proven behavior-neutral

> Priority: P2 · Not built (the proof rule and the subtraction are built; see "Already built")
> Reaches the agent through: `verify_change`, `blast_radius`, and the before-stop moment
> Why it helps the agent: the agent can say "these 14 symbols changed only in comments and layout" with proof, and spend its checks on the rest.

## Problem

OpenLore already knows when an edit to a symbol changed only comments or layout, and it already
leaves those symbols out of the blast radius and the test selection. But it says so only when the
whole diff is neutral (`noChangeClaim` in `src/core/services/symbol-changed-set.ts`). In a mixed
diff, a reformat plus one real fix, the neutral symbols drop out without a count. The agent cannot
tell "not listed because proven neutral" from "not listed because not assessed." `verify_change`
and the before-stop receipt do not state the verdict at all, so the agent's final message cannot
cite it.

## Already built (PR #520, not part of this change)

- The proof rule: normalized per-symbol content hashes in
  `src/core/analyzer/symbol-content-hash.ts` (requirement `NormalizedSymbolContentHashes`).
  Comments are excluded, whitespace between tokens never enters the hash, tree shape does, and
  string contents are hashed verbatim. A parse error or an unhashed language keeps the whole file
  as changed, with a named reason.
- The subtraction: `blast_radius`, `select_tests`, and `briefing_since` seed only from symbols
  whose hash differs, and report `changeGranularity` with the files kept whole and why.

## What changes

- **Count the proven-neutral edits.** `computeSymbolChangedSet` already holds both revisions of
  each changed file. A symbol whose span text differs while its normalized hash is equal is
  `provenNeutral`. `changeGranularity` gains `provenNeutral: { symbols, files, sample }`, where
  `files` counts files in which every difference is of this kind and `sample` is bounded like
  `fallbacks`.
- **`blast_radius` states the count in a mixed diff**, for example "14 of 30 touched symbols are
  proven neutral (comments or layout only) and were not seeded."
- **`verify_change` carries one `info` item** when the count is above zero. When the whole diff is
  proven neutral, the item says so and says that no test is selected for it.
- **Before stop**, the item appears once in the receipt (`beforeStop` in
  `src/cli/commands/hook.ts`), so the agent can put the verdict and its counts in its final message
  or PR body.

## What does not change

- No new tool, finding code, or config key. `changeGranularity` keeps its current fields.
- The proof rule is not widened. A symbol is neutral only when the normalized trees are equal.
- Which symbols are seeded and which tests are selected stay exactly as today.
- Advisory, local, deterministic, no LLM. No spec framework is involved.

## Limits we disclose

- "Proven neutral" covers comments and whitespace only. Trailing commas, redundant parentheses,
  and quote style are real hash differences and count as changed.
- The count covers symbol spans. An edit outside every symbol (module level) keeps the file whole
  and is never counted as neutral.
- A file kept whole for any reason (`parse-errors`, `language-not-hashed`, a spent bound) adds
  nothing to the count and stays listed under `fallbacks` as "not assessed."
- Comment text that changes how a file is built or run (shebang, pragma, `@ts-expect-error`) is
  hashed as code, from a closed list; a directive missing from that list is the one known gap.
- Churn history (`get_change_coupling`) is not discounted for neutral commits in this change.

## Depends on

Nothing. It builds on shipped `symbol-content-hash.ts` and `symbol-changed-set.ts`.
