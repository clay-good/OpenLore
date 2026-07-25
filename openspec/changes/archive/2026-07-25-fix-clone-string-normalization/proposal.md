# Fix clone-detector string corruption: comment stripping truncates literals → false 1.0 clone verdicts

> Status: SHIPPED (2026-07-19, PR fix-clone-string-normalization). `stripComments`
> (`duplicate-detector.ts`) is now a single left-to-right scanner: it classifies each char as code,
> string, or comment in one pass, so string-literal contents survive verbatim while comments are
> removed. The `#` line-comment rule is language-selected (`hashStartsLineComment`); `findClones`
> threads the query's language so query and candidates share one linguistic lens; the near-group
> score is the all-pairs minimum (honest floor). Notes: (1) the string masking the proposal
> described as a separate pass was folded into the scanner — equivalent result, no double-parse;
> (2) both empirical repros and the language-selection/interpolation cases are pinned by tests in
> `duplicate-detector.test.ts`; (3) no clone snapshots existed to re-baseline.
>
> Original status: PROPOSED (2026-07-08, e2e audit fifth pass). The duplicate detector's comment
> stripping runs string-blind over raw text, so `//` inside a URL and `#` inside a hex color
> truncate the literal — two functions differing ONLY in those constants normalize identical and
> are reported as clones at similarity 1.0, exactly where an agent is told to trust the number
> (empirically reproduced twice).

## The defect(s)

**String-blind, language-blind comment stripping.** `stripComments`
(`duplicate-detector.ts:126-137`) applies its rules to the raw text of every language with no
string-awareness:

```ts
// // single-line (JS/TS/Go/Rust/Java)
text = text.replace(/\/\/[^\n]*/g, '');
// # single-line (Python/Ruby)
text = text.replace(/#[^\n]*/g, '');
```

- `"https://api.example.com/users"` truncates at `"https:` — the host and path vanish before
  hashing/shingling.
- `"#ff0000"`, URL fragment anchors (`"/docs#install"`), Ruby `#{...}` interpolation, and JS
  `#private` field accesses all truncate their line.
- The `#` rule applies to TS/JS/Go, where `#` is not a comment at all.

**Empirical repros.** Two TS functions identical except the URL host/path inside a string
literal → reported `structural`, similarity 1.0. Two Python functions differing only in
hex-color constants → `structural`, 1.0.

**Where the false 1.0 lands.** `find_clones` presents matches as "the canonical implementation
to reuse" and `get_duplicate_report` groups them — both are conclusion tools whose contract is
that the similarity number is trustworthy. `normalizeType1`/`normalizeType2`
(`duplicate-detector.ts:140-157`) both build on `stripComments`, so exact, structural, and near
tiers all inherit the corruption; `find_clones` reuses the same detector by design, so the
edit-time "does this already exist?" answer inherits it too.

**Minor sibling: near-group cohesion overstated.** The near-group "minimum pairwise similarity"
(`duplicate-detector.ts:327-330`) is computed seed-vs-member only
(`jaccard(ungrouped[i].shingles, ungrouped[group[k]].shingles)`), not all-pairs — two members
each 0.85-similar to the seed may be far less similar to each other, so the reported group floor
("conservative", `:326`) overstates cohesion.

## What changes

- **Mask string literals BEFORE comment stripping**, length-preserving (the established
  precedent: `http-route-parser.ts`'s byte-aligned masking, e.g. `blankKeepNewlines` and
  `maskPythonNonCode`). Literal CONTENTS are blanked for the comment pass only, then comment
  rules run on the masked text and their spans are applied to the original — a `//` or `#`
  inside a string can no longer start a "comment". String contents still participate in
  normalization/shingling (two functions differing only in a literal remain DIFFERENT, which is
  the point of both repros).
- **Select the `#` rule by language**: applied for Python/Ruby (minus Ruby `#{...}`
  interpolation, which the string mask already protects), never for TS/JS/Go/Rust/Java.
- **Near-group score honesty**: either compute the group floor all-pairs, or relabel the
  existing number honestly as seed-relative similarity. Decision at implementation time by cost —
  all-pairs is O(group²) on group size, typically tiny; if kept seed-relative, the output field
  name/docs must say so (no silent overstatement either way).
- Repro fixtures pin both empirical cases: URL-differing TS pair and hex-color-differing Python
  pair are NOT exact/structural clones after the fix (near-tier membership at their true
  similarity is acceptable and asserted by value).

## Why this is in scope

A similarity of 1.0 is the strongest claim the detector can make, and both conclusion tools tell
the agent to act on it (reuse the canonical implementation; refactor the group). Producing it
from corrupted text is a deterministic false answer within claimed scope — the same class as the
route-line drift, and fixable with the same discipline the codebase already established:
length-preserving masking, language-selected rules, no new tuning constants, no LLM (decision
`c6d1ad07`). The near-group relabel is the honest-boundaries rule applied to a score: report
what was computed, not what sounds stronger.

## Impact

- Files: `src/core/analyzer/duplicate-detector.ts` (`stripComments` → string-aware,
  language-selected; near-group floor or relabel); repro fixtures + tests. `find_clones` and
  `get_duplicate_report` inherit the fix through the shared detector — no tool-surface change.
- Behavior shift: some existing exact/structural groups DISSOLVE (they were false positives) and
  some hashes change — clone-report snapshots are re-baselined with the fixtures as the
  rationale.
- Specs: `analyzer` — 1 ADDED requirement (StringLiteralSafeCloneNormalization).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low. Masking strings for the comment pass only cannot create new matches — it can only
  stop literal truncation; an unterminated-string edge case degrades to today's behavior (over-
  stripping), never worse.
