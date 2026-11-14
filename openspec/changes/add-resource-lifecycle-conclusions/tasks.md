# Tasks: add-resource-lifecycle-conclusions

## 1. Analysis

- [ ] 1.1 Add `src/core/analyzer/resource-pairs.ts` (new): the closed acquire/release table and the
      auto-release scope forms for TypeScript/JavaScript, Python, and Go. Test:
      `src/core/analyzer/resource-pairs.test.ts` (new). Done when each listed pair and scope form
      is recognized and an unknown name is not.
- [ ] 1.2 Add `src/core/services/resource-lifecycle.ts` (new): `checkResourceLifecycle({ root,
      baseRef, files })`, in the shape of `checkWeakening`
      (`src/core/services/check-weakening.ts`). It builds the CFG with `buildFunctionCfg`
      (`src/core/analyzer/cfg.ts`) for changed functions and classifies each acquisition. Test:
      `src/core/services/resource-lifecycle.test.ts` (new). Done when acquire → conditional return
      → close reports the return line, and `try/finally`, `with`, `defer`, and `using` report
      nothing, also with a throw inside the scope.
- [ ] 1.3 In the same module, mark a returned, stored, or passed-on resource and an out-of-table
      pairing as not assessed, with a count. Test: `src/core/services/resource-lifecycle.test.ts`.
      Done when a function that returns the open handle produces no finding and one not-assessed
      count.
- [ ] 1.4 Compare with the base commit so that only new open paths are reported. Test:
      `src/core/services/resource-lifecycle.test.ts`. Done when a leak present at the base ref is
      silent and a leak added by the diff is reported.
- [ ] 1.5 Export the escape evaluator from `src/core/services/mcp-handlers/error-propagation.ts`
      and use it to name the exception type on an open exception path. Test:
      `src/core/services/mcp-handlers/error-propagation.test.ts`. Done when the finding names the
      type, and `analyze_error_propagation` output is unchanged.

## 2. Delivery

- [ ] 2.1 Register `resource-unreleased-on-path` in `FINDING_CODE_REGISTRY`
      (`src/core/services/mcp-handlers/enforcement-policy.ts`). Test:
      `src/core/services/mcp-handlers/enforcement-policy.test.ts`. Done when the code is advisory
      by default and blocks only when a policy names it.
- [ ] 2.2 Add the findings and the not-assessed count to `verify_change` in
      `src/core/services/mcp-handlers/verify-change.ts`. Test:
      `src/core/services/mcp-handlers/verify-change.test.ts`. Done when the receipt lists the
      finding with file and line, and a diff with no acquisition is unchanged.
- [ ] 2.3 Call `checkResourceLifecycle` from `afterTools` in `src/cli/commands/hook.ts`. Test:
      `src/cli/commands/hook.test.ts`. Done when an edit that adds an early return before `close()`
      prints one item, once per session, inside the moment's time limit.
- [ ] 2.4 Update the MCP↔Pi parity guard for the `verify_change` output in
      `src/pi/extension.test.ts`. Done when the guard passes.

## 3. Docs

- [ ] 3.1 Add the finding code, languages, and limits to `docs/mcp-tools.md` (`verify_change` row)
      and `docs/language-support.md`. Done when `src/doc-claim-sync.test.ts` passes.
