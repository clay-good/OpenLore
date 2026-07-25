# Fix export-parser fidelity: modifier-prefixed exports and comment-shifted line numbers

> Status: IMPLEMENTED (2026-07-19). `parseJSExports` gained modifier-tolerant regexes (async/
> generator functions, abstract classes, default-async name capture, and real const-enum names);
> the local recovery block in `public-surface.ts` was deleted (RESERVED_NAMES glitch filter kept).
> The JS/TS and Java cleaners now blank comments with same-length whitespace (newlines kept), and
> the Python multi-line-import collapse is scoped to `from … import ( … )`, line-count-preserving,
> and attributed to the `from` line (line numbers read from the line-aligned cleaned text). A stray
> `^\s*` in the Java import regex that swallowed a preceding blank line was tightened to `^[ \t]*`.
> Tests: export-recall + line-fidelity + Python-scoping in `import-parser.test.ts`, consumer parity
> in `dependency-graph.test.ts`; public-surface breaking-change tests stay green.
>
> Status: PROPOSED (2026-07-08, e2e audit fifth pass). Two fidelity defects in the shared
> import/export parser (`src/core/analyzer/import-parser.ts`): `export async function` /
> `export function*` / `export abstract class` are invisible to `parseJSExports` — a gap a
> prior PR patched at ONE consumer while two others still consume the broken output — and
> every emitted import/export line number is computed against the comment-stripped string,
> not the original file, so nearly every recorded line is shifted upward. Hoist the existing
> local fix into the parser; apply the same-length comment-blanking discipline that already
> exists 700 lines below in the same file.

## The defect(s)

- **(a) Modifier-prefixed exports are invisible — and the fix already exists, in the wrong
  place.** `parseJSExports`' function regex (`import-parser.ts:379`) is
  `/export\s+function\s+(\w+)/g` — it matches neither `export async function` nor a
  generator `export function*`; the class regex (`:392`, `/export\s+class\s+(\w+)/g`)
  misses `export abstract class`; and the default-export regex (`:333`,
  `/export\s+default\s+(?:(class|function)\s+(\w+)|(\w+))/g`) captures the name `"async"`
  for `export default async function foo`. The gap is KNOWN and patched locally:
  `src/core/services/mcp-handlers/public-surface.ts:163-166` says verbatim
  "`parseJSExports`' `export function` regex matches neither `export async function` nor a
  GENERATOR (`export function* gen` / `export async function* agen`) — recover all of those
  here so async/generator exports are not silently dropped. Local fix; shared parser
  unchanged." (PR #207). But two other consumers still call the unpatched parser through
  `ImportExportParser.parseFile` (which dispatches to `parseJSExports`,
  `import-parser.ts:1140`): the dependency graph (`dependency-graph.ts:9,321`) and the
  spec verifier (`verifier/verification-engine.ts:14,457`, whose `compareExports` at `:465`
  scores predictions against `fileAnalysis.exports`). `mapping-generator.ts:160-176` builds
  its `exportIndex` from those dep-graph exports. In a codebase like OpenLore itself
  (dozens of `export async function`), every async export is invisible to the export
  index — `mapping.json` requirement→function links silently fall to the heuristic/semantic
  tier, `orphanFunctions` is wrong, and spec verification checks a wrong export set.
- **(b) Line numbers are counted in the wrong string.** The JS cleaner
  (`import-parser.ts:163-165`) strips comments WITH their newlines
  (`.replace(/\/\*[\s\S]*?\*\//g, '')`), then every emitter does
  `line: getLineNumber(content, match.index)` (`:182`, `:343`, `:400`, `:542`, …) —
  `match.index` is an offset into `cleanContent` but lines are counted in the original
  `content`. The exports cleaner (`:326-328`) and the Java cleaners (`:712-713`,
  `:776-777`) have the same shape; Python is worse: `:520` collapses ALL parenthesized
  spans file-wide (`.replace(/\(\s*([\s\S]*?)\s*\)/g, …)`), not just import lists. Nearly
  every source file starts with a block-comment header, so essentially every recorded
  import/export line is shifted upward (a 12-line header puts real line 14 at ~2) —
  `mapping.json` `FunctionRef.line` and dep-graph export lines send an agent to the wrong
  location. THE DISCIPLINE EXISTS 700 LINES BELOW IN THE SAME FILE: `parseHtmlAssetImports`
  (`:1063-1066`) blanks comments with same-length whitespace, "newlines kept", precisely
  "to preserve line numbers".
- **Minor fold-in (observation, extends `optimize-analyze-pipeline-passes`):**
  `resolveImport` (`import-parser.ts:919-921`) probes candidate existence with a full
  `readFile` across up to ~19 candidates per import; `access`/`stat` is the honest probe.
  Noted here because the audit read the file; the fix belongs to that change's pass budget.

## What changes

1. **Hoist the recovery pattern into the parser.** `parseJSExports` gains
   modifier-tolerant regexes — `export (async )?function(*)? name`,
   `export (abstract )?class name`, and a default-export pattern that skips the `async`
   modifier before capturing the name — matching what `public-surface.ts:166` already
   recovers. The local patch in `exportedNames` (`public-surface.ts:163-172`) is then
   deleted: one shared parser, no per-consumer recovery. Dep-graph, verifier, and
   mapping-generator inherit the fix through `parseFile` with no call-site change.
2. **Same-length comment blanking, everywhere lines are emitted.** The JS/TS, Java, and
   Python cleaners blank comments (and Python's collapsed parenthesized spans) with
   same-length whitespace keeping newlines — the exact `parseHtmlAssetImports:1065`
   pattern — so `match.index` offsets and `getLineNumber` agree with the original file.
   Multi-line Python imports keep working: the collapse replaces newlines inside the
   parens with spaces of equal count only where the regex semantics require joining, with
   the line attributed to the statement's first line (disclosed in the parser's doc
   comment).

## Why this is in scope

The parser is substrate plumbing: deterministic, local, no LLM (decision `c6d1ad07`). Both
defects are the audit's recurring theme — the discipline exists, unapplied: the async-export
recovery lives at one consumer while two others serve wrong export sets, and the
line-preserving blanking lives in the same file's HTML path while the JS/Python/Java paths
mis-locate every symbol. A wrong `FunctionRef.line` is a silently-wrong conclusion handed to
an agent — precisely what the honest-boundaries doctrine forbids.

## Impact

- Files: `src/core/analyzer/import-parser.ts` (export regexes, cleaners); deletion of the
  local recovery block in `src/core/services/mcp-handlers/public-surface.ts:163-172`
  (behavior preserved — pinned by the existing public-surface tests). Consumers
  (`dependency-graph.ts`, `verification-engine.ts`, `mapping-generator.ts`) unchanged.
- Specs: `analyzer` — 2 ADDED requirements (ExportParserRecognizesModifierPrefixedExports,
  ImportExportLineNumbersMatchOriginalSource).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low. Regex widening is additive (new matches only); line-number correction shifts
  recorded lines to the TRUE lines — any test pinning the old shifted values is asserting
  the bug and gets updated with a comment saying so.
