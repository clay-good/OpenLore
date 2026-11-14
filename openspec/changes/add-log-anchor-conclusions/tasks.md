# Tasks: add-log-anchor-conclusions

## 1. Template facts

- [ ] 1.1 Add `src/core/analyzer/log-template-extractor.ts` (new): a closed per-language table of
      logger callee names plus `throw` / `raise`, and extraction of ordered constant parts, file,
      line, and enclosing symbol from trees the walk already holds. Test:
      `src/core/analyzer/log-template-extractor.test.ts` (new). Done when a template literal, a
      printf-style call, and a `throw new Error("…")` each yield the expected parts, and a fully
      dynamic message adds one to the file's unmatchable count.
- [ ] 1.2 Call the extractor from the Pass-1 walk in `src/core/analyzer/call-graph.ts` and store its
      records with the per-file facts in `src/core/analyzer/pass1-fact-cache.ts`. Test:
      `src/core/analyzer/pass1-fact-cache.test.ts`. Done when editing one file re-extracts only
      that file's templates and no extra parse runs.
- [ ] 1.3 Write `.openlore/analysis/log-templates.json` from
      `src/core/analyzer/artifact-generator.ts`. Test:
      `src/core/analyzer/artifact-output-determinism.test.ts`. Done when two runs on the same tree
      write byte-identical files.

## 2. Matching

- [ ] 2.1 Add `src/core/services/log-origin.ts` (new): ordered constant-part containment, ordering
      by matched constant length, the length floor as one named constant, and a bounded input
      (line count and line length). Test: `src/core/services/log-origin.test.ts` (new). Done when
      one match, a tie, no match, and an under-floor template each return the documented result.

## 3. Hook moments

- [ ] 3.1 In `src/cli/commands/hook.ts`, keep a bounded tail of a failed shell call's output in
      `HookPayload` (`error` for `PostToolUseFailure`, the `tool_response` text otherwise). Test:
      `src/cli/commands/hook.test.ts`. Done when Claude Code and Codex failure payloads both yield
      the output tail and a successful call yields none.
- [ ] 3.2 In `runHook` (`src/cli/commands/hook.ts`), on a non-zero exit at `after-tools`, match the
      tail and render receipt items keyed `log-origin:<file>:<line>`. Test:
      `src/cli/commands/hook.test.ts`. Done when a failing command prints the origin once per
      session, more than three candidates print nothing, and exit 0 runs no matching.
- [ ] 3.3 In `src/cli/commands/orient-inject.ts`, match the prompt's lines and add the origin to
      the injected block inside the existing budget. Test:
      `src/cli/commands/orient-inject.test.ts`. Done when a prompt holding an interpolated log
      line gets the origin, and a prompt with no match is unchanged byte for byte.

## 4. Optional claim kind

- [ ] 4.1 Add the kind `log-origin` in `src/core/services/mcp-handlers/claim-verification.ts` and
      `src/core/services/mcp-handlers/claim-kinds-graph.ts`. Test:
      `src/core/services/mcp-handlers/claim-kinds-graph.test.ts`. Done when one origin is
      `verified` with the call site, and a tie or no match is `unverifiable` with the reason.
- [ ] 4.2 Update the MCP↔Pi parity guard for the `verify_claim` kind list in
      `src/pi/extension.test.ts`. Done when the guard passes with the new kind.

## 5. Docs

- [ ] 5.1 Describe the facts, the two hook moments, and the limits in `docs/session-ledger.md` and
      the `verify_claim` row of `docs/mcp-tools.md`. Done when `src/doc-claim-sync.test.ts` passes.
