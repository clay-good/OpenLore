# Fold tree-dependent enrichments into Pass 1 and reuse resident HTTP content

> Status: BUILT (2026-08-16). Class and dynamic-dispatch facts now travel through Pass 1 as plain
> data, HTTP extraction consumes resident source, native queries compile once per runtime grammar
> and source, type inference runs once per caller, and call attribution uses an interval index.
> Serial, worker, and warm-cache lanes preserve the complete pre-change graph bytes.

## Why

- **(a) Class relationships re-parse every class-bearing file.** The late
  `extractClassRelationships` pass parsed each supported file a second time.
- **(b) HTTP edge extraction re-reads files whose content is already resident.** Pass 2b passes
  only paths to `extractAllHttpEdges`; a JS/TS file is then read separately for calls and routes.
  The scan is already concurrency-bounded, so this change removes duplicate reads rather than
  claiming the previously shipped fan-out fix.
- **(c) Event synthesis re-parses a third time.** The dynamic-dispatch pass parsed every
  prefilter-matched file again.
- **(d) Type inference re-runs per raw edge.** Pass 2 Strategy 2 sliced the caller body and called
  `inferTypesFromSource` (~3-5 regex passes,
  `type-inference-engine.ts:31-160`) once per receiver call — a function with k receiver calls
  infers over the same body k times. CHA already solved this exact problem with a `typesByCaller`
  cache (`cha.ts:~293`, "one inference per fn").
- **(e) Tree-sitter queries recompile per file.** Native query construction sat inside per-file
  extractor bodies; `safeQuery`/`runQuery` compiled per call. Query source strings are module constants — the
  S-expression compile is paid ~2-6× per file across the whole corpus for nothing.
- **(f) Per-file quadratic node handling.** `findEnclosingFunction` linear-scanned all of a
  file's nodes per call site; several extractors also scanned the whole node list for membership.

## What Changes

1. **Extract plain-data class and dynamic-dispatch facts while each Pass-1 tree is alive.** The
   result must survive worker structured-clone and persistent fact-cache JSON boundaries; parser
   trees therefore remain local and are never retained or threaded between isolates.
2. **Pass resident file content to HTTP edge extraction.** Path-only callers remain supported.
3. **Memoize inferred types by `callerNode.id`** exactly as `cha.ts` does.
4. **Cache native compiled `Query` objects per (worker/runtime, grammar identity, source).** WASM
   queries remain parse-scoped and explicitly disposed.
5. **Replace the per-file linear scans** with a cached sorted-span index (`findEnclosingFunction`)
   and a Set for id membership.

## Why this is in scope

Analyze latency is the substrate's cold-start cost and the ceiling on how large a repo it
serves. Removing redundant parses and reads through pure reuse lowers that cost without trading
away graph accuracy.

## Impact

- Files: `src/core/analyzer/call-graph.ts`, `call-graph-types.ts`, and `pass1-fact-cache.ts`
  (plain-data fact extraction and pass wiring, query cache, memoization, span index);
  `src/core/analyzer/http-route-parser.ts` (resident-content input).
- Specs: `analyzer` — 1 ADDED (`AnalyzeReusesPassOneFacts`). No public graph-shape change; this is
  a performance requirement with boundary-level regression guards.
- No new tool. Risk: medium — cached facts must preserve exact extraction output across serial,
  worker, and warm-cache lanes. Pin the complete serialized graph to a pre-change golden and
  assert boundary-level parse/query/inference counters.
