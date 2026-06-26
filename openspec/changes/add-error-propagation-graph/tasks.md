# Tasks: add-error-propagation-graph (`analyze_error_propagation`)

## 1. Decision (before code)
- [x] Decision recorded (proposal.md "Decision" section; consolidated at the commit gate):
      new conclusion tool + `exception-flow.ts` extractor + `errorPropagation` capability,
      live-computed (no persisted artifact), sound-lower-bound with disclosed boundaries, full-only.

## 2. Analyzer: per-function exception extractor
- [x] `src/core/analyzer/exception-flow.ts`:
  - `export const ERROR_PROPAGATION_LANGUAGES = new Set(['TypeScript','JavaScript','Python'])`.
  - `extractExceptionFacts(content, startIndex, endIndex, language) → FunctionExceptionFacts`:
    throw sites (type + line + locallyHandled), try regions (body span, catchAll, caughtTypes,
    rethrows), dynamic-throw count. Tree-sitter parse (whole file, located by byte range); do not
    descend into nested functions/closures.
  - `guardFor(facts, line) → guard | null` (innermost try body enclosing a line).
  - Reuse the throw/try node-type knowledge from `cfg.ts` (TS_SPEC / PY_SPEC) — no new grammar.
- [x] Unit tests: TS throw/catch (caught, escaping, re-throw, nested-closure attribution), Python
      raise/except (typed match, bare except, except-tuple, else), dynamic re-raise, unsupported
      language → empty+unsupported, determinism.

## 3. MCP handler + propagation
- [x] `src/core/services/mcp-handlers/error-propagation.ts` —
      `handleAnalyzeErrorPropagation({ directory, symbol, maxDepth })`:
  - resolve `symbol` (name / `name::path`) against the cached graph (clone-query pattern: not-found
    + candidates, ambiguity, unsupported-language, bodyless/external → explicit records);
  - bounded, memoized, cycle-guarded callee traversal; per-function live `extractExceptionFacts`;
  - compute `escapes` (with provenance + path), `handledInternally`, `boundaries`;
  - conclusion-shaped return; never a graph.
- [x] Handler tests: escaping direct throw, propagated-through-callee, caught-at-caller (handled),
      unsupported symbol, not-found, no-analysis guard, depth-bound truncation disclosure.

## 4. Tool-surface wiring
- [x] `tool-contract.ts`: `analyze_error_propagation: 'conclusion'`.
- [x] `tool-dispatch.ts`: import handler + dispatch branch.
- [x] `mcp.ts`: `TOOL_DEFINITIONS` entry (full inputSchema + USE-THIS-WHEN description),
      `TOOL_ANNOTATIONS` `_RO`, keep out of every preset (full-only).
- [x] `live-data/tool-driver.ts`: read entry (if present for the test surface).
- [x] `epistemic-lease.ts`: weight entry (if the surface requires one).

## 5. Language registry
- [x] `language-support.ts`: add `errorPropagation` to `CAPABILITIES` + `CAPABILITY_DESCRIPTIONS`;
      derive from `ERROR_PROPAGATION_LANGUAGES` in `deriveCapabilities`.
- [x] `language-support.test.ts`: behavioral cross-check (TS/Python back it via a live extraction;
      Go does not).

## 6. CLI
- [x] `src/cli/commands/error-propagation.ts` (`errorPropagationCommand`) + register in
      `src/cli/index.ts`.

## 7. Guards / docs
- [x] `mcp-presets.test.ts`: full-surface-only; bump the payload-budget ceiling if needed.
- [x] `mcp-tool-count-doc.test.ts`: update any doc tool-count figure the guard checks.
- [x] Update `CLAUDE.md` tool table + `docs/mcp-tools.md` / `docs/language-support.md` as needed.

## 7b. Second adversarial round (e2e dogfooding)
- [x] ~73 e2e scenarios (TS/JS 24, Python 27, traversal 22) via real `init`→`analyze`→query.
- [x] Fix: disclose unresolved intra-object calls (`this.`/`super.`/`self.`/`cls.`) the call graph
      resolved to no edge — extractor `CallSite.receiver` + handler `unresolvedSelfCalls` count/sample
      + boundary. Closes the one found soundness gap (silent exception-free claim through `this.m()`).
- [x] Regressions: extractor receiver classification (TS + Python); handler disclosure + no-false-
      positive on a resolved self-call. See DOGFOOD §E.

## 8. Verify
- [x] `npm run build`; `npm run test:run` (+ `examples`) green.
- [x] Dogfood e2e on this repo + a fixture: run `openlore error-propagation --symbol <known-thrower>`;
      confirm escapes/handled/boundaries shape, determinism, and an honest unsupported/ not-found path.
      Record a DOGFOOD note.
- [x] Mark proposal + spec deltas IMPLEMENTED; update memory; PR (title/description only, no comments).
