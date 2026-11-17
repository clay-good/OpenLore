# Tasks — Extract large composite literals in linear time

> Deterministic, no LLM, no new dependency. Profiled before changed: 18.4 s of 19 s of self time in
> tree-sitter's `get namedChildren`, entered from `httpAstWithinTraversalBudget`.

## 1. The super-linear walk
- [x] Add `src/core/analyzer/ast-children.ts`: `readNamedChildren(node)` reads the children getter
      exactly once and records `astChildNodesMaterialized`. Document both O(k²) hazards (the
      re-evaluated array getter here, the rescanning `child(i)` accessor already guarded elsewhere).
- [x] Use it in `httpAstWithinTraversalBudget` (`http-route-parser.ts`).
- [x] Use it in `rootAstIndex` and `astTraversalWithinBudget` (`exception-flow.ts`) — the same shape
      on the error-propagation path.
- [x] Add the `astChildNodesMaterialized` counter to `PerfWorkCounters`.

## 2. Make the stated bound the real bound
- [x] Rename `PER_FILE_PARSE_BUDGET_MS` → `PER_FILE_EXTRACTION_BUDGET_MS`; rewrite its doc comment to
      say what it now bounds and why the env override keeps its name.
- [x] Rename `parse-budget.ts` → `extraction-budget.ts` and its exports to match
      (`ExtractionBudgetExceededError`, `EXTRACTION_BUDGET_MESSAGE_PREFIX`, `extractionBudgetMs`,
      `extractionBudgetOverrunMs`).
- [x] Add the extraction-wide deadline: `runWithExtractionBudget` (async-local scope + the conclusive
      check on return), `extractionDeadline`, `checkExtractionBudget`.
- [x] `dispatchFileExtract` runs its body inside the budget, so both lanes are bounded by one
      mechanism.
- [x] `parseWithBudget` arms tree-sitter with the time REMAINING on the file's budget, floored at
      1 ms (0 micros means "no deadline" to the binding).
- [x] Cooperative checkpoints at the six shared post-parse phase boundaries in `call-graph.ts` and
      once per 1,024 nodes at the shared tree-walk children boundary.

## 3. Tests
- [x] `wide-literal-extraction.test.ts`: linearity on a deterministic OPERATION COUNT (ratio and an
      absolute O(nodes) bound), not wall clock.
- [x] Same file: the extraction of the unmodified real `demo.pb.go` equals a golden captured from the
      pre-fix build (functions, spans, edges).
- [x] Same file: a post-parse overrun is abandoned and classified `budget-exceeded`; an overrun with
      no checkpoint is still abandoned on return; `OPENLORE_PARSE_BUDGET_MS=0` opens no scope;
      end-to-end through `CallGraphBuilder` the file is excluded, disclosed, and the run completes.
- [x] Structural guard across every walker file: no `for` loop indexes a children getter it also
      re-reads. States why the existing `parse-health.test.ts` wide-node test missed this (one walk,
      and the other hazard — a plain-object test node cannot exhibit a re-materializing getter).

## 4. Docs & specs
- [x] `openspec/specs/analyzer/spec.md`: new `TreeWalksAreLinearInNodeWidth`; `PerFileExtractionCostIsBounded`
      rewritten to cover the whole extraction, with the post-parse-overrun scenario.
- [x] `docs/language-support.md`: the WASM lane lacks an enforceable in-PARSE deadline; the rest of
      the budget is language-independent.
