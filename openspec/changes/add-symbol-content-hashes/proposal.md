# Symbol content hashes: exact symbol-level changed-sets between revisions

> Status: BUILT, narrowed (2026-09-19; proposed 2026-07-03, e2e audit follow-up). See "Build notes"
> at the end for what shipped and what was deferred. Original summary: persist a per-symbol content hash over the
> normalized extracted body (AST token stream — formatting/comment-only edits hash identically),
> so two revisions' hash sets yield an EXACT symbol-level changed-set. Prior art: bazel-diff
> (https://github.com/Tinder/bazel-diff), target-determinator, buck2-change-detector — hash
> content, diff the hash sets, no semantic analysis of hunks; plus difftastic's tree-diff insight
> (https://difftastic.wilfred.me.uk/tree_diffing.html) that structure, not bytes, is the unit of
> change. Deterministic, no LLM, no new tuning constants.

## The gap

Every between-revisions conclusion is file-granular, and says so:

- `briefing_since` computes "changed production symbols (file-level granularity)"
  (`mcp-handlers/briefing-since.ts:109`) and leads its caveats with "Changed symbols are at FILE
  granularity: every production function in a file changed since the base ref is briefed, even if
  that specific function was not edited" (`briefing-since.ts:199`).
- Its churn join is file-path-exact and rename-fragile — the disclosed caveat at
  `briefing-since.ts:215` ("git history does not follow renames, so a just-renamed file may read
  as low-churn and be over-flagged surprising").
- `blast_radius` and `select_tests` seed from the diff's changed FILES via `seedsFromFiles`
  (`mcp-handlers/blast-radius.ts:153-162`, `mcp-handlers/test-impact.ts:79`) — every production
  symbol in a touched file is a seed, so the radius over-approximates on any multi-function file.
- `get_change_coupling` counts commits touching files (`src/core/provenance/change-coupling.ts`);
  a formatting sweep reads as churn/co-change like a real edit does.

The in-house precedent is close but not sufficient, and honesty requires saying which: the anchor
hash `hashSpan` (`src/core/decisions/anchor.ts:26-29`) is sha256-first-16-hex over the raw span —
its own doc comment says **"Unnormalized"** — so a formatting-only edit changes it (correct for
freshness leases, wrong for semantic change). Continuity's `normalizedBodyHash`
(`src/core/analyzer/continuity.ts:80`) normalizes ONLY the symbol's own name, not whitespace or
comments. The hashing discipline (sha256, first 16 hex chars, asserted identical across modules)
is reused; the hash itself is new. Storage-wise the `nodes` table carries `stable_id` but no hash
column (`src/core/services/edge-store.ts:137-157`); `file_hashes` (`edge-store.ts:178-181`) is
whole-file only.

## What changes

- **Normalized per-symbol hash at analyze time.** During the existing AST walk (the
  style-fingerprint precedent — no second parse), hash each extracted symbol body's token stream:
  the sequence of tree-sitter leaf-token texts, comments excluded, whitespace irrelevant by
  construction. sha256 first 16 hex, matching the `hashSpan` discipline. Persisted as a new
  nullable `norm_hash` column on `nodes` (additive, the `stable_id` precedent — no destructive
  migration).
- **Changed-set = hash-set diff.** Between two revisions: changed = hash differs; appeared /
  disappeared = present on one side only. A disappeared+appeared pair that symbol-identity
  continuity (shipped PR #206, `src/core/analyzer/continuity.ts` exact-body/exact-signature
  matching) bridges is a rename — reported as carried, and NOT semantically changed when the
  normalized body is unchanged modulo the name.
- **Base-revision hashes on demand, bounded.** No second full index: `git diff --name-only`
  bounds the file set; only those files are re-extracted at the base ref (`git show`) to compute
  base-side hashes.
- **Consumers upgrade.** `briefing_since` briefs the exact changed symbols and drops the
  file-granularity caveat where hashes cover the language (the rename-fragile churn caveat
  narrows too: continuity bridges the rename). `blast_radius`/`select_tests` seed from changed
  symbols, not changed files. `get_change_coupling` gains a semantic-churn view in which a
  formatting-only commit contributes zero — the complementary guard to sibling
  `add-knowledge-map-and-coupling-upgrades`, whose code-maat guards are statistical (bulk filter,
  same-author-day aggregation); this one is semantic. Cross-referenced, not merged.
- **Honesty.** Normalization is per-language via the existing extractors; a language without body
  extraction (see the capability matrix) falls back to file granularity WITH a disclosed
  boundary — never silently. Hash equality only: no similarity score, no threshold, no constant.

## Why this is in scope

The substrate's between-revisions conclusions currently disclose their bluntness; this removes
the bluntness with the cheapest deterministic primitive there is (build systems have shipped it
for a decade), reusing the walk, the store, and the continuity bridge that already exist. Every
consumer keeps its shape — only its changed-set sharpens.

## Impact

- Files: `src/core/analyzer/call-graph-extract.ts` (token-stream hash in the walk),
  `src/core/services/edge-store.ts` (column + accessors, schema bump), a small changed-set module
  joining hashes with `continuity.ts`, then `mcp-handlers/briefing-since.ts`, `blast-radius.ts`,
  `test-impact.ts`, `change-coupling` handler.
- Specs: `analyzer` — 2 ADDED requirements (NormalizedSymbolContentHashes,
  SymbolLevelChangedSets).
- Tool surface: unchanged (no new tool; existing conclusions sharpen). No payload-budget impact.
- Risk: schema bump on an additive nullable column (established precedent); base-ref
  re-extraction cost is bounded by the diff's file set and measured, not assumed.

## Build notes (2026-09-19)

What shipped differs from the proposal in three deliberate ways:

- **Hashes are computed at query time, not persisted.** No consumer reads a stored hash yet, and
  computing them for every file at analyze would cost every user a full extra tree walk for nothing.
  The hash rides the extractor's existing parse behind an opt-in (`withContentHashes`), so only the
  files a diff names are ever hashed, at both revisions. The `norm_hash` column (and its schema
  bump) waits for `add-incremental-early-cutoff`, the first change that needs stored hashes.
- **The hash covers structure and a residual.** A token stream alone is unsound for Python, where
  indentation is structure, so the stream carries node open/close markers. A residual hash over
  everything outside every symbol span (imports, module-level statements, class fields, symbol
  order) makes narrowing sound: a file whose residual changed stays file-granular.
- **Narrowing keeps what file-level seeding caught for a still-valid reason.** Same-file symbols
  that name a changed symbol, or hold a dynamic-dispatch site, stay seeded, and every incomplete
  case (unreadable side, parse errors, no native tree, index mismatch, file bound) stays
  file-granular with a named reason.

Deferred: the change-coupling semantic-churn view (it needs per-commit re-extraction of history),
the persisted column, and a rename-aware churn join for `briefing_since`'s surprise caveat.
