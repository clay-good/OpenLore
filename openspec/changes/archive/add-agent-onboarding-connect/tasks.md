# Tasks — One-command, idempotent agent onboarding (`openlore connect`)

> Delivered by enhancing the existing `openlore install` engine + a thin `connect` front-end (PR #161).
> All items complete. No new tool; reuses `block.ts`, `json-managed.ts`, and the adapters.

## 1. `--preset` on the install engine
- [x] Add `preset` to `InstallOptions` and `ApplyContext`; validate (only when given) against
      `TOOL_PRESETS` via a dynamic import; unknown preset → exit 2, no writes.
- [x] Thread the preset into the claude-code and cursor adapters' MCP entry (`openlore mcp --preset X`).
- [x] Add `--preset <name>` to the `install` (and `connect`) command surface.
- [x] Test: preset threaded into `.mcp.json`; no preset → plain args; unknown preset → exit 2, no file.

## 2. Run-permission wiring (claude-code)
- [x] Apply: append `Bash(openlore:*)` to `.claude/settings.local.json` `permissions.allow` if absent,
      format-preserving, preserving existing permissions.
- [x] Uninstall: strip only our entry; delete the file if it was OpenLore-only.
- [x] Test: idempotent add (no duplicate on re-run); user permission preserved; reversible uninstall.

## 3. `openlore connect` front-end
- [x] `connect [agent]` delegates to `runInstall`; no agent + TTY → `@inquirer/prompts` multi-select
      (pre-checked from detection); non-TTY → detection fallback.
- [x] `connect list` prints every supported agent + status; `connect remove [agent]` delegates to
      `--uninstall`.
- [x] Register `connect` in the CLI root.
- [x] Test: connect delegates (markdown agent gets the managed block); remove disconnects.

## 4. Preset-insensitive status
- [x] Add `isConnected(root)` to the `Adapter` contract; markdown adapters use a shared
      `hasManagedBlock` presence check, continue uses managed-JSON meta presence.
- [x] `surfaceStatus()` (exported from install) uses `isConnected`; `connect list` consumes it.
- [x] Test: status reports connected after wiring with a non-default preset (presence, not equality).

## 5. Surface discipline
- [x] No new MCP tool; `connect` is a CLI verb only. No change to `MINIMAL_TOOLS` or the default surface.
- [x] No duplicated engine: adapters, `block.ts`, `json-managed.ts` reused as-is.

## 6. Verification
- [x] `connect.test.ts` (10) green; existing `install` suite (47) green; full `vitest run src`
      (185 files, 3858 passed) green; `typecheck` + `eslint` clean.
- [x] Dogfood on a temp repo: connect (with `--preset`), idempotent re-run, `connect list`, remove —
      all verified, user content preserved.

## 7. Docs
- [x] `proposal.md` rewritten to reflect the enhance-install approach and marked IMPLEMENTED.
- [x] `cli` spec delta updated to the shipped requirements.
