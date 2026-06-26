# Dogfood: `find_clones` on the OpenLore repo (2026-06-26)

Ran the built CLI (`node dist/cli/index.js find-clones`) against OpenLore's own analyzed index
(6,489 call-graph nodes; 2,429 comparable functions). End-to-end, no API key, deterministic.

## Symbol mode — found more than the whole-repo report

```
$ openlore find-clones --symbol getPyParser
   query: symbol getPyParser::src/core/analyzer/call-graph.ts (lines 544-554)
   compared against 2429 functions · floor 0.7 · 10 matches (exact 0, structural 7, near 3)
     structural 1.00  getRustParser  …:568-578     near 0.73  getTSParser   …:532-542
     structural 1.00  getRubyParser  …:580-590     near 0.73  getPhpParser  …:604-614
     … (5 more structural)                          near 0.73  getScalaParser …:640-650
```

Two things to note:
- The query's own instance (`getPyParser`) is correctly excluded — only *other* clones are returned.
- It surfaced **3 near-clones** (`getTSParser`, `getPhpParser`, `getScalaParser`) that the whole-repo
  `get_duplicate_report` grouped separately/under a different representative. The one-vs-all O(n) query
  is the value: it ranks *everything similar to this one symbol*, not just the group it landed in.

## Snippet mode — the pre-write question the whole-repo report cannot answer

Pasted the verbatim body of `getRustParser` as a snippet (simulating "I'm about to write this"):

```
$ openlore find-clones --snippet "<getRustParser body>"
   query: snippet (11 lines)
   compared against 2430 functions · floor 0.7 · 5 matches (exact 1, structural 4, near 0)
     exact      1.00  getRustParser  …:568-578
     structural 1.00  getPyParser / getRubyParser / getJavaParser / getKotlinParser
```

It found the existing `getRustParser` (exact) plus the structural siblings — i.e. "this already exists,
reuse it." `get_duplicate_report` structurally cannot do this (the snippet is not indexed).

## Honesty paths (all verified)

- **not-found**: `--symbol getPyParserNope` → explicit "No indexed function matching …" + hint, never an
  empty "unique".
- **ambiguous**: `--symbol createTempDir` → "ambiguous — matches 17 functions. Pass name::path." with the
  candidate list.
- **below-threshold**: `--snippet 'const x = 1;'` → "too small to compare", not "no clones".
- **JSON**: conclusion shape only (query, similarityFloor, summary, ranked matches, note) — no graph dump.

## Bug found and fixed by dogfooding

The first run reported **"3129 HTML inline-script symbol(s) excluded from comparison"** — but this repo
has **zero** HTML nodes. The 3,129 were external/synthesized symbols with no extractable body
(`startIndex >= endIndex`), which the handler had conflated with the HTML exclusion in one subtraction
(`allNodes.length - comparableNodes.length`). That is exactly the kind of dishonest disclosure the north
star forbids. Fixed: `htmlExcluded` now counts **only** actual `.html`/`.htm` nodes; the bodyless
external/synthesized nodes are dropped silently (correctly — there is nothing to compare), and the HTML
note clause is emitted only when `htmlExcluded > 0`. Re-ran: the false HTML line is gone.

## Tests

`npx vitest run src examples` → **270 files, 5308 passed, 2 skipped**. New tests: 13 for the
`findClones` primitive + the handler (`duplicate-detector.test.ts`, `clone-query.test.ts`), plus the
full-surface-only preset guard and the bumped payload-budget ceiling (78k → 81k for the new schema).

## Hardening round 2 (2026-06-26) — adversarial review + e2e via the MCP dispatch path

A second adversarial pass (a dedicated reviewer agent + e2e through `dispatchTool('find_clones', …)`,
not just the CLI) found and fixed six issues. All verified on the real index after the fix:

1. **HIGH — NaN similarity floor.** `--min foo` → `parseFloat` → `NaN`; `?? ` does not catch `NaN`, so
   the floor became `NaN`, `sim >= NaN` dropped *every* near match, and `similarityFloor` serialized as
   `null` — the exact "empty reads as unique" failure the tool swears off. Fixed: non-finite
   `minSimilarity` (and `maxResults`) coerce to the default via `Number.isFinite`. Verified:
   `dispatchTool` with `minSimilarity: NaN` → `floor 0.7, near 3`; CLI `--min foo --max bar` →
   `floor 0.7, 10 matches` (bounded), not unlimited.
2. **MEDIUM — bodyless/HTML symbol gave a self-contradicting not-found.** Asking for a symbol that
   exists only as an external/synthesized (`startIndex >= endIndex`) or HTML node returned "No indexed
   function matching X" while offering `X` as a candidate. Fixed: a distinct "in the index but has no
   comparable body" message. Verified on the real index: `find-clones --symbol 'fh.sync'` →
   "is in the index but has no comparable body … cannot be clone-compared."
