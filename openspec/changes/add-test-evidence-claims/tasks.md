# Tasks

## 1. Recognition

- [ ] 1.1 Add assertion recognizers (Vitest/Jest `expect`, Node `assert`, pytest `assert`, Go
      `testing` with testify) in `src/core/analyzer/test-evidence.ts` (new). Each returns the
      assertion call sites and asserted argument positions. Test:
      `src/core/analyzer/test-evidence.test.ts` (new). Done when one fixture per framework passes.
- [ ] 1.2 Add the `assertionRecognition` capability to `src/core/analyzer/language-support.ts`.
      Test: `src/core/analyzer/language-capability-conformance.test.ts`. Done when it is true only
      for languages with a recognizer and an unsupported language reports false.

## 2. Classification

- [ ] 2.1 In `src/core/analyzer/test-evidence.ts`, classify each test-to-symbol relationship with
      the def-use edges from `src/core/analyzer/cfg.ts`; follow one same-file helper, then stop
      with a reason. Test: `src/core/analyzer/test-evidence.test.ts`. Done when direct-return,
      inline-argument, one-level helper, and stopped-helper fixtures give the expected class.
- [ ] 2.2 Strongest-wins ordering in `src/core/analyzer/test-evidence.ts`. Test: same file. Done
      when a symbol with one asserting test and one reaching test reports `asserts-on` and lists
      both relationships with their own classes.

## 3. Surfaces

- [ ] 3.1 Add `evidence` to each selected test in
      `src/core/services/mcp-handlers/test-impact.ts`. Test:
      `src/core/services/mcp-handlers/test-impact.test.ts`. Done when the selected set is equal
      before and after for the existing fixtures.
- [ ] 3.2 Carry `evidence` and per-symbol `strongestEvidence` through
      `src/core/services/mcp-handlers/blast-radius.ts` and
      `src/core/services/mcp-handlers/verify-change.ts`. Tests: `blast-radius.test.ts`,
      `verify-change.test.ts`. Done when both answers show the class for a changed symbol.
- [ ] 3.3 Add the `tested` kind to `src/core/services/mcp-handlers/claim-verification.ts`. Test:
      `src/core/services/mcp-handlers/claim-verification.test.ts`. Done when `confirmed`,
      `refuted`, and each `unverifiable` cause (exercises, reaches, unrecognized framework) has a
      passing test, and `confirmed` cites file, test name, and line.
- [ ] 3.4 Register `changed-symbol-no-asserting-test` in `FINDING_CODE_REGISTRY`
      (`src/core/services/mcp-handlers/enforcement-policy.ts`), default advisory, and emit it from
      `verify-change.ts`. Tests: `verify-change.test.ts`, `src/cli/commands/hook.test.ts`. Done
      when the before-stop receipt shows it for a changed symbol and never for an unrecognized
      framework.
- [ ] 3.5 Add `tested` to the `openlore_verify_claim` guideline and kinds in
      `src/pi/extension.ts`. Test: `src/pi/extension.test.ts` (MCP↔Pi parity guard). Done when
      the parity guard passes.

## 4. Proof and docs

- [ ] 4.1 Run the classifier on this repository; record the count per class and the added analysis
      time in `docs/test-impact-selection.md`. Done when the doc states measured numbers.
- [ ] 4.2 Update `docs/language-support.md` (supported frameworks) and `docs/mcp-tools.md`
      (`tested` kind, the `evidence` field, the finding code). Add a wording test in
      `claim-verification.test.ts`: no answer says "tested" as a guarantee or "untested" for an
      unrecognized framework. Done when the test passes.
- [ ] 4.3 Run `openspec validate add-test-evidence-claims`. Done when it passes.
