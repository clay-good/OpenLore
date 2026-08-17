# Fix cyclomatic-complexity language parity: Go/Ruby/Rust/Swift/Elixir report ~1 regardless of shape

> Status: PROPOSED (2026-07-08, e2e audit fifth pass). The complexity estimator has exactly two
> patterns — Python and "default" — and the default's paren-anchored keywords never match
> brace-style or keyword-style languages, so five callGraph-backed languages report a constant ~1.
> A quiet wrong number with no capability-matrix cell to disclose it.

## The defect(s)

**Two patterns for 26 languages.** `call-graph-complexity.ts:11-12` (verbatim):

```ts
const CC_PATTERN_PYTHON = /\bif\s|\belif\s|\bwhile\s|\bfor\s|\bexcept\b|\band\s|\bor\s/g;
const CC_PATTERN_DEFAULT = /\bif\s*\(|\bwhile\s*\(|\bfor\s*[(]|\bdo\s*[{]|\bcase\s+|\bcatch\s*\(|&&|\|\|/g;
```

Only Python gets the paren-free pattern (`call-graph-complexity.ts:20`); every other language
uses `CC_PATTERN_DEFAULT`, whose `if\s*\(` / `for\s*[(]` never match:

- **Go**: `if err != nil {`, `for i := 0; ...` — no parens by grammar.
- **Rust / Swift**: `if x {`, `while x {` — parens idiomatically absent.
- **Ruby**: `if x` / `elsif` / `unless` / `when` / `rescue` — no parens, and half the decision
  keywords don't exist in the default pattern at all.
- **Elixir**: `if` / `case` / `cond` / `rescue` — same.

**Empirical repro.** A Go body with 3 `if`s, 1 `for`, 1 `case` → CC 2 (only `case\s+` matched);
the identical shape written with parens (TS style) → CC 6. A Ruby `if`/`elsif`/`while` body →
CC 1.

**Consumers of the wrong number.** The value is assigned per node at `call-graph.ts:4569`
(`node.cyclomaticComplexity = computeCyclomaticComplexity(...)`) and flows into
hotspot/refactoring ranking and orient context. It is also the sampling target of the pending
`add-complexity-trend-signal` change — trend-sampling a constant-1 metric yields a permanently
flat signal for these languages (coordination note for that change; its files are not modified
here).

**No honest boundary exists.** Unlike callGraph/cfgOverlay/typeInference, complexity has no
per-language capability listing, so there is no "unsupported here" disclosure — an agent reading
`cyclomaticComplexity: 1` on a 60-branch Go function has no signal that the number is a
language-coverage artifact rather than a measurement.

## What changes

- **Per-language pattern table** in `call-graph-complexity.ts`, same regex-approximation
  approach, no scoring change (CC = 1 + decision points):
  - Go / Rust / Swift: brace-style decision keywords without required parens
    (`if` / `for` / `while` (Rust `loop`) / `match` / `case` / `catch`-equivalents, `&&`, `||`),
    anchored to keyword boundaries so identifiers like `iffy` never match.
  - Ruby: `if` / `elsif` / `unless` / `while` / `until` / `when` / `rescue` / `and` / `or` /
    `&&` / `||` (modifier forms count as decisions — they are).
  - Elixir: `if` / `unless` / `case` / `cond` / `rescue` / `and` / `or` / `&&` / `||`.
  - Where a CFG overlay exists for the language, its fixtures serve as the ground-truth check
    that the regex estimate tracks real branch counts (the estimator stays regex — cheap, run
    per node in Pass 6 — but is calibrated against CFG-known shapes).
- **Honest null for unlisted languages**: add `complexity` to the per-language capability
  registry (derived, like every other capability — the entry exists because a pattern exists);
  a language with no pattern reports `cyclomaticComplexity` as absent/null, never a silent 1.
  The default pattern remains for the C-family languages it actually fits (TS/JS/Java/C/C++/C#/
  PHP/Kotlin/Dart/Scala — paren-required grammars), now as an explicit listing rather than a
  catch-all.

## Why this is in scope

Complexity feeds ranking and triage conclusions the substrate presents as measurements. A metric
that is structurally constant for five backed languages is not an approximation — it is a wrong
answer wearing a number, and the absence of a capability cell means the matrix's core promise
("a quiet result is interpretable") does not cover it. The fix is deterministic pattern work plus
the registry discipline the codebase already uses everywhere else: no new tuning constants (the
patterns are keyword sets, grown only with fixtures, per the `widen-overlay-language-coverage`
contract), no LLM (decision `c6d1ad07`).

## Impact

- Files: `src/core/analyzer/call-graph-complexity.ts` (pattern table + dispatch),
  `src/core/analyzer/language-support.ts` (derived `complexity` capability), per-language
  fixtures.
- Consumers improve for free: hotspot/refactoring ranking, orient context, and the pending
  `add-complexity-trend-signal` gains a live signal for Go/Ruby/Rust/Swift/Elixir instead of a
  flat line.
- Specs: `analyzer` — 1 ADDED requirement (PerLanguageComplexityEstimation).
- Tool surface: unchanged. Capability matrix gains a column (derived, cannot over-claim).
- Risk: low-medium. Complexity values RISE for the five languages (intended — they were floored
  at ~1); any ranking snapshots shift accordingly and are reviewed with the fixtures. Keyword
  sets risk over-counting in strings/comments — same known limitation the estimator already has
  for the C-family ("Approximate (regex, not AST)", `call-graph-complexity.ts:17`), disclosed,
  not new.
