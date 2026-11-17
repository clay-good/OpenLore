# Tasks

## 1. Recognition

- [ ] 1.1 Add `isPlanAuthoringInvocation` to `src/cli/commands/proposal-context.ts`: the existing
      OpenSpec forms, the Spec Kit commands, and the verb-plus-plan-noun phrase rule. Keep
      `isOpenSpecProposalInvocation` exported and unchanged. Test:
      `src/cli/commands/proposal-context.test.ts`. Done when each listed form matches and every
      prompt the current tests reject is still rejected.
- [ ] 1.2 Add negative cases to `src/cli/commands/proposal-context.test.ts`: "fix the spec test,"
      "read the design doc," "explain this ADR," and a code-only task. Done when none of them
      matches.
- [ ] 1.3 Point `proposalContextForPrompt` at the new check in
      `src/cli/commands/proposal-context.ts`. Test: `src/cli/commands/orient-inject.test.ts`. Done
      when a Spec Kit prompt gets the block after its task orientation and an ordinary prompt gets
      the same output as before.

## 2. Instruction text

- [ ] 2.1 Reword `openSpecProposalContext` in `src/cli/commands/proposal-context.ts` to say "plan
      or spec files"; keep the header line and the function name. Tests:
      `src/cli/commands/proposal-context.test.ts`, `src/pi/extension.test.ts`. Done when both pass
      and the text contains no framework name.
- [ ] 2.2 When the spec-layout detector from `spec-framework-neutrality` is present, add one line
      with the detected path and format in `src/cli/commands/orient-inject.ts`
      (`buildProposalOnlyInjection`). Test: `src/cli/commands/orient-inject.test.ts`. Done when the
      line appears for a detected layout and is absent otherwise. Skip this task until that change
      lands.

## 3. Harness delivery

- [ ] 3.1 Confirm Pi uses the same function: `src/pi/extension.ts` (`before_agent_start`). Test:
      `src/pi/extension.test.ts`. Done when a Spec Kit prompt adds the block in the default
      on-demand mode and an ordinary prompt adds nothing.
- [ ] 3.2 Update the `--proposal-only` help text in `src/cli/commands/orient.ts` to say "plan or
      spec," and confirm `src/cli/install/adapters/codex.ts` needs no change. Test:
      `src/cli/install/adapters/codex.test.ts`. Done when the Codex hook prints the block for a
      plain "write an implementation plan" prompt and the installed hook entry is byte-identical.

## 4. Docs and checks

- [ ] 4.1 Update `docs/install.md` and the `orient --proposal-only` row in `docs/cli-reference.md`
      to describe plan and spec prompts in any workflow. Done when neither says the hook is
      OpenSpec-only.
- [ ] 4.2 Run `openspec validate add-openspec-proposal-orientation` and
      `npx vitest run src/cli/commands/proposal-context.test.ts src/cli/commands/orient-inject.test.ts src/pi/extension.test.ts src/cli/install/adapters/codex.test.ts`.
      Done when all pass.
