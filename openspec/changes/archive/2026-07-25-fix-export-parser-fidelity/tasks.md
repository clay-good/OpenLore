# Tasks — fix export-parser fidelity

## Implementation
- [x] `parseJSExports` (import-parser.ts:379,:392,:333): modifier-tolerant regexes —
      `export (async )?function(*)? name`, `export (abstract )?class name`, default-export
      pattern that skips `async` before capturing the name (kind stays `function`/`class`)
- [x] Delete the local recovery block in `exportedNames`
      (public-surface.ts:163-172) — the shared parser now returns those names; keep the
      RESERVED_NAMES glitch filter and the enum recovery unless the parser also fixes enum
      naming (then delete both together)
- [x] Same-length comment blanking (newlines kept, the parseHtmlAssetImports:1065 pattern)
      in the JS import cleaner (:163-165), JS export cleaner (:326-328), Java cleaners
      (:712-713, :776-777), and the Python cleaner — with the Python parenthesized-import
      collapse (:520) reworked to preserve total line count and scoped to import statements,
      attributing multi-line imports to their first line
- [x] Doc-comment the line-attribution rule for collapsed multi-line Python imports
- [x] Note (no code here): resolveImport's readFile existence probe (:919-921) recorded as
      an `optimize-analyze-pipeline-passes` follow-up (access/stat instead of full read)

## Verification
- [x] Export-recall fixtures: `export async function`, `export function* gen`,
      `export async function* agen`, `export abstract class`, `export default async
      function foo` (name `foo`, never `async`) all appear in parseJSExports output
- [x] Consumer parity: dep-graph exports, verifier `compareExports` input, and
      mapping-generator `exportIndex` include async exports for a fixture file; the
      public-surface breaking-change tests stay green after the local patch is deleted
- [x] Line-fidelity fixtures: a file with a 12-line block-comment header records the import
      on its TRUE line for JS, TS, Java, and Python; a multi-line Python `from x import (…)`
      is attributed to the `from` line; parseHtmlAssetImports behavior unchanged
- [x] Python collapse scoping: parenthesized non-import code (a multi-line call) no longer
      perturbs line numbers of imports below it
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD ExportParserRecognizesModifierPrefixedExports,
      ImportExportLineNumbersMatchOriginalSource
