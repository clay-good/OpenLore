# Parse-health disclosure: no silent under-extraction from parse errors, grammar drift, or unreadable files

> Status: SHIPPED (2026-07-18, PR #227; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). The honesty contract covers *named languages* (the
> registry can't over-claim a language) but not *failed extraction inside a supported language*:
> a file that parses badly, a grammar whose node types drifted, or a non-UTF-8/oversized file today
> yields a silently smaller graph indistinguishable from "there is genuinely nothing there." This
> change records per-file parse health at analyze time and surfaces it as a disclosed boundary.
> Deterministic, no LLM, no new dependency. No competing tool discloses this.

## The gap

Three silent-empty leaks, all inside claimed-supported languages:

1. **Swallowed parse failures.** The per-file extraction loops catch and discard errors with bare
   `catch {}` (`call-graph.ts:3502-3601`, `:3644` "best-effort per file"). A file the pinned grammar
   rejects contributes zero nodes/edges; the user sees "file present, 0 calls" with no signal.
   `extra-languages.test.ts:113` documents a past bug of exactly this shape ("counted-but-empty").
2. **Tree-sitter error recovery hides partial parses.** tree-sitter always returns a tree; an
   `ERROR` region can swallow arbitrarily large well-formed neighbors, silently deleting functions
   and edges. `ERROR`/`MISSING` node counts are directly queryable at parse time — OpenLore never
   records them. Grammar-version drift (the `tree-sitter-*` deps are floating carets) produces the
   same shape: a renamed node type makes a query match nothing, and `safeQuery` skips it silently
   (e.g. `extractClassRelationships`, `call-graph.ts:2305`).
3. **Encoding and size limits are undisclosed.** Every file is read as UTF-8 (`file-walker.ts:229,
   243`) — non-UTF-8 sources decode lossily and may parse to garbage; files over `MAX_READ_SIZE`
   (`:220`) are excluded with no trace in any conclusion.

Downstream, every conclusion tool built on the graph (`orient`, `find_dead_code`, `select_tests`,
`analyze_impact`, coverage gaps, blast radius) treats the missing symbols as *absent*, not
*unknown* — the exact failure mode the `NoFalseCompleteness` requirement exists to prevent.

## What changes

**Record parse health once, at extraction time; disclose it wherever a conclusion depends on it.**

- During the AST walk (no second parse), record per file: `hasError`, ERROR/MISSING node counts and
  their line spans, outright parse failure (the current `catch {}` paths log a structured record
  instead of discarding), encoding fallback, and size-cap exclusion. Stored with the analysis
  artifacts; incremental watcher updates maintain it per changed file.
- `get_language_support` and `orient` gain a compact `parseHealth` summary (counts per language;
  the top offending files). `doctor` reports degraded files. A conclusion tool whose result set
  touches a degraded file appends a boundary: *"file X parsed with N error regions — symbols and
  edges there are a lower bound."* Clean repos pay zero overhead (no boundary emitted).
- A registered governance finding `parse-health` (advisory by default, `FINDING_CODE_REGISTRY`)
  lets an operator gate on regressions (e.g. a grammar upgrade that suddenly errors 40 files).
- **Grammar-drift canary:** the conformance suite additionally asserts *zero* ERROR/MISSING nodes
  on its own fixtures, so a grammar bump that breaks extraction fails CI on the fixture, not
  silently in the field.

## Why this is in scope

Pure honesty-contract work: it converts three undisclosed failure modes into disclosed boundaries,
using data the parser already produces. It directly serves `NoFalseCompleteness` and the "quiet
result must be interpretable" principle behind `get_language_support` — and it is a genuine
differentiator: no comparable tool (SCIP indexers, LSP servers, ast-grep) reports parse-health
boundaries on its conclusions.

## Impact

- `src/core/analyzer/` (record during walk; replace bare `catch {}` with structured records),
  `file-walker.ts` (encoding/size records), `mcp-handlers` (orient/language-support/doctor
  surfacing; per-conclusion boundary), `enforcement-policy.ts` (new finding code), conformance
  suite (zero-ERROR canary).
- Specs: `analyzer` — 1 ADDED requirement (ParseHealthIsRecordedAndDisclosed); `mcp-handlers` —
  1 ADDED requirement (ConclusionsDiscloseParseHealthBoundaries).
- Risk: low — additive metadata; watch the MCP payload budget for the orient summary (compact,
  counts-only; the budget test's documented per-bump rationale applies if it grows).
