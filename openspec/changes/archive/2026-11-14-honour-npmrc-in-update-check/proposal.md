# Proposal

## Why

The update check calls `https://registry.npmjs.org/openlore/latest` with `fetch`. That ignores
`.npmrc`. Behind a private registry such as Nexus — a proxy or mirror, with a token, a company CA,
or an HTTP proxy — the request fails or goes around the registry the user actually installs from.
The failure is silent by design, so the user never learns that a new version exists, and a mirrored
release is never even the version compared.

## What Changes

- The version lookup asks npm itself: `npm view openlore@latest version --json`, run with fixed
  arguments and no shell. npm owns the transport, so the registry, credentials, CA, and proxy from
  `.npmrc` all apply.
- The lookup runs in the user's home directory, never in the analyzed repository. A repository's own
  `.npmrc` is repo-controlled input and must not steer the check.
- If npm cannot be found (`ENOENT`), the check falls back to the direct registry URL, which is the
  behavior of today. Every other failure keeps the existing fail-silent result.
- The background refresh detaches the npm child process and kills it when OpenLore exits, so no
  process is left behind.
- Answers are read in every shape npm and the registry produce: an array (npm 10/11), a bare string
  (older npm), and the `{ version }` document.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `cli`: `PassiveUpdateNotifier` gains the transport rule — the check goes through npm, honours
  `.npmrc`, and never runs in the analyzed repository.

## Impact

- Code: `src/core/services/update-notifier.ts` and its test. It reuses `resolvePlatformCommand`
  from `src/utils/platform-command.ts` for the Windows npm entry point.
- No new dependency. `execFile` on npm replaces one `fetch` call, and the fetch path stays as the
  fallback.
- Behavior for a user on the public registry does not change, apart from the lookup cost (about 1 s
  through npm instead of one HTTP request), which the background refresh already absorbs.
