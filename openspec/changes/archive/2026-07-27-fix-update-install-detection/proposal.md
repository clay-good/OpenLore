# Fix `openlore update` install-method detection: never mutate the wrong install

> Status: SHIPPED (2026-07-18, PR #237; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). `detectInstallMethod` classifies ANY path containing
> `/node_modules/openlore/` as a global npm install, so `openlore update` run from a project-local
> dependency executes `npm install -g openlore@latest` — mutating global state the user never asked
> to touch — and Windows global installs fall through to `unknown`. Deterministic detection with an
> honest `unknown`, and a local-install path that prints the right command instead of running the
> wrong one.

## The gap

`src/cli/commands/update.ts:27-39` (`detectInstallMethod`) infers the install method from the
executing module's path with substring checks:

1. **Project-local misclassified as global.** `p.includes('/node_modules/openlore/')`
   (`update.ts:35`) matches a project-local dependency (`<project>/node_modules/openlore/...`)
   just as well as a global prefix. `upgradeCommandFor('npm-global')` (`update.ts:47`) then runs
   `npm install -g openlore@latest`: the user's pinned project dependency is untouched (still
   outdated) while an unrelated global install is created or mutated — a side effect outside the
   project the command was invoked in.
2. **Windows never matches.** Both branches test forward-slash substrings; a Windows global path
   (`C:\Users\...\AppData\Roaming\npm\node_modules\openlore\...`) uses backslashes, so detection
   returns `'unknown'` and every Windows user gets the manual-upgrade fallback (`update.ts:95-102`)
   — silent degradation, not a crash, but the feature simply never works there.
3. **No local-install story at all.** `InstallMethod` (`update.ts:21`) has no `npm-local` member;
   there is no path that tells a project-dependency user the correct command
   (`npm install openlore@latest`, no `-g`).

## What changes

**Detection becomes evidence-based, path-separator-agnostic, and honest about indeterminacy; a
local install gets advice, not a global mutation.**

- Normalize the module path (both separators) before matching; Homebrew and npx branches keep
  their existing signals, made separator-agnostic.
- Distinguish global from local deterministically: resolve the package root from the module path,
  then (a) compare it against `npm root -g` / `npm prefix -g` output (one local subprocess, no
  network), and/or (b) detect a `package.json` in the working project declaring an `openlore`
  dependency. Exact mechanism chosen at implementation; each check is a local command or file read.
- New `'npm-local'` method: `openlore update` does NOT run anything global — it reports the newer
  version and prints the per-project command (`npm install openlore@latest`), leaving the choice
  of mutating the project's lockfile to the user.
- When the evidence is contradictory or absent, the verdict is `'unknown'` and the existing manual
  fallback text is shown — disclosed indeterminacy, never a guess that mutates state.
- Tests cover the path shapes: macOS/Linux global (`/usr/local/lib/node_modules/`,
  `/opt/homebrew/lib/node_modules/`), project-local (`<project>/node_modules/openlore/`), npx
  cache (`/_npx/<hash>/node_modules/`), Homebrew Cellar, and Windows global/local backslash paths.

## Why this is in scope

An `update` command that answers "how was I installed?" with a substring guess and then acts on it
violates the honesty contract in the most concrete way possible: it *mutates the wrong thing*
outside the project. The fix applies the substrate's own rule — prove the classification from
evidence or return `unknown` and defer to the human — to the one CLI command that changes the
user's machine. Local-first: the only network call remains the existing npm dist-tag lookup.

## Impact

- Files: `src/cli/commands/update.ts` (`detectInstallMethod`, `upgradeCommandFor`, `runUpdate`,
  `InstallMethod` union), new unit tests for the path/evidence matrix.
- Specs: `cli` — 1 ADDED requirement (UpdateDetectsInstallMethodCorrectly).
- Tool surface: unchanged (CLI-only; no MCP change).
- Risk: low. Worst case of the new logic is a conservative `'unknown'` → manual instructions —
  strictly safer than today's wrong global mutation. `--dry-run` (`update.ts:105-108`) already
  exists for verifying the chosen command without running it.
