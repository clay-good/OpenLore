## Why

The agent-facing guidance OpenLore generates prescribes tools the installed surface does not expose. `ai-config-generator.ts:90` writes "call `record_decision` **before** writing the code", with a warning at line 106 that the pre-commit gate will be slow otherwise — but `record_decision` is absent from the default `substrate` preset. On the external repository where this surfaced, one task of an active change stayed blocked for the whole session until the server was reinstalled with `--preset full`. The generator has no knowledge of the preset at all: the string `preset` does not appear in the file.

The same file (and `templates/agent-instructions.md`) prescribes calling `orient()` before reading source files, unconditionally. The session that reported this used `orient` almost never and went straight to `rg` and `Read` — because nearly every turn was "write tests for file X", where X was already known. That is the honest answer, not a failure of discipline: `orient`'s value is high on cross-module work in unfamiliar code and low on dense work inside an open file. An absolute instruction that is routinely ignored trains the agent to ignore the instruction set, which then costs on the turn where orienting would have paid.

## What Changes

- Make the generated guidance preset-aware. A prescription may name only tools present in the wired surface; a prescription that requires an absent tool is either omitted or emitted with the exact install command that provides it.
- Regenerate the managed guidance block when the wired preset changes, so guidance and surface cannot drift apart across reinstalls.
- Replace the absolute orient instruction with a conditional one — orient before touching a module not yet read in this session, or when the task spans modules — and state the reason, so the instruction is followed rather than habituated away.
- Make this a contract, not a copy edit: a test SHALL fail when generated guidance names a tool the default preset does not expose.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `analyzer`: Generated agent configuration is preset-aware and prescribes only callable tools.
- `cli`: `openlore install` regenerates the managed guidance block on a preset change and reports the surface the guidance was written for.

## Impact

- `src/core/analyzer/ai-config-generator.ts` and its tests.
- `src/cli/install/index.ts` (preset resolution already exists at lines 200-219; thread it into generation), `src/cli/install/templates/agent-instructions.md`, `block.ts`.
- A new conformance test alongside `default-preset-single-source.test.ts` asserting guidance/preset coherence.
- Repositories that gate commits on decisions keep working: guidance now names `--preset full` explicitly instead of assuming it.
