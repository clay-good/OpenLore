# Tasks

## 1. Slim digest

- [x] 1.1 Add `renderSlimDigest` to `src/core/analyzer/codebase-digest.ts` and write
      `.openlore/analysis/CODEBASE.slim.md` (new file) in `generateCodebaseDigest`, framed with
      `frameServedContent`. Test: `src/core/analyzer/codebase-digest.test.ts`. Done when the file
      is 12 lines or fewer for a small fixture and for this repository, and `CODEBASE.md` is
      byte-identical to before. (Proof: 8 lines on a fixture and 9 on this repository; `cmp` of
      `CODEBASE.md` from main's build and this build matched on both.)
- [x] 1.2 Leave out the spec and decision line when the repository has neither, in
      `src/core/analyzer/codebase-digest.ts`. Test: `src/core/analyzer/codebase-digest.test.ts`.
      Done when a fixture with no `openspec/` directory produces a digest that names no spec
      framework. Decisions count only `adr-*.md` files, as every other decision reader does.
- [x] 1.3 (added by review) Each fact line follows a fixed grammar (`SLIM_FACT_GRAMMAR`): numbers,
      plain names, plain paths, registered languages. Counts use distinct resolved caller-callee
      pairs; synthesized dispatch edges are left out. "Most callers" lists only functions with two
      callers or more and never an arbitrary pick from a tie at the cut. A stale slim digest is removed at the start of
      every run. Test: `src/core/analyzer/codebase-digest.test.ts`.

## 2. Delivery at the prompt-submitted moment

- [x] 2.1 In `injectOutput` (`src/cli/commands/orient.ts`, where the hook's `session_id` is known;
      `buildInjection` has no session), print the slim digest before the task block on the first
      prompt of a session, keyed in the per-session record on a hash of what it names (numbers
      left out, so the agent's own edits do not reprint it). Test:
      `src/cli/commands/orient-inject-slim-digest.test.ts`. Done when the first prompt carries the
      digest, the second does not, a digest naming something new is printed once more, a count-only
      change is not, and content that changes back is printed again.
- [x] 2.2 Print nothing extra when the payload has no `session_id`, when `contextInjection.mode` is
      `off`, when the slim file is absent, when there is no index or it was imported, for a
      `<task-notification>` prompt, and for a file that is not byte-for-byte what analyze writes
      (`isWellFormedSlimDigest`). Test: `src/cli/commands/orient-inject-slim-digest.test.ts`.
- [x] 2.3 Keep the digest inside the injection token budget. Test: same file. Done when digest plus
      task block never exceeds `contextInjection.tokenBudget`, and the task block is kept when both
      do not fit (the digest waits and is not marked delivered). Printed order: digest, then task
      block; the catch-up block of `add-session-catch-up-briefing` goes after the digest.
- [x] 2.4 (added by review) A compaction marks the digest as not delivered (`hook after-compact`),
      `openlore analyze` on an unchanged source rebuilds a slim digest that is missing, in an old
      format, or out of date with the specs and ADRs on disk
      (`ensureSlimDigestCurrent`, tested in `codebase-digest.test.ts`), the
      digest read is quiet on stderr, and `readFindingOutcomes` no longer counts notices as findings.
      `writeSession` never writes or prunes through a symlinked record folder and prunes only its
      own records and their stale temp files. A golden hash pins `CODEBASE.md` bytes to the output
      of main's build. Tests: `orient-inject-slim-digest.test.ts`, `hook-session.test.ts`,
      `hook-health.test.ts`.

## 3. Plugin skills

- [x] 3.1 Cut `skills/openlore-debug/SKILL.md`, `skills/openlore-review-changes/SKILL.md`,
      `skills/openlore-write-tests/SKILL.md`, and `skills/openlore-implement-story/SKILL.md` to 80
      lines or fewer each, and refresh `skills/openlore-orient/SKILL.md`. Each names only tools the
      plugin can call and ends with the three actions. Test: `src/cli/install/skill-wrapper.test.ts`.
- [x] 3.2 Add a tool-name check to `src/cli/install/skill-wrapper.test.ts`: every OpenLore tool a
      plugin skill names is in both `TOOL_PRESETS.plugin` and the preset `plugin/.mcp.json` wires.
      Done when a text that names `get_change_coupling` fails the check.
- [x] 3.3 Copy the five skills to `plugin/skills/<name>/SKILL.md` and assert in
      `src/cli/install/skill-wrapper.test.ts` that each copy is byte-identical to `skills/`. The
      compatibility copies under `examples/` are kept identical too
      (`src/core/services/spec-workflow-skills.test.ts`).
- [x] 3.4 Confirm `openlore setup` still installs every canonical skill:
      `src/cli/commands/setup.ts`. Test: `src/cli/commands/setup-hooks.test.ts`. Done when the
      installed skill list is unchanged.

## 4. Docs and checks

- [x] 4.1 Update `plugin/README.md` and `docs/agent-setup.md`: list the five skills and describe
      the once-per-session digest. Done when both name the same five skills.
- [x] 4.2 Run `openspec validate adopt-agent-context-interop` and
      `npx vitest run src/core/analyzer/codebase-digest.test.ts src/cli/commands/orient-inject.test.ts src/cli/install/skill-wrapper.test.ts src/pi/extension.test.ts`.
      Done when all pass (the Pi parity guard is unchanged because no tool output shape changes).
