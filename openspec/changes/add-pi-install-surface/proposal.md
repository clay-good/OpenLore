## Why

Pi was not available through OpenLore's primary `install` and `connect` onboarding paths. The
older `setup --tools pi` route also copied plain `tsc` output out of the OpenLore package, so
its relative imports no longer resolved and Pi could not load the installed extension.

## What Changes

- Add Pi to install-surface detection, explicit `--agent` selection, `connect`, and status.
- Install a fingerprinted re-export shim that keeps the compiled extension inside the
  OpenLore package where its relative imports resolve.
- Migrate OpenLore's known broken copies and stale shims without claiming user-authored
  extensions.
- Keep install, dry-run, force, uninstall, and the legacy `setup` route behavior aligned.
- Exercise the shim through Pi's real extension loader and on Windows CI.

## Capabilities

### Modified Capabilities

- `cli`: Pi becomes a first-class, idempotent install surface with an explicit managed-file
  ownership and migration contract.

## Impact

- `src/cli/install/adapters/pi.ts` and `src/cli/install/pi-extension.ts`
- `src/cli/install/detect.ts`, `src/cli/install/index.ts`, and `src/cli/commands/connect.ts`
- `src/cli/commands/setup.ts`
- Pi installation documentation and cross-platform CI coverage
