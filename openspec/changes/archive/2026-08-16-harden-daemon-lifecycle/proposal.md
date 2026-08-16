# Harden the daemon lifecycle: protect the token, win the start race, drain before exit, bound the caches

> Status: ARCHIVED (2026-08-16; proposed 2026-07-03, e2e audit pass 3). Five verified defects in `openlore serve`: the
> auth token lands world-readable on disk; two concurrent starts both pass the single-instance
> guard and run two watchers on one analysis dir; shutdown hard-kills a mid-flight rebuild the
> idle reaper can even trigger during one; every client-supplied directory permanently pins a
> parsed context and an open SQLite handle; and telemetry error fields can leak absolute paths.
> Chmod the descriptor, lock the start, drain the teardown, confine to the served root, relativize.

## Why

- **(a) Secret at rest, world-readable.** The daemon's auth token — the thing that stops "any
  local process on this machine" from calling the tools (`serve.ts:326`, warning at `:339-345`) —
  is serialized into `.openlore/serve.json` via plain `writeFile` (`serve.ts:599`) with no mode:
  default 0644. Distinct from `harden-serve-descriptor-trust`, which hardens *reading* an
  untrusted descriptor (`readDescriptor` fail-closed, `serve.ts:247-271`); this defect is about
  protecting *our own* secret when writing it.
- **(b) Start TOCTOU.** The single-instance guard reads the descriptor and probes liveness
  (`serve.ts:385-397`), then only later — after async bind — writes `serve.json` (`:583-599`).
  Two concurrent starts (common: two MCP clients both call `ensureServeDaemon`,
  `serve-client.ts:89-119`) both pass the guard, bind two ports, and run TWO `McpWatcher`s on one
  analysis dir (`serve.ts:647`); the second descriptor write orphans daemon #1 — undiscoverable
  and un-stoppable via the descriptor. The comment at `serve.ts:382-384` fears exactly this race;
  the single-flight coordinator at `:411-419` only serializes rebuilds *within* one process.
- **(c) Shutdown doesn't drain.** `teardown` (`serve.ts:664-676`) clears timers and stops the
  watcher but never awaits an in-flight `openloreAnalyze({force: true})` launched by
  `triggerRebuild` (`serve.ts:422-439`); `exitAfterTeardown` then calls `process.exit(0)`
  (`:677`), hard-killing mid-rebuild — a logically half-rebuilt EdgeStore across its per-file
  transactions. Worse, the unref'd idle reaper (`serve.ts:371-380`) can fire DURING a rebuild:
  rebuild activity never calls `touchActivity`, so a long analyze on a quiet daemon looks idle.
- **(d) Unbounded caches keyed by client-controlled directories.** A request's directory flows
  `body.directory` → `args.directory` (`serve.ts:505-510`); `validateDirectory` checks only that
  the path exists (`utils.ts:60-89`). Every distinct directory then permanently adds a parsed
  `CachedContext` plus an open EdgeStore/SQLite handle to `_contextCache` (`utils.ts:250`, set at
  `:296`/`:390`, evicted only by mtime-refresh, never by count) and an entry in
  `schemaResetByDir` (`serve.ts:405`). A long-lived daemon grows memory and file descriptors
  without bound, steered by any local process that can reach the port.
- **(e) Telemetry error fields carry absolute paths.** `tool_error` events embed raw error
  strings (`mcp.ts:2479`, `:2666`) that routinely contain absolute paths ("Directory not found:
  /Users/<name>/…"); `redactSecrets` (`core/services/telemetry.ts:57`) redacts credentials, not
  paths. Telemetry is opt-in and never transmitted off-machine — this is hygiene for a local
  file, not an exfiltration fix.

## What Changes

1. **Descriptor written 0o600**: write, then `chmod` to beat the umask (`serve.ts:599`).
2. **Serialized lifecycle discovery**: an exclusive `.openlore/serve.lock` (the shared advisory
   lock shape) covers discover → bind → ready-descriptor and CLI stop → descriptor removal. The
   daemon publishes `ready → draining → removed`; ordinary MCP/Pi readers treat `draining` as
   unavailable, and a replacement waits for removal. A verified healthy daemon can restore a
   `draining` marker stranded by a stopper that crashed before sending shutdown. One daemon, one
   watcher, and one rebuild owner per root through startup and teardown.
3. **Teardown drains**: `teardown` awaits `rebuildRunning` completion (bounded wait, then
   disclose and proceed); the idle reaper is suppressed while a rebuild is in flight (rebuild
   start/finish gates the timer — no new timeout constant). Independent of
   `harden-artifact-write-atomicity` (atomic JSON writes) — this is process-lifetime ordering,
   not file-write atomicity.
4. **Confine the daemon to its exact served root** (chosen over an LRU): requests naming a directory
   other than the canonical served root (including subdirectories) are rejected with an
   error naming the served root and how to start a daemon for the other path. Justification:
   clients discover a daemon via that root's `serve.json`, so cross-root requests only arise
   from misuse or probing; confinement removes both the unbounded growth and a trust hazard in
   one move with zero new tuning constants, where an LRU would add a size constant and keep the
   foreign-directory trust problem. The in-process MCP server path is unaffected.
5. **Relativize telemetry paths**: error/module fields pass through a path-relativizer (project
   root → relative; home → `~`) before `emit` (`mcp.ts:2479`, `:2666`).
6. **Keep network discovery local**: token-protected network binds are limited to wildcard
   `0.0.0.0`/`::`; descriptors publish the corresponding loopback target, and every reader uses
   an IPv6-bracket-safe shared URL formatter. Concrete interface binds are rejected because they
   cannot provide a trusted loopback discovery endpoint.

Retained as-is (already solid, not re-fixed): watcher batch coalescing + single-flight flush
(`mcp-watcher.ts:359-405`), `followSymlinks: false` (`:266`), the EdgeStore per-file transaction
swap (`:544-562`), and stale-descriptor fail-closed reads (`serve.ts:247-271`).

## Why this is in scope

The warm daemon is the shared substrate process every connected agent leans on; its lifecycle
defects are silent-unreliability class: a secret readable by any local user, a race that yields
two watchers mutating one store, an exit that tears a rebuild, caches a client can grow forever.
Every fix is deterministic, local, and reuses an existing shape (the decisions lockfile, the
single-flight discipline, the import-style disclosure) — no new constants beyond a bounded drain
wait.

## Impact

- Files: `src/cli/commands/serve.ts` (chmod, lockfile, drain, root confinement),
  `src/core/services/mcp-handlers/utils.ts` (no eviction change needed under confinement; close
  handles on teardown), `src/cli/commands/mcp.ts` + `src/core/services/telemetry.ts`
  (path relativization); tests for each.
- Specs: `cli` — 3 ADDED (ServeTokenAtRestIsOwnerOnly, ServeStartIsSingleInstanceUnderRace,
  ServeTeardownDrainsInFlightRebuilds); `mcp-handlers` — 1 ADDED
  (DaemonServesOnlyItsServedRoot, folding in telemetry path hygiene).
- Tool surface: unchanged (no new MCP tool; no payload-budget impact — HTTP daemon surface only).
- Risk: low-medium. Root confinement is the one behavior change: any workflow that pointed one
  daemon at foreign directories now gets an explicit error with the remedy (per-root daemons are
  what `ensureServeDaemon` already spawns). Cross-references: `harden-serve-descriptor-trust`
  (read-side), `harden-artifact-write-atomicity` (write atomicity) — both orthogonal, neither
  modified.
