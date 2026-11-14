# Tasks

## 1. Slim digest

- [ ] 1.1 Add `renderSlimDigest` to `src/core/analyzer/codebase-digest.ts` and write
      `.openlore/analysis/CODEBASE.slim.md` (new file) in `generateCodebaseDigest`, framed with
      `frameServedContent`. Test: `src/core/analyzer/codebase-digest.test.ts`. Done when the file
      is 12 lines or fewer for a small fixture and for this repository, and `CODEBASE.md` is
      byte-identical to before.
- [ ] 1.2 Leave out the spec and decision line when the repository has neither, in
      `src/core/analyzer/codebase-digest.ts`. Test: `src/core/analyzer/codebase-digest.test.ts`.
      Done when a fixture with no `openspec/` directory produces a digest that names no spec
      framework.

## 2. Delivery at the prompt-submitted moment

- [ ] 2.1 In `buildInjection` (`src/cli/commands/orient-inject.ts`), print the slim digest before
      the task block on the first prompt of a session. Import the per-session record helpers from
      `src/core/services/hook-session.ts` (hook-reliability task 3.1) and key the delivery on the digest's content hash. Test:
      `src/cli/commands/orient-inject.test.ts`. Done when the first prompt carries the digest, the
      second does not, and a changed digest is printed once more.
- [ ] 2.2 Print nothing extra when the payload has no `session_id`, when
      `contextInjection.mode` is `off`, or when the slim file is absent. Test:
      `src/cli/commands/orient-inject.test.ts`. Done when all three cases give the same output as
      today.
- [ ] 2.3 Keep the digest inside the injection token budget: count it in `renderInjectionBlock`'s
      budget in `src/cli/commands/orient-inject-render.ts`. Test:
      `src/cli/commands/orient-inject.test.ts`. Done when digest plus task block never exceeds
      `contextInjection.tokenBudget`, and the task block is the part that is kept when both do not
      fit.

## 3. Plugin skills

- [ ] 3.1 Cut `skills/openlore-debug/SKILL.md`, `skills/openlore-review-changes/SKILL.md`,
      `skills/openlore-write-tests/SKILL.md`, and `skills/openlore-implement-story/SKILL.md` to 80
      lines or fewer each; `skills/openlore-orient/SKILL.md` already fits. Each names only
      `plugin` tools and ends with the three actions. Test: `src/cli/install/skill-wrapper.test.ts`.
      Done when the line budget and frontmatter checks pass for all five.
- [ ] 3.2 Add a tool-name check to `src/cli/install/skill-wrapper.test.ts`: every OpenLore tool a
      plugin skill names is in `presetToolNames('plugin')` (`src/core/services/wired-preset.ts`).
      Done when a skill that names `get_change_coupling` fails the test.
- [ ] 3.3 Copy the five skills to `plugin/skills/<name>/SKILL.md` (folder from
      `ship-claude-code-plugin`) and assert in `src/cli/install/skill-wrapper.test.ts` that each
      copy is byte-identical to `skills/`. Done when editing one side alone fails the test.
- [ ] 3.4 Confirm `openlore setup` still installs every canonical skill:
      `src/cli/commands/setup.ts`. Test: `src/cli/commands/setup-hooks.test.ts`. Done when the
      installed skill list is unchanged.

## 4. Docs and checks

- [ ] 4.1 Update `plugin/README.md` and `docs/agent-setup.md`: list the five skills and describe
      the once-per-session digest. Done when both name the same five skills.
- [ ] 4.2 Run `openspec validate adopt-agent-context-interop` and
      `npx vitest run src/core/analyzer/codebase-digest.test.ts src/cli/commands/orient-inject.test.ts src/cli/install/skill-wrapper.test.ts src/pi/extension.test.ts`.
      Done when all pass (the Pi parity guard is unchanged because no tool output shape changes).
