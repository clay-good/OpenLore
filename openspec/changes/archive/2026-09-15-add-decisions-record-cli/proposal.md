## Why

A decision can be recorded only through the `record_decision` MCP tool. The default MCP surface
(`substrate`, ADR-0023) does not include that tool, so a collaborator who installs OpenLore with
default settings cannot record a decision, and the pre-commit decisions gate blocks them. The CLI
already tells users to run `openlore decisions --record`, but that option does not exist.

## What Changes

- Add `openlore decisions record`, which records a draft decision with the same behavior as the
  `record_decision` MCP tool: the same id, the same "already decided" verdict, anchors, and
  background consolidation. Options: `--title`, `--rationale`, `--consequences`, `--files`,
  `--supersedes`, `--scope`, `--constraints-file`, `--json`.
- Replace the two messages that name the non-existent `openlore decisions --record` with the new
  command.
- When `record_decision` is not in the wired preset, the generated agent guidance names the CLI
  command as the way to record a decision, instead of saying that the workflow is unavailable.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli`: a new requirement for recording decisions from the CLI, and for the gate and guidance
  messages that point to it.

## Impact

- `src/cli/commands/decisions.ts`: new `record` subcommand; two message fixes.
- `src/core/analyzer/ai-config-generator.ts`: fallback guidance text.
- Tests: new CLI tests; `guidance-preset-coherence.test.ts` update.
- Docs: `docs/cli-reference.md` decisions section; `CHANGELOG.md`.
- No MCP change: `record_decision` keeps its contract; the CLI calls the same handler.
