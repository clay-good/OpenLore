# Tasks: adopt-spec-link-status-vocabulary

## 1. Coverage depth

- [ ] 1.1 Add `coverageDepth` (`deep` | `shallow` | `not-assessed`) to `SpecRequirementLink` in
      `src/core/generator/spec-link-index.ts`, with counts in `SpecLinkIndexStats`; bump
      `SPEC_LINK_INDEX_VERSION`. Test: `src/core/generator/spec-link-index.test.ts`. Done when an
      older `mapping.json` is re-derived and not misread.
- [ ] 1.2 Fill the field in `resolveSpecLinkIndex` (`src/core/generator/spec-link-service.ts`) from
      the test reachability used by `src/core/services/mcp-handlers/coverage-gaps.ts`. Test:
      `src/core/generator/spec-link-assessment.test.ts`. Done when a linked symbol with a reaching
      test is `deep`, one without is `shallow`, and a symbol in a language without test detection
      is `not-assessed`.
- [ ] 1.3 Return the field from `handleGetMapping`
      (`src/core/services/mcp-handlers/analysis.ts`). Test:
      `src/core/services/mcp-handlers/analysis.test.ts`. Done when the existing five states and
      their counts are unchanged in the output.

## 2. Findings

- [ ] 2.1 Register `spec-coverage-unwanted`, `spec-citation-predated`, and `spec-coverage-shallow`
      in `FINDING_CODE_REGISTRY` (`src/core/services/mcp-handlers/enforcement-policy.ts`). Test:
      `src/core/services/mcp-handlers/enforcement-policy.test.ts`. Done when each is advisory by
      default and blocks only when a policy names it.
- [ ] 2.2 Emit the three findings from `handleCheckSpecDrift`
      (`src/core/services/mcp-handlers/analysis.ts`), scoped to the changed files, reading
      requirements only through the link index. Test:
      `src/core/services/mcp-handlers/analysis.test.ts`. Done when a decision citing a deleted
      requirement is `unwanted`, a decision file not yet indexed is `predated`, a changed symbol
      with an untested linked requirement is `shallow`, and a repository with no specs returns
      none.
- [ ] 2.3 Carry the findings through `src/core/services/mcp-handlers/blast-radius.ts` and
      `src/core/services/mcp-handlers/verify-change.ts` with their proof fields. Test:
      `src/core/services/mcp-handlers/blast-radius.test.ts` and
      `src/core/services/mcp-handlers/verify-change.test.ts`. Done when the receipt names the
      requirement, its source file, and the linked symbol.

## 3. Claim reason

- [ ] 3.1 In `src/core/services/mcp-handlers/claim-verification.ts`, give `decision-current` the
      reason `predated` when the id is on disk but not in the store. Test:
      `src/core/services/mcp-handlers/claim-verification.test.ts`. Done when the verdict is still
      `unverifiable` and a mistyped id keeps today's message.

## 4. Parity and docs

- [ ] 4.1 Update the MCP↔Pi parity guard in `src/pi/extension.test.ts` for the new `get_mapping`
      field and finding codes. Done when the guard passes.
- [ ] 4.2 Describe the words, the proof, and the limits in `docs/spec-link-index.md` and
      `docs/drift-detection.md`. Done when `src/doc-claim-sync.test.ts` passes.
