# Windows invocation surface: spawns that ENOENT, configs that can't launch, and no support statement

> Status: BUILT (2026-08-22). PR #391 implements the shared resolver, generated-config updates,
> shipped skill fallback, explicit support statement, and required Windows smoke coverage. The
> first CI run passed Windows Smoke (5m50s), Unit Tests (5m6s), build, lint/type-check, CodeQL, and
> the aggregate CI Success gate. On Windows, `openlore update` previously spawned
> `npm`/`brew` without shell resolution (they are `.cmd` shims → ENOENT), and every generated
> agent config hardcodes bare `npx` that MCP clients spawning directly cannot resolve. Meanwhile
> nothing anywhere states what platforms are supported. One platform-aware command-resolution
> helper for both surfaces, plus either a Windows CI smoke job or an explicit documented support
> tier — working or disclosed, never implied-working.

## Why

- **`openlore update` cannot execute its own upgrade on Windows.** `runCommand`
  (`src/cli/commands/update.ts:53-59`) calls `spawn(cmd, args, { stdio: 'inherit' })` with no
  `shell: true` and no `.cmd` resolution; `upgradeCommandFor` (`update.ts:42-51`) selects `npm` or
  `brew`, which on Windows are batch shims (`npm.cmd`) that bare `spawn` cannot execute → the
  `'error'` handler resolves 127 and the user gets "Upgrade command exited with code 127". The
  sibling change `fix-update-install-detection` fixes Windows *detection* (backslash paths
  currently fall through to `unknown`) but explicitly not the spawn mechanism — this change is
  the other half; together they make `update` viable on Windows.
- **Generated agent configs hardcode bare `npx`.** The Claude Code adapter writes
  `command: 'npx'` for the MCP server (`src/cli/install/adapters/claude-code.ts:38`) and
  `npx --yes openlore orient …` hook commands (`claude-code.ts:56-57`); Cursor
  (`adapters/cursor.ts:30`) and Continue (`adapters/continue.ts:23`) do the same. An MCP client
  spawning the server directly on Windows cannot execute that batch shim without an explicit
  launch boundary. This is a real gap,
  not out-of-scope: the tree already carries win32 intent — `skills/openlore-orient/scripts/orient.ps1`
  exists and `src/pi/extension.ts:359,425` branch on `process.platform === 'win32'` — so the
  install adapters are the surface that never got the treatment.
- **No platform-support statement anywhere.** `package.json` has no `os` field; the README's only
  platform-specific content is a Nix/NixOS snippet (`README.md:207`). A Windows user cannot tell
  whether a broken spawn is their environment or an unsupported platform.

## What Changes

**Platform-aware command resolution in one shared helper; support honestly stated.**

- One dependency-light helper (`resolvePlatformCommand`) owns the Windows rule: discover a real,
  absolute npm CLI entry point and invoke it through the absolute running `node.exe`, while
  passing commands through unchanged elsewhere. Both surfaces use it: update evidence/upgrades
  and the adapter-generated MCP, hook, and slash commands. This avoids both direct `.cmd`
  execution and shell parsing, validates the discovered entry point before emitting a command,
  and keeps the rule in one place.
- Generated configs become platform-correct at generation time: `openlore install` run on Windows
  writes the resolvable command; docs note that a config generated on one OS and reused on
  another may need regeneration (deterministic, disclosed).
- **Working or disclosed:** add a minimal Windows CI smoke job (install → `openlore --version` →
  `openlore analyze` on a fixture) if maintenance cost allows; otherwise ship an explicit support
  statement instead — README support matrix (macOS/Linux: supported; Windows: best-effort,
  tier 2) and, if best-effort is chosen, a one-line platform notice from `doctor` on win32. The
  decision between the two is an implementation task; silence is not an option.

## Why this is in scope

The install adapters and updater are the product's hands on the user's machine; a spawn that
ENOENTs or a generated config the client can't launch is a first-run failure with no diagnostic.
The honesty contract extends to platform claims: either the invocation surface works on Windows
or the docs say plainly that it doesn't. The tree's existing win32 branches show the intent —
this closes the two surfaces that missed it, deterministically, with one helper and no new
constants.

## Impact

- Files: `src/cli/commands/update.ts` (`runCommand`), `src/cli/install/adapters/claude-code.ts`,
  `cursor.ts`, `continue.ts` (+ the shared helper's home), README support statement,
  optional `.github/workflows` smoke job, optional doctor notice.
- Specs: `cli` — 1 ADDED requirement (WindowsInvocationResolvesOrDiscloses).
- Tool surface: unchanged (no MCP tool change; generated config contents change on win32 only).
- Risk: low. macOS/Linux behavior is byte-identical (helper is pass-through off win32);
  cross-references `fix-update-install-detection` to keep the two Windows halves of `update`
  scoped without overlap.
