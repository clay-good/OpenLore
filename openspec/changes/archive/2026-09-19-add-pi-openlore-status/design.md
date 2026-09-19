# Design

## Context

- The Pi host API gives `ctx.ui.setStatus(key, text | undefined)`, a fire-and-forget footer entry.
  `ctx.hasUI` is false in print and JSON modes. Pi's docs say that a session-bound `ctx` is stale
  after session replacement, and that using it can throw.
- `src/pi/extension.ts` already tracks the daemon per `cwd` in `registerOpenlore`: the `daemons`
  cache, `daemonFailures`, and `failedUntil`. It also gets a typed `failureKind` from
  `ensureDaemonResult` (`draining | launch | preparation | early-exit | health-timeout |
  spawn-disabled`), and an incompatible daemon carries `incompatibility`.
- `openloreHealth` (`src/api/health.ts`) gives `index: absent | building | degraded | ready`,
  `watcher: healthy | stopped | unknown`, `repairInProgress`, and `reasonCode`. It reads disk first.
  It sends one loopback probe with a 1 s limit, and only when a descriptor exists.
- Cost: `openloreHealth` runs `JSON.parse` on every required artifact. On this repository that is
  about 24 MB (`llm-context.json` is 19.8 MB). A parse this large blocks Pi's event loop for a time
  the TUI can see, so the status cannot re-parse on every agent run.

## Goals / Non-Goals

**Goals:**
- One status slot that is honest (see the spec deltas) and costs nothing when no artifact changed.
- One pure formatter from facts to text, so each state can be tested without a host.

**Non-Goals:**
- Showing the tool surface (lean or all), index age, or change counts. These can come later if
  users need them.
- A configuration key to turn the status off. `setStatus` uses one footer segment. If users ask for
  an opt-out, it can come later as a `pi.*` key.
- A timer that refreshes the status. A timer would need a captured `ctx`. See Decision 3.
- Changes to `openloreHealth` or the daemon `/health` payload.

## Decisions

### 1. Compose from `openloreHealth` plus the extension's own daemon outcome

Index readiness and watcher state come from `openloreHealth`. Daemon state comes from the
extension's last `getDaemon` result, because only the extension knows about spawn-disabled,
incompatible and negative-cached failures. A refresh with no usable daemon cached calls `getDaemon`
again (its failure cooldown still applies), so the status never repeats a stale failure. The extension stores a per-`cwd` `DaemonView`:
`connecting | usable | incompatible | spawn-disabled | unavailable`. `getDaemon` already writes the
outcome to `daemons` and `daemonFailures`. It also records `failureKind` and whether the daemon was
incompatible.

*Alternative:* derive everything from `openloreHealth`, which already probes the daemon. Rejected:
`openloreHealth` cannot see spawn authority or incompatibility. It would show "ready" when the
tools cannot run, and the spec forbids that.

### 1b. Keep `health.ts` light enough for the Pi host

`src/pi/extension.ts` must not load the analyzer into the Pi process (decision abee8e3e). Today its
transitive relative-import graph is 18 files. `src/api/health.ts` imports `readDescriptor` from
`cli/commands/serve.js`, whose import graph is 234 files: `commander`, the MCP handlers, `EdgeStore`
(native SQLite), `McpWatcher`, and `api/analyze`. `serve.ts`'s `readDescriptor` is only
`readServeDescriptor(serveFilePath(root), { includeDraining: true })`. So `health.ts` calls
`readServeDescriptor` from the dependency-light `serve-descriptor.js` directly, on the same path
with the same option. Behavior does not change. The other imports of `health.ts`
(`analysis-generation`, `analysis-ownership`, `command-helpers`) add 6 small files and are kept.

A test walks the relative-import graph of `src/pi/extension.ts` and fails if the graph reaches
`cli/commands/serve.ts`, `edge-store.ts`, `mcp-watcher.ts`, `api/analyze.ts`, or
`core/analyzer/call-graph.ts`. Today the rule is only a comment.

