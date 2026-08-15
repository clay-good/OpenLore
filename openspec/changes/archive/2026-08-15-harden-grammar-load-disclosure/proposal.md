# A missing core-language grammar silently zeroes the whole language — disclose it, and stop the capability matrix over-claiming

> Status: PROPOSED (2026-07-03, e2e audit pass 4). The 8 core-language parser getters do an
> unguarded `await import('tree-sitter-<lang>')`; every grammar is an `optionalDependency`
> that npm legitimately skips when node-gyp can't build it (corporate proxy, missing
> toolchain, ABI mismatch after a Node upgrade). The rejection is swallowed by the per-file
> parse `catch` whose message only prints under `DEBUG`, so a repo whose primary language is
> TypeScript can produce a completely empty graph with **zero user-visible signal**. The
> doctrine-compliant loader that warns-once already exists (`loadGrammarSoft`) — the core 8
> just don't use it. Meanwhile `get_language_support`, the tool that exists to make a quiet
> result interpretable, reads a static set and reports "callGraph: supported" for a language
> whose grammar failed to load.

## The gap

- **(a) Unguarded core-grammar imports.** `getTSParser`/`getPyParser`/Go/Rust/Ruby/Java/C++/
  Swift (`src/core/analyzer/call-graph.ts:179-333`) each `await import('tree-sitter-<lang>')`
  with no guard. The rejection propagates into the pass-1 per-file dispatch and is caught at
  `call-graph.ts:3999-4004` with a message ("Skip files that fail to parse — syntax errors,
  encoding issues") gated behind `DEBUG`. Result: every file of that language yields zero
  nodes and zero edges, and the only trace is a debug line nobody sees.
- **(b) The soft path exists but isn't wired for the core 8.** The spec-08 languages use
  `loadGrammarSoft`/`loadWasmGrammarSoft` (`:1753-1857`), which warn once
  ("grammar unavailable — indexed for search but not graphed") and cache the null. The
  asymmetry means the *added* languages degrade honestly while the *primary* ones fail
  silently.
- **(c) Grammar-version drift takes the same silent route.** `new _NativeQuery(lang, …)`
  (`:613-614`) is unguarded — a node-type rename in a floating grammar bump throws at query
  construction and lands in the same swallowed per-file catch.
- **(d) `get_language_support` over-claims.** `language-support.ts:108` derives `callGraph`
  from the static `CALLGRAPH_LANGUAGES` set (`call-graph.ts:2118`); runtime availability
  (`_grammarHandleCache`, `_warnedUnavailable`) is never consulted. When `tree-sitter-typescript`
  is absent, the tool answers "callGraph supported for TypeScript" while every TS file graphs
  to zero — the exact "no callers vs unsupported here" confusion it exists to prevent.

This is NOT covered by `add-parse-health-boundary-disclosure` (confirmed by reading it): that
records per-file parse ERROR/MISSING nodes and encoding/size exclusions. A grammar-*load*
failure masquerades there as N unexplained per-file "parse failures", never one
"language L grammar unavailable" boundary; the getter/soft-loader asymmetry is unaddressed.

## What changes

1. **Route the 8 core getters through the soft loader.** Wrap each `import` so a load failure
   warns once ("TypeScript grammar unavailable — files indexed for search but not graphed;
   run `npm rebuild tree-sitter-typescript` or check your toolchain") and caches the null,
   exactly like the spec-08 path. Guard `_NativeQuery` construction the same way.
2. **Record language-grammar-unavailable as a distinct disclosed boundary** in the analysis
   result / parse-health surface (a sibling to the file-level boundaries the parse-health
   change adds), so a consumer sees "language L: grammar unavailable, N files ungraphed",
   not silence.
3. **`get_language_support` reports runtime grammar status.** Add `grammarStatus`
   (`loaded | unavailable | untried`) per language alongside the static capability, so the
   matrix stops claiming a capability the install can't deliver.

## Why this is in scope

An empty graph presented as a complete one is the single worst honesty failure the substrate
can make — every downstream conclusion ("X is dead", "Y has no callers") inherits it. The
fix reuses machinery the project already built and trusts; it just applies it to the
languages that matter most.

## Impact

- Files: `src/core/analyzer/call-graph.ts` (8 getters + `_NativeQuery` guard through the soft
  loader), `src/core/analyzer/language-support.ts` (runtime `grammarStatus`), the parse-health
  boundary surface (sibling to `add-parse-health-boundary-disclosure` — declare the ordering
  if that ships first).
- Specs: `analyzer` — 2 ADDED (CoreGrammarLoadFailureIsDisclosed,
  CapabilityMatrixReflectsRuntimeGrammarAvailability).
- No new tool. Risk: low — the warn-once + cache-null pattern is already proven; the only
  behavior change is a visible warning where there was silence. Test by pointing a getter at
  a missing grammar and asserting the boundary + non-empty warning, and that the file still
  reaches the search index.