3. **MEDIUM — stale byte ranges undisclosed.** Bodies are sliced from current source by indexed
   offsets; if a file changed since analyze the slice is stale. Now disclosed in every result's `note`
   ("re-run analyze_codebase after edits or a match span may be stale").
4. **LOW/MED — incomplete tie-break vs. spec over-claim.** The sort key (type, similarity, file,
   startLine) did not fully disambiguate two functions on the same line; the spec claimed a fully
   stable order. Fixed: tie-break now adds `endLine` then `functionName` (a total order); the analyzer
   spec delta updated to match. New test: same matches in reversed input order → byte-identical output.
5. **LOW — exclude key carried an unnecessary `name`.** Switched the self-exclusion key to
   `(filePath, startIndex, endIndex)` — collision-proof, name-independent.
6. **LOW — NaN `maxResults`** (same class as #1) → fixed alongside it.

New regression tests cover all six (NaN floor/max, bodyless-symbol message, HTML-exclusion disclosure,
reversed-input determinism). Full suite after hardening: **270 files, 5314 passed, 2 skipped**.

## Hardening round 3 (2026-06-26) — parity audit + real-world e2e + cross-language honesty

A third pass focused on *parity surfaces* and *real-world inputs* rather than the handler internals.

**Parity audit (does any surface silently omit the tool?)** — a dedicated agent checked every place
that enumerates tools: the Pi extension (`NAV_TOOLS`), `openlore serve` / serve-client, the `tools/list`
ListTools handler, `TOOL_PRESETS`/`MINIMAL_TOOLS`, `CHAT_TOOLS`, the plugin manifest / `.mcp.json`, and
the language-support matrix. Verdict: **no missed surface.** Every registry that must list every tool
(tool-contract, tool-driver, epistemic-lease, TOOL_DEFINITIONS + annotation) already has `find_clones`;
every curated/navigation allowlist (NAV_TOOLS, CHAT_TOOLS, the six presets, MINIMAL_TOOLS) *correctly*
excludes it, exactly as every comparable recent full-preset tool (`get_style_fingerprint`,
`briefing_since`, `report_coverage_gaps`, `certify_public_surface`) is excluded. tools/list, serve, and
the Pi host all dispatch generically from `TOOL_DEFINITIONS`, so the tool flows through under
`--preset full` with no further wiring.

**Real-world e2e battery (via `dispatchTool`, real index, 2,430 comparable fns):**
- Method with a class → ambiguity correctly reported (`constructor` matches 43); `className` present on matches.
- 400-line synthetic snippet → 354 ms, bounded, correct (performance sane).
- Unicode snippet (`grüße`, CJK) → no crash, handled.
- Two real runs → byte-identical (determinism holds on the live graph).

**Gap found & fixed — cross-language visibility.** The proposal documents cross-language clones as
out of scope, but normalization is language-agnostic, so a `near` match *can* land in another language,
and matches exposed no `language` field (only the file path implied it). Made the caveat actionable:
each match now carries `language`, the symbol-mode query carries its own, and the CLI flags a
cross-language match with `⚠ <language>`. Spec deltas + proposal updated; new test asserts the field.
Full suite after round 3: **270 files, 5315 passed, 2 skipped**.

## Round 4 (2026-06-26) — cross-language ⚠ fixture + consolidated-spec merge

Two follow-ups requested after round 3:

1. **A real cross-language clone fixture exercising the ⚠ path.** Added a body that is byte-identical
   in TypeScript and C++ (a genuine cross-language clone), at three levels:
   - `duplicate-detector.test.ts` — `findClones` surfaces the C++ clone of a TS query with
     `language: 'C++'`.
   - `clone-query.test.ts` — the handler returns `query.language='TypeScript'` and a `proc.cpp` match
     with `language='C++'`.
   - `find-clones.test.ts` (new) — the CLI `renderHuman` emits `⚠ C++` for a cross-language match and
     **no** `⚠` for a same-language match or when the query language is unknown (snippet mode).

   Dogfooded through the **real built CLI** on a crafted temp project:
   ```
   $ openlore find-clones --symbol 'process::proc.ts'
     exact      1.00  process  proc.cpp:1-8  ⚠ C++
   ```

2. **Merged the change's spec deltas into the consolidated specs.** `OneVsAllCloneQuery` →
   `openspec/specs/analyzer/spec.md`; `CloneQueryConclusionTool` → `openspec/specs/mcp-handlers/spec.md`
   (each with a `> Change: add-clone-query-tool` provenance footer, matching the existing consolidated
   requirements). The change-dir deltas remain as the authoring record.

Full suite after round 4: **271 files, 5320 passed, 2 skipped**.
