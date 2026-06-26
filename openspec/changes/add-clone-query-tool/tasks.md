# Tasks: add-clone-query-tool (`find_clones`)

## 1. Decisions (before code)
- [x] `record_decision`: new MCP conclusion tool `find_clones` (symbol/snippet-scoped clone query),
      classified `conclusion`, opt-in full-surface only.
- [x] `record_decision`: reuse `duplicate-detector.ts` primitives via an exported one-vs-all
      `findClones` query — no new similarity algorithm, threshold, or persisted artifact.

## 2. Analyzer: one-vs-all query primitive
- [x] Export `findClones(queryBody, queryLineCount, files, callGraph, options)` from
      `src/core/analyzer/duplicate-detector.ts`, reusing the existing private normalization / shingle /
      Jaccard helpers and the existing `MIN_LINES` / `MIN_TOKENS` / `NEAR_THRESHOLD` constants.
- [x] Return `{ matches, belowThreshold, comparedAgainst }`; classify each candidate exact →
      structural → near; exclude the query's own instance; deterministic sort + optional limit.
- [x] Unit tests for the primitive (exact, structural, near, below-threshold, self-exclusion,
      determinism, similarity-floor override).

## 3. MCP handler
- [x] `src/core/services/mcp-handlers/clone-query.ts` — `handleFindClones({ directory, symbol,
      snippet, minSimilarity, maxResults })`:
  - load cached call graph (`readCachedContext`), read the source files its nodes span (skip HTML),
  - resolve the query (symbol lookup by name / `name::path`, with ambiguity + not-found handling; or
    raw snippet), call `findClones`, return the conclusion object.
- [x] Honesty: symbol-not-found error w/ candidates; `belowThreshold` signal; disclosed HTML
      exclusion; reported similarity floor.
- [x] Handler tests (symbol mode, snippet mode, not-found, below-threshold, no-analysis guard).

## 4. Tool-surface wiring
- [x] `tool-contract.ts`: `find_clones: 'conclusion'`.
- [x] `tool-dispatch.ts`: import handler + dispatch branch.
- [x] `mcp.ts`: `TOOL_DEFINITIONS` entry (full inputSchema + USE-THIS-WHEN description),
      `TOOL_ANNOTATIONS` `find_clones: _RO`, keep out of every preset (full-only).
- [x] `live-data/tool-driver.ts`: `find_clones` read entry.
- [x] `epistemic-lease.ts`: weight `find_clones: 3`.

## 5. CLI
- [x] `src/cli/commands/find-clones.ts` (`findClonesCommand`) + register in `src/cli/index.ts`.

## 6. Guards / tests
- [x] `mcp-presets.test.ts`: `find_clones` is full-surface-only.
- [x] `tool-driver.test.ts` / `tool-contract.test.ts`: auto-covered (new entry must satisfy them).
- [x] `mcp-tool-count-doc.test.ts`: bump the full-surface payload-budget ceiling if needed; update any
      doc tool-count figure the guard checks.

## 7. Verify
- [x] `npm run build`; `npm run test:run` (+ `examples`) green.
- [x] Dogfood e2e on this repo: build, run `openlore find-clones --symbol <known-dup>` and
      `--snippet` against a known clone; confirm conclusion shape and determinism. Record a DOGFOOD note.
- [x] Mark proposal + spec deltas IMPLEMENTED; update memory; PR (title/description only, no comments).
