# Tasks

## 1. Managed block

- [x] 1.1 Rewrite `src/cli/install/templates/agent-instructions.md` to 8 lines or fewer. Test:
      `src/cli/install/install.test.ts` (both scopes, upgrade, CRLF). Done when both
      scopes write the short block and a re-install replaces the old block inside its markers.
- [x] 1.2 Add a size guard for the block (8 lines, 700 bytes) to `src/cli/install/install.test.ts`.
      Done when one more line fails the test.

## 2. Generated `CLAUDE.md`

- [x] 2.1 In `buildContent` (`src/core/analyzer/ai-config-generator.ts`), write a one-line path
      pointer to `CODEBASE.md` instead of the `@`-import, gated on the slim digest reaching the agent
      (`slimDigestReachesAgent`; built stricter than "the file exists" after review). Tests:
      `src/core/analyzer/ai-config-generator.test.ts`, `src/cli/commands/analyze-ai-configs.test.ts`,
      `src/cli/commands/slim-digest-delivery.test.ts`. Done when a fresh repository gets no
      `@`-import and a repository without `CODEBASE.slim.md` keeps it.
- [x] 2.2 Cut `buildMcpSection` to the `orient` line and the decisions line. Test:
      `src/core/analyzer/guidance-preset-coherence.test.ts`. Done when the section is 10 lines or
      fewer for every preset and still names no tool outside the wired preset.
- [x] 2.3 Remove the "Agent setup (one-time)" table that `openlore analyze` prints
      (`src/cli/commands/analyze.ts:1033-1047`); print the one pointer line. Test:
      `src/cli/commands/analyze.test.ts`, `src/cli/commands/analyze-ai-configs.test.ts` (printed output).
      Done when the printed tip names no tool table.
- [x] 2.4 `openlore status` names a legacy `@.openlore/analysis/CODEBASE.md` line outside the
      managed markers, with its size, once. Test: `src/cli/commands/status.test.ts`. Done when the
      line shows for a legacy file and not for a new one.

## 3. Tool descriptions

- [x] 3.1 Cut every `TOOL_DEFINITIONS` description over 800 characters (`src/cli/commands/mcp.ts`).
      Keep each disclosure the `mcp-quality` spec requires. Test: a new check in
      `src/core/services/mcp-handlers/tool-contract.test.ts`. Done when all descriptions are 800
      characters or fewer and the ROADMAP P0 row is removed. (The row was already gone after the
      roadmap rewrite in #819; the guard is the lasting check.)
- [x] 3.2 Re-measure the Pi and MCP token budgets the existing tests pin. Done when the budget
      tests pass with the new numbers.

## 4. This repository

- [x] 4.1 Replace the tool table in this repository's `CLAUDE.md` with a pointer to
      `docs/mcp-tools.md`. Test: `src/honesty-contract.test.ts` and `src/doc-claim-sync.test.ts`.
      Done when `CLAUDE.md` is under 8 KB and both tests pass.
