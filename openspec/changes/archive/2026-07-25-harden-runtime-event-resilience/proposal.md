# Harden runtime event resilience: an async 'error' event must not kill a long-lived process

> Status: IMPLEMENTED (2026-07-19). The `.git` ref watcher now registers an `'error'` listener
> (`mcp-watcher.ts`) that discloses once, releases the failed watcher, and degrades to the
> batch-size VCS-flood fallback the surrounding catch already promised — an async chokidar error
> can no longer surface as an unhandled `'error'` event and kill the warm daemon. The source
> watcher's post-`ready` errors, which could only hit a no-op `reject` on a settled promise, are
> now disclosed instead of silently swallowed. The `telemetry --live` tail was extracted into a
> testable `tailTelemetryFile` that (a) attaches a stream `'error'` handler clearing the in-flight
> guard so the file retries on the next event, and (b) detects rotation structurally — a current
> file size below the stored offset means the file was rotated and restarted small, so the offset
> resets to 0 instead of reading silently past EOF forever. Three test files pin it: watcher-error
> survival + post-ready disclosure (real-EventEmitter chokidar mock so `emit('error')` reproduces
> Node's throw-on-no-listener), tail stream-error + rotation-reset, and a grep-shaped coverage
> guard that fails naming any long-lived `chokidar.watch` / read-stream site missing its `'error'`
> listener. No new tuning constant (rotation detection is `size < offset`, a structural fact).
> Originally proposed (2026-07-03, e2e audit follow-up). Two long-lived paths register Node
> event emitters without an `'error'` listener. The MCP watcher's `.git` ref watcher can
> crash the warm serve daemon / MCP server outright — an unhandled `'error'` event on an
> EventEmitter throws, and these processes install no `uncaughtException` handler, so Node's
> default kill applies. The telemetry `--live` tail has the same missing listener plus a
> stale-offset bug after log rotation that silently wedges the tail forever. Attach the
> listeners, degrade with disclosure, and pin the pattern with a cheap coverage test.

## The gap

- **[high] A `.git` watch hiccup kills the daemon.** `mcp-watcher.ts:297-302` registers the
  VCS ref watcher with only `.on('all', ...)` (`:302`) — no `'error'` listener — while the
  sibling `fsWatcher` registers `.on('error', ...)` at `:288`. The surrounding try/catch
  (`:294-306`) guards only synchronous setup; an **async** chokidar `'error'` (FD pressure,
  ref churn during a rebase, EPERM on a locked `.git/index`) is emitted on an EventEmitter
  with no listener, which throws. Neither the serve daemon nor the MCP server registers an
  `uncaughtException` handler (the `ShutdownManager` in `src/utils/shutdown.ts:41-73` would,
  but nothing in production `src/` imports it), so the throw is fatal: the warm daemon every
  connected agent shares dies because a best-effort optimization watcher coughed — the
  inverse of its own comment, which promises fallback "to the batch-size threshold in
  handleBatch" (`:304-305`).
- **[low] The `--live` telemetry tail crashes on stream errors and wedges after rotation.**
  `telemetry.ts` (CLI) `renderLive` → `tail` (`:419-431`) opens
  `createReadStream(filePath, { start: offset })` (`:425`) with only `'data'`/`'end'`
  listeners (`:427-428`); a stream `'error'` (e.g. the file renamed away by rotation between
  the watch event and the open) is unhandled → crashes `--live`. And `inFlight.add(filePath)`
  (`:422`) is cleared only in `'end'` (`:430`), so any error path also wedges that file's
  tail permanently. Separately, rotation (`core/services/telemetry.ts:22-30` renames the file
  at 50 MB, `:18`, `:53`) leaves the `offsets` map pointing beyond the new small file — the
  stream then reads zero bytes and ends cleanly, so the tail goes **silently empty** until
  the file regrows past the stale offset. No crash, no output, no disclosure.

## What changes

1. **`gitWatcher` gets an `'error'` listener** (`mcp-watcher.ts:302`): log once at
   debug/stderr level, close the failed watcher, and degrade to the batch-size VCS
   fallback the catch block already promises — the process never dies for it. While there,
   route post-`ready` `fsWatcher` errors to the same disclosure (today they hit a
   `reject` on an already-settled promise, `:288` — safe but silent).
2. **`tail` gets an `'error'` handler** (`telemetry.ts:425-431`): clear `inFlight`, keep the
   offset, print one diagnostic line; the next watch event retries. Detect rotation before
   opening the stream: if the file's current size is smaller than the stored offset, reset
   the offset to 0 (the file was rotated and restarted) instead of tailing past EOF forever.
3. **Pin the pattern cheaply.** A test asserting the process survives an injected `'error'`
   on the git watcher, a rotation test for the tail (shrunken file → offset reset → new
   lines rendered), and a lint-style source check that every `chokidar.watch` /
   `createReadStream` call site in long-lived paths registers `'error'` — a grep-shaped
   test over known sites, not new machinery.

## Why this is in scope

The serve daemon is the substrate's shared warm process; the whole delegation design
(`serve-client.ts`) exists so one process holds the caches for every connected agent.
A process that long-lived must survive every async event error its own optimizations can
emit — dying on a `.git` watch hiccup is silent unreliability of exactly the class the
honesty contract targets, and the silent post-rotation empty tail is degradation without
disclosure. Both fixes are deterministic, local, and constant-free.

## Impact

- Files: `src/core/services/mcp-watcher.ts` (git-watcher error listener + disclosure),
  `src/cli/commands/telemetry.ts` (stream error handler, inFlight cleanup, rotation-aware
  offset reset); tests for watcher-error survival, tail rotation, and error-listener
  coverage.
- Specs: `mcp-handlers` — 1 ADDED requirement (WatcherErrorEventsNeverKillTheHost);
  `cli` — 1 ADDED requirement (LiveTelemetryTailSurvivesErrorsAndRotation).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low. Error paths that previously crashed or wedged now log and degrade; no behavior
  change on the happy path; no new tuning constants (rotation detection is `size < offset`,
  a structural fact, not a threshold).
