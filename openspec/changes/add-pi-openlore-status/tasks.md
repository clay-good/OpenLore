# Tasks

## 0. Dependency-light health read

- [x] 0.1 In `src/api/health.ts`, replace the `readDescriptor` import from `cli/commands/serve.js` with `readServeDescriptor(<root>/.openlore/serve.json, { includeDraining: true })` from `cli/commands/serve-descriptor.js` (design.md Decision 1b). Verify that `npx vitest run src/api/health.test.ts src/api/host-reads-contract.test.ts` passes unchanged.
- [x] 0.2 Add `src/pi/extension-imports.test.ts`. It walks the relative-import graph of `src/pi/extension.ts` and fails when the graph reaches `cli/commands/serve.ts`, `core/services/edge-store.ts`, `core/services/mcp-watcher.ts`, `api/analyze.ts`, or `core/analyzer/call-graph.ts`. Verify that it passes, and that it fails when a `serve.js` import is added to `health.ts` for a temporary check.

## 1. Status model and formatter

- [x] 1.1 Add the `DaemonView` type (`connecting | usable | incompatible | spawn-disabled | unavailable`) and the exported `@internal` pure `formatPiStatus` in `src/pi/extension.ts`. Use the text table and precedence in design.md Decision 4. Verify with table-driven unit tests in `src/pi/extension.test.ts`: one case per table row, plus the precedence cases (absent index and incompatible daemon gives "no index"; unknown watcher never shows "watcher stopped"; "ready" only when the index is `ready` and the daemon is `usable`).
- [x] 1.2 Record the daemon view per `cwd` in `getDaemon` (`registerOpenlore`). Map a usable daemon to `usable`, one with `incompatibility` to `incompatible`, `failureKind: 'spawn-disabled'` to `spawn-disabled`, and every other failure or negative-cache hit to `unavailable`. Verify with a unit test that drives `getDaemon` through spawn-disabled and incompatible fakes and checks the stored view.

## 2. Cached health read

- [x] 2.1 Add a per-`cwd` health cache. Key it on the `(mtimeMs, size)` of each `REQUIRED_ANALYSIS_ARTIFACTS` entry, on whether the analysis lock is present, and on the `DaemonView`. Call `openloreHealth({ rootPath: cwd })` only on a key change or after a `building` result. Verify with a test: two updates with no change call the health read once; touching an artifact calls it again.
- [x] 2.2 On a cache hit with a usable daemon, re-probe only the watcher (`readWatcherState`); never cache it. On a refresh with no usable daemon cached, call `getDaemon` again. Verify with tests: a watcher that stops and restarts between runs shows in the status with one health read; a daemon that comes up after a failed start shows `ready` after the next run.
- [x] 2.2 Make a health read that throws give `openlore: status unknown` and never reject. Verify with a test that stubs the read to throw and asserts that the `agent_end` handler resolves and the status text is correct.

## 3. Lifecycle wiring

- [x] 3.1 Add a `refreshStatus(ctx)` helper. It does nothing when `!ctx.hasUI`, uses only the `ctx` passed to it, and catches every error. Verify with a test that a print/json-mode `ctx` gets no `setStatus` call.
- [x] 3.2 In `session_start`, set `openlore: connecting…` before `getDaemon`, then call `refreshStatus` after it. Verify with a test that records the `setStatus` calls in order (connecting, then the resolved text) on a repository with a ready index.
- [x] 3.3 Register `agent_end` to call `refreshStatus`. Verify with a test that moves the fixture from lock-held/no-index to a ready index between two runs, and asserts that the status changes from `analyzing…` to `ready`.
- [x] 3.4 In `runConfigWizard`'s analyze branch, call `refreshStatus` after success and after failure. Verify with the existing wizard-analyze test fakes by asserting a `setStatus('openlore', …)` call after the analyze outcome.
  - Done as: no wizard-analyze fakes existed. The test puts a failing `openlore` binary on `PATH` and asserts that `afterAnalyze` runs once with the wizard's `ctx`. All three wizard call sites pass `refreshStatus` as `afterAnalyze`.
- [x] 3.5 In `session_shutdown`, call `ctx.ui.setStatus('openlore', undefined)` when `ctx.hasUI`, and keep the existing keepalive teardown. Verify with a test that asserts the clear call.

## 4. Guards, docs, and verification

- [x] 4.1 Update the `src/pi/extension.ts` line anchors in `src/core/services/tls-coverage.test.ts`, then run `npx vitest run src/core/services/tls-coverage.test.ts` and verify that it passes.
- [x] 4.2 Document the status states and their meaning in `examples/pi/README.md`, and add an Unreleased entry to `CHANGELOG.md`. Verify by reading the rendered sections.
- [x] 4.3 Run `select_tests` for the diff and the Pi suite (`npx vitest run src/pi`), then `npm run typecheck` and lint. Verify that all pass.
  - Result: tsc and eslint clean. Full suite: 10245 passed, 22 failed. The same 22 fail on clean `HEAD` (analyzer Dart/Lua grammars, version strings, doctor, platform-command), so none are from this change.
- [x] 4.4 Run a manual smoke test in a real Pi TUI session. Check that the footer shows `openlore: connecting…` and then `openlore: ready` on this repository, `openlore: no index (run openlore analyze)` on a fresh repository, and that `pi -p` shows no status. Record the observed text in the PR description.
  - Done as: the real Pi 0.85.1 host in RPC mode (`pi --mode rpc -ne -e dist/pi/extension.js`). RPC sends the same `setStatus` call as the TUI. This repository showed `connecting…` → `ready` (`analyzing…` on an earlier run while a daemon repair held the index), a fresh repository showed `connecting…` → `no index (run openlore analyze)`, shutdown sent a clear, and `pi -p --mode json` sent no `setStatus`. The TUI footer rendering was not observed.
- [x] 4.5 Run `openspec validate add-pi-openlore-status --strict` and verify that it passes.