*Alternative:* a dynamic `import()` of `openloreHealth`. Rejected: the heavy graph would still load
into Pi at the first session start.
*Alternative:* compute readiness inside the extension. Rejected: the readiness logic would then
exist twice and could drift from the published API.

### 2. Cache the health read by artifact stat

The status layer keeps the last `HealthResult` per `cwd`. The cache key has three parts: the
`(mtimeMs, size)` of each required artifact (`REQUIRED_ANALYSIS_ARTIFACTS`), whether the ownership
lock is present, and the current `DaemonView`. `stat` calls are cheap. The layer calls
`openloreHealth` again only when the key changes or the last result was `building`. With no key
change, an agent run costs a few `stat`s and no parse.

The watcher state is never cached. It can stop or restart inside the same daemon without moving
any artifact, so a cached value would hide exactly the state the `ready (watcher stopped)` row
exists to show, or keep showing a stop that is over. On a cache hit with a usable daemon, the layer
re-probes only the watcher through `readWatcherState` (exported from `health.ts`): one loopback
request with a 1 s deadline, once per agent run, and no artifact parse.

*Alternative:* add a cheap mode to `openloreHealth` that checks existence only. Rejected for this
change: the call would then report `ready` for a corrupt artifact, and that is less honest. The
cache keeps the full check and pays the parse only when an artifact is rewritten. A rewrite is also
the only time the index result can change.

*Alternative:* cache the watcher with the index verdict. Rejected: the status would show a watcher
state that a real read reported once, but that may no longer be true.

### 3. Update only from event handlers, with that event's `ctx`

Update points:
- `session_start`: set "connecting", then run `getDaemon`, then update.
- `agent_end`: update.
- The wizard's analyze branch in `runConfigWizard`: update after success or failure.
- `session_shutdown`: `setStatus('openlore', undefined)`.

Each call passes the handler's own `ctx`. No `ctx` is stored for later use. Every update is wrapped
in `try/catch` and never rejects into the host handler.

*Alternative:* refresh from the existing keepalive interval. Rejected: that needs a captured `ctx`,
and after a session replacement the captured `ctx` throws.

### 4. The formatter is a pure exported function

`formatPiStatus({ index, reasonCode, watcher, daemon }): string` is exported with the `@internal`
tag, like the other helpers in the extension. It is tested like `formatToolResult`. The text is
short and ASCII, so Pi can render it in any theme:

| Facts | Text |
|---|---|
| daemon `connecting` | `openlore: connecting…` |
| index `absent` | `openlore: no index (run openlore analyze)` |
| index `building` / repair in progress, no usable index | `openlore: analyzing…` |
| index `degraded` | `openlore: index degraded` |
| index `ready`, daemon `incompatible` | `openlore: daemon incompatible` |
| index `ready`, daemon `spawn-disabled` | `openlore: daemon not started (spawn disabled)` |
| index `ready`, daemon `unavailable` | `openlore: daemon unavailable` |
| index `ready`, daemon `usable`, watcher `stopped` | `openlore: ready (watcher stopped)` |
| index `ready`, daemon `usable` | `openlore: ready` |
| health read threw | `openlore: status unknown` |

Precedence: `connecting` comes first. Then an index that is not ready. Then the daemon. Then the
watcher. The index state comes before the daemon state because no daemon can serve an absent
index. So "no index" is the condition the user can act on.

## Risks / Trade-offs

- [A 24 MB parse stalls the TUI when an artifact changes] → It happens once per rewrite, and only
  after an agent run. This is the same cost that `openloreHealth` already has for hosts. A later
  change can move the check to generation metadata.
- [The status is old between agent runs, for example when an analysis ends while the user is idle]
  → This is acceptable. The status is advisory, and the next agent run corrects it. Tool calls still
  fail with their own honest reasons.
- [Edits to `extension.ts` move the TLS-coverage line anchors] → Update the anchors in
  `tls-coverage.test.ts` and run that test as part of the task list.
- [RPC hosts ignore `setStatus`] → No impact. The method is fire-and-forget, and the Pi docs say
  RPC treats it as a no-op or forwards it.
