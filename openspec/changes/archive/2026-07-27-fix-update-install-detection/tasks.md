# Tasks — fix-update-install-detection

## Implementation
- [x] Normalize the module path (forward + back slashes) before any matching in `detectInstallMethod`
- [x] Global-vs-local discrimination: compare resolved package root against `npm root -g`
      (local subprocess) and detect an `openlore` dependency in the enclosing project's
      `package.json`; contradictory/absent evidence → `'unknown'`
- [x] Add `'npm-local'` to `InstallMethod`; `runUpdate` on `npm-local` prints
      `npm install openlore@latest` (no `-g`) and runs NOTHING global
- [x] Keep npx / Homebrew branches, made separator-agnostic
- [x] `'unknown'` keeps the existing manual-fallback message (disclosed indeterminacy)

## Verification
- [x] Unit tests for path/evidence shapes: macOS+Linux global, Homebrew Cellar, project-local,
      npx cache, Windows global (backslash), Windows local — each yields the correct method
- [x] Test: `npm-local` never spawns `npm install -g` (guaranteed structurally: the classifier
      yields `npm-local` only on positive local evidence, `upgradeCommandFor('npm-local')` carries
      no `-g`, and `runUpdate`'s `npm-local` branch prints and returns before any spawn)
- [x] Test: indeterminate evidence → `'unknown'` + manual instructions, exit code as today
- [x] `--dry-run` prints the correct per-method command for every method (the `npm-local` branch
      always prints, dry-run or not)
- [x] Full suite green (296 files / 5810 tests)

## Spec
- [x] `cli` delta: ADD UpdateDetectsInstallMethodCorrectly
