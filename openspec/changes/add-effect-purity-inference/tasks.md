# Tasks: function effects and the shared-state hazard

## 1. Effect facts

- [ ] 1.1 New `src/core/analyzer/effects.ts`: direct effects for TS/JS/Python from the existing walk in `src/core/analyzer/call-graph-extract.ts` (module-binding assignment, parameter member write, closed I/O pattern table), and record `#__PURE__` / `@__NO_SIDE_EFFECTS__` annotation targets. Test: new `src/core/analyzer/effects.test.ts`. Done when one fixture per class yields the correct effect, a Go fixture yields no fact, and an annotated fixture records its target.
- [ ] 1.2 In `effects.ts`, close effects over resolved edges with `src/core/analyzer/condensation.ts`; unresolved, external and dynamic callees join as `unknown` with the blocking callee kept. Test: `effects.test.ts`. Done when a caller inherits `module-state` through a resolved chain and an adversarial fixture with one external callee never yields `pure`.
- [ ] 1.3 Record each module binding (name, file, line, writer functions) with the effect fact, and cache it by content hash in `src/core/analyzer/pass1-fact-cache.ts`. Test: `effects.test.ts`. Done when a counter written by two functions lists both writers and an unchanged file is a cache hit.

## 2. Shared-state hazard

- [ ] 2.1 New `src/core/services/shared-state-hazard.ts`: record `await` lines per function in `src/core/analyzer/cfg.ts` (test: `src/core/analyzer/cfg.test.ts`), then with that overlay find read → `await` → write of one module binding inside one function. Test: new `src/core/services/shared-state-hazard.test.ts`. Done when the shape is found with its three lines, and is not found when the `await` is outside the pair or the bindings differ.

## 3. Delivery on existing answers

- [ ] 3.1 Add `effects` to the functions in `src/core/services/mcp-handlers/orient.ts` and `src/core/services/mcp-handlers/blast-radius.ts`. Tests: `orient.test.ts`, `blast-radius.test.ts`. Done when a `module-state` function shows its binding and an `unknown` function names the blocking callee.
- [ ] 3.2 Add claim kind `effect-free` in `src/core/services/mcp-handlers/claim-verification.ts`. Test: `claim-verification.test.ts`. Done when the three verdicts each return with a path or a named boundary.
- [ ] 3.3 Register `shared-state-interleaved-update` and `pure-annotation-contradicted` (advisory) in `src/core/services/mcp-handlers/enforcement-policy.ts` and emit them from `src/core/services/mcp-handlers/verify-change.ts`. Tests: `enforcement-policy.test.ts`, `verify-change.test.ts`. Done when each fires on its fixture with proof lines, and neither fires on an `unknown` effect or an untouched function.
- [ ] 3.4 Carry `shared-state-interleaved-update` in the after-edit verdict in `src/core/services/edit-verdict.ts` (written by `src/core/services/mcp-watcher.ts`) when the edit introduced the shape. Test: `src/core/services/edit-verdict.test.ts`. Done when an edit that adds the `await` yields the finding once and a later unrelated edit yields nothing.

## 4. Parity and docs

- [ ] 4.1 Update the MCP↔Pi parity guard for the new `orient`, `blast_radius` and `verify_change` fields in `src/pi/extension.test.ts`. Done when the parity test passes.
- [ ] 4.2 Document the vocabulary, the claim kind, both findings and the limits in `docs/mcp-tools.md` and `docs/language-support.md`. Done when `src/doc-claim-sync.test.ts` passes.
