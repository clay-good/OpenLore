/**
 * openlore serve — local HTTP daemon (warm, loopback-only).
 *
 * A long-lived process that keeps openlore's caches warm across calls and
 * exposes the tool surface over plain HTTP so non-MCP clients (e.g. a Pi
 * extension) can hit it with `fetch` — no JSON-RPC, no subprocess-per-call.
 *
 * It reuses the SAME tool dispatch as the stdio MCP server
 * ({@link dispatchTool}) so the two transports can't drift, and the SAME tool
 * presets ({@link selectActiveTools}) so a small-model client gets a focused
 * surface. The default preset is the shared `LEAN_DEFAULT_PRESET` constant (so
 * `serve` and `openlore mcp` never diverge on what "no --preset" means).
 *
 * Endpoints (all loopback):
 *   GET  /health           → { ok, presetDispatchEnforced, root, pid, preset, tools,
 *                              tokenProtected, tokenAuthenticated, version, uptimeMs }
 *   POST /shutdown         → authenticated graceful teardown
 *   POST /tool/:name       body { directory?, args }  → handler result (JSON)
 *
 * Clients require the semantic marker, exact root, and authenticated token proof
 * before trusting a descriptor's daemon, preset, or tool list.
 * Discovery: writes `.openlore/serve.json` { port, pid, host, token?, startedAt }
 * in the served root so a client can find and reuse a running daemon.
 *
 * Security: defaults to 127.0.0.1. Every request is checked against a DNS-rebinding
 * guard (Host must be a loopback name or the bound host; a cross-site Origin is
 * rejected) before any dispatch. An optional --token must be presented as the
 * `x-openlore-token` header and is compared in constant time; binding a non-loopback
 * host requires a token (the daemon refuses to start otherwise), and a tokenless
 * loopback bind warns that other local processes can reach the port.
 *
 * Freshness (watcher + continuous re-analyze) is layered on separately; this
 * module is the transport + lifecycle core.
 */

import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, FULL_PRESET, FULL_PRESET_ALIAS, LEAN_DEFAULT_PRESET } from '../../constants.js';
import { dispatchTool, UnknownToolError } from '../../core/services/tool-dispatch.js';
import { resolveCanonicalToolName } from '../../core/services/mcp-handlers/tool-contract.js';
import { releaseContextCache, validateDirectory, waitForGraphRebuild } from '../../core/services/mcp-handlers/utils.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import { registerRepairHost } from '../../core/services/cold-start-bootstrap.js';
import { acquireLockAt, isLockHeld } from '../../core/runtime/advisory-lock.js';
import { openloreAnalyze } from '../../api/analyze.js';
import { TOOL_DEFINITIONS, TOOL_PRESETS, presetMembershipError, selectActiveTools } from './mcp.js';
import { validateKnownProperties, validateToolArgs } from '../../core/services/mcp-handlers/tool-guard.js';
import {
  isLoopbackHost,
  constantTimeEqual,
  originDefenseError,
  OPENLORE_TOKEN_HEADER,
  writeInstanceDescriptor,
} from './local-http-guard.js';
import {
  readServeDescriptor,
  canonicalServeRoot,
  serveHttpBaseUrl,
  validateServeHealth,
  type ServeDescriptor,
  type ServeHealth,
} from './serve-descriptor.js';

/**
 * Debounce before a full call-graph re-analyze after edits settle. Longer than
 * the watcher's signature debounce (WATCH_DEBOUNCE_MS=400) because re-analysis
 * is heavier; a few seconds of quiet is the signal that an edit burst is done.
 */
const REANALYZE_DEBOUNCE_MS = 4000;
const REBUILD_DRAIN_TIMEOUT_MS = 60_000;
const SERVE_START_LOCK_FILE = 'serve.lock';
const SERVE_START_LOCK_WAIT_MS = 30_000;
const SERVE_STOP_WAIT_MS = REBUILD_DRAIN_TIMEOUT_MS + 5_000;

function discoveryHostForBind(host: string): string | null {
  if (isLoopbackHost(host)) return host;
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return null;
}

/** Wait for active rebuilds without letting shutdown hang forever. */
export async function drainServeRebuilds(
  rebuilds: Iterable<Promise<void>>,
  timeoutMs = REBUILD_DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    Promise.allSettled([...rebuilds]).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!drained) {
    logger.warning(
      `[serve] shutdown proceeded after waiting ${timeoutMs}ms for an in-flight graph rebuild.`,
    );
  }
  return drained;
}

/**
 * Default minutes of request inactivity before the daemon self-terminates.
 *
 * The daemon is spawned detached by clients (the Pi extension, MCP server) and
 * is deliberately NOT a child of any one of them, so when a client closes it is
 * not signalled. On Windows especially, a flaky health check can make a client
 * (or the single-instance guard) miss the live daemon, spawn a fresh one, and
 * orphan the previous — orphans hold their port + caches forever and pile up in
 * RAM. Idle self-shutdown bounds every daemon's lifetime: orphans receive zero
 * requests and reap themselves; the in-use daemon is kept alive by tool calls
 * and the Pi extension's /health keepalive. Disable with --idle-timeout 0.
 *
 * INVARIANT: stays comfortably above the extension keepalive interval (Pi pings
 * every 5 min); at ~3× it tolerates two consecutive missed pings before an
 * in-use daemon would wrongly reap. Don't lower this without lowering the ping.
 */
const DEFAULT_IDLE_TIMEOUT_MIN = 15;

/**
 * Resolve the idle-shutdown interval (ms) from the `--idle-timeout` option, in
 * minutes. Absent or non-numeric → the default; zero/negative → 0 (disabled).
 */
export function idleTimeoutMs(option?: string): number {
  if (option === undefined || option === '') return DEFAULT_IDLE_TIMEOUT_MIN * 60_000;
  const min = Number(option);
  if (!Number.isFinite(min)) return DEFAULT_IDLE_TIMEOUT_MIN * 60_000; // non-numeric → default
  return min > 0 ? min * 60_000 : 0; // explicit 0 / negative disables
}

/** Health-probe timeout. Generous enough for a cold Node HTTP server on Windows
 *  so a slow first response isn't misread as "dead" (which orphans daemons). */
const HEALTH_PROBE_TIMEOUT_MS = 2500;

const _require = createRequire(import.meta.url);
const _pkgVersion = (_require('../../../package.json') as { version: string }).version;


interface ServeCliOptions {
  directory?: string;
  port?: string;
  host?: string;
  preset?: string;
  token?: string;
  stop?: boolean;
  /** false (via --no-watch) disables the freshness watcher + re-analyze lane. */
  watch?: boolean;
  /** Minutes of request inactivity before the daemon self-terminates. 0 disables. */
  idleTimeout?: string;
  /** Internal test seam; the CLI always uses the production startup-lock bound. */
  startupLockWaitMs?: number;
}

/** Live daemon handle. Returned by {@link startServe} so callers (tests) can
 * address and shut down the running server without signalling the process. */
export interface ServeHandle {
  port: number;
  host: string;
  token?: string;
  baseUrl: string;
  close(): Promise<void>;
}

interface DaemonProbe {
  alive: boolean;
  health: ServeHealth | null;
}

const SERVE_FILE = 'serve.json';
const MAX_BODY_BYTES = 1_000_000; // tool args are small; reject anything larger

function serveFilePath(root: string): string {
  return join(root, OPENLORE_DIR, SERVE_FILE);
}

/** Read a JSON request body with a hard size ceiling. Rejects on overflow/parse error. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve_, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve_({});
      try {
        resolve_(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Read + validate <root>/.openlore/serve.json. The discovery file is an untrusted
 * on-disk artifact (mcp-security: Untrusted Artifact Deserialization): a hostile repo
 * could ship a poisoned serve.json, and `probeDaemon` would then fetch an arbitrary
 * host (egress / SSRF). Validation
 * lives in the shared {@link readServeDescriptor} so every reader fails closed the
 * same way (mcp-security: ServeDescriptorValidatedAtEveryReader).
 *
 * Exported for the serve.json validation tests.
 */
export async function readDescriptor(root: string): Promise<ServeDescriptor | null> {
  return readServeDescriptor(serveFilePath(root), { includeDraining: true });
}

/**
 * Confirm a descriptor points at a LIVE openlore daemon — not a stale serve.json
 * left by a SIGKILL'd process, nor a recycled port now owned by something else.
 * Verifies GET /health returns the strict authenticated, root-bound shape before
 * trusting any daemon metadata or asking the listener to shut itself down.
 */
async function probeDaemon(
  desc: ServeDescriptor,
  expectedRoot: string,
): Promise<DaemonProbe> {
  try {
    // Only transmit the token already present in the mode-0600 descriptor. A
    // caller-provided replacement token must never be disclosed to a
    // descriptor-selected listener.
    const headers = desc.token ? { [OPENLORE_TOKEN_HEADER]: desc.token } : undefined;
    // INTENTIONAL EGRESS: validated descriptors are loopback-only and redirects are disabled.
    // codeql[js/file-access-to-http]
    const res = await fetch(`${serveHttpBaseUrl(desc.host, desc.port)}/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      // A daemon never redirects; following one would take this probe off-machine.
      redirect: 'error',
    });
    if (!res.ok) return { alive: false, health: null };
    const body = await res.json().catch(() => null);
    return {
      alive: (body as { ok?: unknown } | null)?.ok === true,
      health: validateServeHealth(body, expectedRoot, desc),
    };
  } catch {
    return { alive: false, health: null };
  }
}

/** Stop the verified daemon and wait until its listener has actually closed. */
async function stopDaemon(root: string): Promise<boolean> {
  const path = serveFilePath(root);
  const desc = await readDescriptor(root);
  if (!desc) {
    logger.warning(`No running openlore serve daemon found for ${root}.`);
    return true;
  }
  if (desc.state === 'draining') {
    const drainingProbe = await probeDaemon(desc, root);
    if (drainingProbe.health && !drainingProbe.health.draining) {
      // A stopper can die after publishing draining but before POST /shutdown.
      // The verified daemon says no teardown began, so resume the stop safely.
      desc.state = 'ready';
      await writeInstanceDescriptor(path, desc);
    } else {
    const deadline = Date.now() + SERVE_STOP_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await readDescriptor(root)) === null) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    logger.error(`Daemon ${desc.pid} is still draining; verify it before manual descriptor cleanup.`);
    process.exitCode = 1;
    return false;
    }
  }
  const probe = await probeDaemon(desc, root);
  if (!probe.alive) {
    await unlink(path).catch(() => {});
    logger.warning(`No live daemon at ${desc.host}:${desc.port}; removed stale ${SERVE_FILE}.`);
    return true;
  }
  if (!probe.health) {
    logger.warning(
      'The announced listener is not an authenticated daemon for this repository; refusing ' +
      'to signal the descriptor PID. Stop or upgrade the legacy daemon manually.',
    );
    return false;
  }
  try {
    const headers = desc.token ? { [OPENLORE_TOKEN_HEADER]: desc.token } : undefined;
    await writeInstanceDescriptor(path, { ...desc, state: 'draining' });
    // INTENTIONAL EGRESS: the authenticated health probe bound this loopback descriptor to this repo.
    // codeql[js/file-access-to-http]
    const res = await fetch(`${serveHttpBaseUrl(desc.host, desc.port)}/shutdown`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logger.success(`Requested shutdown of openlore serve (pid ${probe.health.pid}).`);
    const deadline = Date.now() + SERVE_STOP_WAIT_MS;
    while (Date.now() < deadline) {
      // Teardown removes the owned descriptor only after watcher stop and the
      // bounded rebuild drain. Listener closure alone is therefore not enough.
      if ((await readDescriptor(root)) === null) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    logger.error(
      `Daemon ${probe.health.pid} acknowledged shutdown but did not stop within ${SERVE_STOP_WAIT_MS}ms. ` +
      'The startup lock remains fail-closed; verify the PID before manual cleanup.',
    );
    process.exitCode = 1;
    return false;
  } catch {
    await writeInstanceDescriptor(path, { ...desc, state: 'ready' }).catch(() => {});
    logger.warning('The verified daemon did not accept the shutdown request.');
    return false;
  }
}

export async function startServe(options: ServeCliOptions): Promise<ServeHandle | undefined> {
  const root = canonicalServeRoot(options.directory ?? process.cwd());
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? (process.env.OPENLORE_SERVE_TOKEN || undefined);
  const discoveryHost = discoveryHostForBind(host);
  const presetName = options.preset ?? LEAN_DEFAULT_PRESET;
  const isFullSurface = presetName === FULL_PRESET_ALIAS || presetName === FULL_PRESET;

  // Reject static configuration errors before creating .openlore or its lock.
  if (!isLoopbackHost(host) && !token) {
    logger.error(
      `Refusing to bind non-loopback host "${host}" without a token. ` +
      `A non-loopback bind exposes openlore tools to the network; pass --token <secret> ` +
      `(or set OPENLORE_SERVE_TOKEN) to require authentication.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!discoveryHost) {
    logger.error(
      `Refusing non-loopback host "${host}" because safe local daemon discovery requires ` +
      'a loopback host or wildcard bind (0.0.0.0 or ::).',
    );
    process.exitCode = 1;
    return;
  }
  if (!isFullSurface && !TOOL_PRESETS[presetName]) {
    logger.error(`Unknown --preset "${presetName}". Known: ${Object.keys(TOOL_PRESETS).join(', ')}, ${FULL_PRESET_ALIAS}, ${FULL_PRESET}.`);
    process.exitCode = 1;
    return;
  }
  if (options.stop) {
    const openloreDirectory = join(root, OPENLORE_DIR);
    const exists = await access(openloreDirectory).then(() => true).catch(() => false);
    if (!exists) {
      logger.warning(`No running openlore serve daemon found for ${root}.`);
      return;
    }
  }

  // Serialize stop as well as startup. A stop that arrived during bind used to
  // observe no descriptor and return just before the starter published one.
  let lockResult: Awaited<ReturnType<typeof acquireLockAt>>;
  try {
    const startupLockWaitMs = options.startupLockWaitMs ?? SERVE_START_LOCK_WAIT_MS;
    lockResult = await acquireLockAt(join(root, OPENLORE_DIR), SERVE_START_LOCK_FILE, {
      maxWaitMs: startupLockWaitMs,
      ...(options.startupLockWaitMs !== undefined
        ? { namespaceGateMaxWaitMs: startupLockWaitMs }
        : {}),
    });
  } catch (err) {
    logger.error(
      `The serve startup lock for ${root} is unavailable: ${err instanceof Error ? err.message : String(err)} ` +
      `Verify that no starter is running, then remove the stranded lock gate under ${join(root, OPENLORE_DIR)}.`,
    );
    process.exitCode = 1;
    return;
  }
  if (isLockHeld(lockResult)) {
    logger.error(
      `Timed out waiting for ${lockResult.lockPath}. Verify its recorded owner is no longer running ` +
      'before removing the lock file.',
    );
    process.exitCode = 1;
    return;
  }
  let releaseAttempted = false;
  let startupLockReleased = false;
  let preserveStartupLock = false;
  const releaseStartupLock = async (): Promise<void> => {
    if (releaseAttempted || preserveStartupLock) return;
    releaseAttempted = true;
    try {
      await lockResult.release();
      startupLockReleased = true;
    } catch (err) {
      // Descriptor publication already makes the live daemon discoverable. A
      // failed release must not replace the returned handle and orphan it; the
      // PID-bearing lock remains fail-closed and becomes stale after process exit.
      logger.warning(
        `[serve] could not release the startup lock: ${err instanceof Error ? err.message : String(err)} ` +
        'The live daemon remains discoverable; verify its PID before manual lock cleanup.',
      );
    }
  };

  try {
  if (options.stop) {
    preserveStartupLock = !(await stopDaemon(root));
    return undefined;
  }

  // A loopback bind with no token is still reachable by other local processes.
  if (isLoopbackHost(host) && !token) {
    logger.warning(
      `[serve] No token configured — any local process on this machine can call openlore tools ` +
      `on ${host}. Pass --token to restrict access.`,
    );
  }

  // Full-surface selectors: serve historically used `all`; accept `full` too so
  // the selector vocabulary matches `openlore mcp` (change: default-to-lean-tool-
  // surface added `full`/`all` there). Both mean every tool.
  // Active tool surface: 'all'/'full' = every tool, otherwise the named preset.
  const activeNames = new Set(
    (isFullSurface
      ? TOOL_DEFINITIONS
      : selectActiveTools(TOOL_DEFINITIONS, { preset: presetName })
    ).map((t) => t.name),
  );

  // Idle self-shutdown: a request resets the timer; firing tears down and exits.
  // Bounds orphaned-daemon lifetime so they can't accumulate in RAM (see
  // DEFAULT_IDLE_TIMEOUT_MIN). Declared here so handleRequest can reset it; armed
  // after listen, once exitAfterTeardown exists.
  const idleMs = idleTimeoutMs(options.idleTimeout);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let teardownRequested = false;
  const rebuildRunning = new Set<string>();
  const rebuildPending = new Set<string>();
  const rebuildPromises = new Map<string, Promise<void>>();
  let lifecycleReady = false;
  function touchActivity(): void {
    if (teardownRequested || idleMs <= 0 || !lifecycleReady) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (rebuildRunning.size > 0) {
      idleTimer = undefined;
      return;
    }
    idleTimer = setTimeout(() => {
      logger.discovery(`[serve] idle ${idleMs / 60_000}min with no requests — shutting down to free memory.`);
      void exitAfterTeardown();
    }, idleMs);
    // Don't keep the event loop alive for the idle timer alone.
    idleTimer.unref?.();
  }

  // Don't start a second daemon for a root already served by a healthy one —
  // a concurrent spawn (two MCP clients, or pi + MCP) would otherwise leave two
  // watchers racing on the same .openlore/analysis. Reuse the live one instead.
  let existing = await readDescriptor(root);
  if (existing?.state === 'draining') {
    const drainingProbe = await probeDaemon(existing, root);
    if (drainingProbe.health && !drainingProbe.health.draining) {
      // Recover a stopper that crashed between publishing draining and sending
      // the shutdown request. Identity/token/root were proved by the probe.
      existing.state = 'ready';
      await writeInstanceDescriptor(serveFilePath(root), existing);
    } else {
    const deadline = Date.now() + SERVE_STOP_WAIT_MS;
    while (Date.now() < deadline && existing?.state === 'draining') {
      await new Promise((resolve) => setTimeout(resolve, 50));
      existing = await readDescriptor(root);
    }
    if (existing?.state === 'draining') {
      logger.error(
        `The daemon for ${root} is still draining. No replacement was started; ` +
        'verify the descriptor PID before manual cleanup.',
      );
      process.exitCode = 1;
      preserveStartupLock = true;
      return;
    }
    }
  }
  if (existing && existing.token !== token) {
    logger.error(
      `Refusing to reuse the daemon announced for ${root}: requested token posture ` +
      `(${token ? 'protected' : 'none'}) does not match the descriptor ` +
      `(${existing.token ? 'protected' : 'none'}). No request was sent. Stop the existing ` +
      'daemon before changing its security settings.',
    );
    process.exitCode = 1;
    return;
  }
  let existingProbe = existing ? await probeDaemon(existing, root) : null;
  let existingHealth = existingProbe?.health ?? null;
  if (existingHealth?.draining) {
    const deadline = Date.now() + SERVE_STOP_WAIT_MS;
    while (Date.now() < deadline && await readDescriptor(root)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    existing = await readDescriptor(root);
    if (existing) {
      logger.error(`The daemon for ${root} did not finish draining; no replacement was started.`);
      process.exitCode = 1;
      preserveStartupLock = true;
      return;
    }
    existingProbe = null;
    existingHealth = null;
  }
  if (existing && existingProbe?.alive && !existingHealth) {
    logger.error(
      `Refusing to reuse the daemon already serving ${root} because its health response ` +
      'does not declare an authenticated, root-bound preset/tool surface. Stop or upgrade ' +
      'the incompatible process manually before restarting it.',
    );
    process.exitCode = 1;
    return;
  }
  if (existing && existingHealth) {
    const requestedPreset = isFullSurface ? FULL_PRESET : presetName;
    const existingPreset =
      existingHealth.preset === FULL_PRESET_ALIAS ? FULL_PRESET : existingHealth.preset;
    const existingTools = new Set(existingHealth.tools);
    const surfaceMatches =
      existingTools.size === activeNames.size
      && [...activeNames].every((tool) => existingTools.has(tool));
    if (existingPreset !== requestedPreset || !surfaceMatches || existingHealth.tokenProtected !== Boolean(token)) {
      logger.error(
        `Refusing to reuse the daemon already serving ${root}: requested preset/token ` +
        `(${requestedPreset}/${token ? 'protected' : 'none'}) does not match the live daemon ` +
        `(${existingPreset}/${existingHealth.tokenProtected ? 'protected' : 'none'}), or its advertised tools ` +
        'do not match that preset. Run ' +
        '`openlore serve --stop` before starting it with different security settings.',
      );
      process.exitCode = 1;
      return;
    }
    logger.success(
      `openlore serve already running for ${root} at ${serveHttpBaseUrl(existing.host, existing.port)} — reusing.`,
    );
    return {
      port: existing.port,
      host: existing.host,
      token,
      baseUrl: serveHttpBaseUrl(existing.host, existing.port),
      close: async () => {}, // never tear down a daemon this process didn't start
    };
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Root-scoped schema-reset flag. Set once at startup or first request and
  // cleared after waitForGraphRebuild() succeeds. Foreign directories are
  // rejected before this state or any EdgeStore handle is touched.
  let schemaReset: boolean | undefined;

  // Single forced-rebuild coordinator. BOTH the schema-reset
  // healer (below) and the watcher's debounced re-analyze (further down) funnel
  // through here, so at most one `analyze --force` ever runs for the served root at a
  // time — two concurrent ones would clear+repopulate the same EdgeStore
  // non-atomically and could tear the graph. A trigger that arrives mid-rebuild
  // is coalesced into a single follow-up run rather than dropped or stacked.
  //
  // Why serve must drive this at all: a schema-version bump now leaves the store
  // intact and reports it not-ready on every read (change: harden-index-store-lifecycle),
  // and the watcher's own open only *schedules* a rebuild — so serve still kicks the
  // rebuild explicitly and blocks the first request on it, rather than letting
  // waitForGraphRebuild() poll a not-ready store until it times out.
  function triggerRebuild(directory: string): void {
    if (teardownRequested) return;
    if (rebuildRunning.has(directory)) { rebuildPending.add(directory); return; }
    rebuildRunning.add(directory);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    logger.discovery(`[serve] rebuilding graph index (${directory})`);
    const rebuild = openloreAnalyze({ rootPath: directory, force: true })
      .then(() => logger.discovery(`[serve] graph index rebuilt (${directory})`))
      .catch((err) => logger.warning(`[serve] graph rebuild failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        rebuildPromises.delete(directory);
        rebuildRunning.delete(directory);
        if (!teardownRequested && rebuildPending.delete(directory)) {
          // Re-run for the coalesced trigger. For the served root, go back through
          // the debounce so sustained editing doesn't spin back-to-back analyzes;
          // The root-bound request path cannot schedule a foreign rebuild.
          if (directory === root) scheduleReanalyze();
          else triggerRebuild(directory);
        }
        if (!teardownRequested && rebuildRunning.size === 0) touchActivity();
      });
    rebuildPromises.set(directory, rebuild);
  }

  const server = createServer((req, res) => {
    if (teardownRequested) {
      sendJson(res, 503, { error: 'server is shutting down' });
      return;
    }
    void handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', serveHttpBaseUrl(host, boundPort));

    // DNS-rebinding / cross-origin defense — runs before ANY dispatch, including
    // /health, so a malicious page can't even probe the daemon's existence.
    const originErr = originDefenseError(req, host, boundPort);
    if (originErr) {
      sendJson(res, 403, { error: originErr });
      return;
    }

    const presented = req.headers[OPENLORE_TOKEN_HEADER];
    const tokenAuthenticated =
      !token || (typeof presented === 'string' && constantTimeEqual(presented, token));

    // Token gate (skips /health so liveness checks need no secret). Compared in
    // constant time so a timing oracle can't recover the token byte-by-byte.
    if (token && url.pathname !== '/health') {
      if (!tokenAuthenticated) {
        sendJson(res, 401, { error: `invalid or missing ${OPENLORE_TOKEN_HEADER}` });
        return;
      }
    }

    if (!lifecycleReady) {
      sendJson(res, 503, { error: 'daemon is still starting' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      touchActivity();
      sendJson(res, 200, {
        ok: true,
        presetDispatchEnforced: true,
        version: _pkgVersion,
        root,
        pid: process.pid,
        preset: presetName,
        tools: [...activeNames],
        tokenProtected: Boolean(token),
        tokenAuthenticated,
        draining: teardownRequested,
        uptimeMs: Date.now() - startMs,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      const shutdown = teardown();
      const announced = await teardownAnnounced;
      sendJson(
        res,
        announced ? 202 : 500,
        announced
          ? { ok: true, shuttingDown: true }
          : { error: 'shutdown began, but the draining descriptor could not be published' },
      );
      void shutdown;
      return;
    }

    if (teardownRequested) {
      sendJson(res, 503, { error: 'daemon is shutting down' });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/tool/')) {
      // Resolve a deprecated tool-name alias to its canonical name so the daemon
      // transport accepts old names identically to the MCP stdio transport.
      const name = resolveCanonicalToolName(decodeURIComponent(url.pathname.slice('/tool/'.length)));
      const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
      if (!toolDef) {
        sendJson(res, 404, { error: `Unknown tool: ${name}` });
        return;
      }
      // Enforce the daemon's own advertised preset before parsing arguments,
      // validating a directory, healing an index, or dispatching. An MCP client
      // with a wider preset will treat this response as a delegation failure and
      // fall back to its authorized in-process dispatcher.
      const membershipError = presetMembershipError(name, presetName, activeNames);
      if (membershipError) {
        sendJson(res, 403, { error: membershipError });
        return;
      }
      // Only an authenticated, known, in-surface call keeps the daemon alive.
      // Rejected probes must not mutate process lifecycle state.
      touchActivity();
      let parsedBody: unknown;
      try {
        parsedBody = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
        return;
      }
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        sendJson(res, 400, { error: 'Invalid request body: expected a JSON object' });
        return;
      }
      const body = parsedBody as Record<string, unknown>;
      const envelopeError = validateKnownProperties(body, ['args', 'directory']);
      if (envelopeError) {
        sendJson(res, 400, { error: `Invalid request body: ${envelopeError}` });
        return;
      }
      // Match the stdio boundary: an omitted args member means {}, but an explicitly
      // malformed primitive/array/null is a clean 400 rather than a coerced valid call.
      const rawArgs = Object.prototype.hasOwnProperty.call(body, 'args') ? body.args : {};
      if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        sendJson(res, 400, { error: `Invalid arguments for "${name}": expected type object` });
        return;
      }
      const args = { ...(rawArgs as Record<string, unknown>) };
      // Directory precedence: explicit body.directory → explicit args.directory →
      // served root. Preserve malformed explicit values until schema validation;
      // only a truly omitted directory receives the default.
      const hasBodyDirectory = Object.prototype.hasOwnProperty.call(body, 'directory');
      const hasArgsDirectory = Object.prototype.hasOwnProperty.call(args, 'directory');
      const selectedDirectory = hasBodyDirectory
        ? body.directory
        : hasArgsDirectory ? args.directory : root;
      // Canonicalize the directory once: handlers and boundary policy must read the
      // same repository, even when a caller supplies conflicting body/args values.
      args.directory = selectedDirectory;

      // Reject malformed arguments before directory validation, index inspection,
      // healing, or dispatch. In particular, an unknown property on a write tool
      // must not trigger an analysis rebuild before the request is rejected.
      const argError = validateToolArgs(args, toolDef.inputSchema);
      if (argError) {
        sendJson(res, 400, { error: `Invalid arguments for "${name}": ${argError}` });
        return;
      }

      const requestedDirectory = selectedDirectory as string;

      try {
        const validatedDirectory = await validateDirectory(requestedDirectory);
        if (canonicalServeRoot(validatedDirectory) !== root) {
          sendJson(res, 400, {
            error:
              `This daemon serves only ${root}. Start a separate openlore serve daemon ` +
              `for ${validatedDirectory} and send the request to that daemon.`,
          });
          return;
        }
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid directory' });
        return;
      }
      const directory = root;
      args.directory = root;

      // Auto-heal schema mismatch: on first request for a directory, open
      // EdgeStore once to detect a not-ready (schema-mismatched / quarantined) store;
      // cache the result so we never re-open on subsequent requests. If not ready,
      // block until the rebuild is done.
      if (schemaReset === undefined) {
        try {
          const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
          if (EdgeStore.exists(analysisDir)) {
            const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
            schemaReset = es.notReady != null;
            es.close();
          } else {
            schemaReset = false;
          }
        } catch {
          schemaReset = false;
        }
      }
      if (schemaReset) {
        if (teardownRequested) {
          sendJson(res, 503, { error: 'server is shutting down' });
          return;
        }
        logger.debug(`[serve] Schema mismatch — waiting for graph rebuild before dispatching…`);
        // Kick the rebuild ourselves (coalesced) — the watcher only schedules, and a
        // read no longer wipes-then-heals; it reports not-ready until analyze runs.
        triggerRebuild(directory);
        // waitForGraphRebuild polls readCachedContext until edgeStore is
        // non-null. readCachedContext invalidates on llm-context.json mtime,
        // which openloreAnalyze rewrites as its last step — so the poll sees
        // the rebuilt state as soon as analyze completes.
        const rebuilt = await waitForGraphRebuild(directory, 60_000);
        schemaReset = !rebuilt;
        if (!rebuilt) logger.warning(`[serve] Graph rebuild timed out — graph tools may return empty results.`);
      }

      const dispatchAbort = new AbortController();
      const abortDispatch = (): void => dispatchAbort.abort();
      const abortOnResponseClose = (): void => {
        if (!res.writableEnded) abortDispatch();
      };
      req.once('aborted', abortDispatch);
      res.once('close', abortOnResponseClose);
      try {
        const result = await dispatchTool(name, args, directory, dispatchAbort.signal);
        if (!dispatchAbort.signal.aborted) sendJson(res, 200, result ?? null);
      } catch (err) {
        if (dispatchAbort.signal.aborted) return;
        if (err instanceof UnknownToolError) {
          sendJson(res, 404, { error: err.message });
          return;
        }
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        req.removeListener('aborted', abortDispatch);
        res.removeListener('close', abortOnResponseClose);
      }
      return;
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  }

  // Bind (port 0 → OS picks a free ephemeral port).
  const port = options.port ? parseInt(options.port, 10) : 0;
  await new Promise<void>((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve_);
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;

  // Pre-populate the schema-reset flag for the served root so the startup
  // warning fires immediately and the first request doesn't pay the open cost.
  try {
    const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    if (EdgeStore.exists(analysisDir)) {
      const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
      const reset = es.notReady != null;
      es.close();
      schemaReset = reset;
      if (reset) {
        logger.warning(
          `[serve] Graph index not ready (${es.notReady?.reason}) — it is being rebuilt in the background. ` +
          `Graph-dependent tools will wait for completion on first request.`
        );
        // Actually start the rebuild — the warning above is only honest if
        // something kicks `analyze --force`. The watcher only schedules its own,
        // and a read no longer wipes-then-heals (change: harden-index-store-lifecycle).
        triggerRebuild(root);
      }
    } else {
      schemaReset = false;
    }
  } catch (err) {
    logger.debug(`[serve] Failed to check schema on startup: ${err instanceof Error ? err.message : String(err)}`);
    schemaReset = false;
  }

  // ── Freshness: watcher (signatures + vector) + debounced call-graph re-analyze ──
  // The watcher keeps signatures/vector fresh between commits and primes the read
  // cache in place. Its onBatchFlushed hook schedules a heavier full re-analyze so
  // the CALL GRAPH (which the watcher deliberately skips) also stays fresh between
  // commits — turning divergence from "wait for the next commit" into continuous.
  let watcher: McpWatcher | undefined;
  let reanalyzeTimer: ReturnType<typeof setTimeout> | undefined;

  // Debounced call-graph re-analyze. Routes through triggerRebuild so it shares
  // the single-flight lock with the schema-reset healer (no concurrent --force).
  function scheduleReanalyze(): void {
    if (teardownRequested) return;
    if (reanalyzeTimer) clearTimeout(reanalyzeTimer);
    reanalyzeTimer = setTimeout(() => triggerRebuild(root), REANALYZE_DEBOUNCE_MS);
    // Don't keep the daemon alive for this debounce alone — the HTTP socket owns
    // the daemon's lifetime; a pending re-analyze must never delay a shutdown
    // (change: fix-process-exit-lifecycle; parity with idleTimer above).
    reanalyzeTimer.unref?.();
  }

  if (options.watch !== false) {
    // onGraphStale (make-index-self-healing): a HEAD change (branch switch / pull)
    // or a budget-exceeded stale region routes through the SAME rebuild coordinator
    // as edits, so call-graph freshness no longer depends on the post-commit hook and
    // the two rebuild paths coalesce into one.
    watcher = new McpWatcher({
      rootPath: root,
      onBatchFlushed: () => scheduleReanalyze(),
      onGraphStale: () => scheduleReanalyze(),
    });
    try {
      await watcher.start();
      logger.discovery(`[serve] watching ${root} — signatures/vector live, call-graph re-analyze debounced`);
    } catch (err) {
      logger.warning(`[serve] watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
      watcher = undefined;
    }
  }

  // A serve daemon owns a repeatable, coalesced rebuild coordinator even when
  // its filesystem watcher is disabled. Register repair authority for this
  // canonical served root only; request paths for any other repository cannot
  // borrow it (change: disclose-stale-serving-on-cold-reads).
  const unregisterRepairHost = registerRepairHost(root, staleFiles => {
    if (watcher) return watcher.requestColdReadRepair(staleFiles);
    triggerRebuild(root);
    return true;
  });

  // Clean shutdown: drop the descriptor so clients don't reuse a dead port.
  // Signal handlers exit the process; the returned close() is for in-process
  // callers (tests) that must not kill the host.
  // Store handler refs so teardown() can remove them — without this, every
  // startServe() call (including each test) adds permanent process listeners
  // that accumulate and trigger MaxListenersExceededWarning.
  let teardownPromise: Promise<void> | undefined;
  let teardownAnnounced: Promise<boolean> = Promise.resolve(true);
  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    // Set this synchronously. Until the draining descriptor is published,
    // /health stays reusable while every mutating route returns 503, so a
    // concurrent starter can never infer "dead" and create a second writer.
    teardownRequested = true;
    teardownAnnounced = (async () => {
      const announced = await readDescriptor(root);
      if (announced?.state === 'draining') return true;
      try {
        await writeInstanceDescriptor(serveFilePath(root), { ...descriptor, state: 'draining' });
        return true;
      } catch (err) {
        logger.warning(
          `[serve] could not publish draining state: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    })();
    teardownPromise = (async () => {
      await teardownAnnounced;
      process.off('SIGINT',  onSigInt);
      process.off('SIGTERM', onSigTerm);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (reanalyzeTimer) {
        clearTimeout(reanalyzeTimer);
        reanalyzeTimer = undefined;
      }
      unregisterRepairHost();
      if (watcher) await watcher.stop().catch(() => {});
      rebuildPending.clear();
      await drainServeRebuilds(rebuildPromises.values());
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      await serverClosed;
      releaseContextCache(root);
      await unlink(serveFilePath(root)).catch(() => {});
      if (!startupLockReleased) {
        await lockResult.release()
          .then(() => { startupLockReleased = true; })
          .catch(() => {});
      }
    })();
    return teardownPromise;
  };
  async function exitAfterTeardown(): Promise<void> {
    await teardown();
    process.exit(0);
  }
  const onSigInt  = () => void exitAfterTeardown();
  const onSigTerm = () => void exitAfterTeardown();
  process.on('SIGINT',  onSigInt);
  process.on('SIGTERM', onSigTerm);

  // Publish only after teardown, watcher, repair authority, and signal handlers
  // are live. A waiting stop/reuse caller cannot observe a half-started daemon.
  lifecycleReady = true;
  const descriptor: ServeDescriptor = {
    port: boundPort,
    pid: process.pid,
    host: discoveryHost,
    token,
    startedAt,
    version: _pkgVersion,
    state: 'ready',
  };
  try {
    await writeInstanceDescriptor(serveFilePath(root), descriptor);
  } catch (err) {
    await releaseStartupLock();
    await teardown();
    logger.error(
      `Could not publish ${serveFilePath(root)} (${err instanceof Error ? err.message : String(err)}); ` +
      'the unannounced daemon was closed.',
    );
    process.exitCode = 1;
    return;
  }
  await releaseStartupLock();

  logger.success(`openlore serve listening on ${serveHttpBaseUrl(host, boundPort)} (preset: ${presetName})`);
  logger.discovery(`Discovery file: ${serveFilePath(root)}`);

  // Until the first request, the daemon already counts as idle — a client that
  // spawns one but never calls it (e.g. a crashed session) will still be reaped.
  touchActivity();
  if (idleMs > 0) logger.discovery(`[serve] idle shutdown after ${idleMs / 60_000}min of inactivity`);

  return {
    port: boundPort,
    host,
    token,
    baseUrl: serveHttpBaseUrl(host, boundPort),
    close: teardown,
  };
  } finally {
    await releaseStartupLock();
  }
}

export const serveCommand = new Command('serve')
  .description('Start a warm local HTTP daemon exposing openlore tools (loopback, for editor/agent integrations like Pi)')
  .option('-d, --directory <path>', 'Project root to serve (discovery file written here)', process.cwd())
  .option('-p, --port <number>', 'Port to bind (default: ephemeral free port)')
  .option('--host <host>', 'Loopback host, or token-protected wildcard 0.0.0.0/::', '127.0.0.1')
  .option(
    '--preset <name>',
    `Callable tool surface enforced at dispatch (navigation, substrate, minimal, or all/full). Default: ${LEAN_DEFAULT_PRESET}`,
    LEAN_DEFAULT_PRESET,
  )
  .option('--token <token>', 'Require this token as the x-openlore-token header (default: $OPENLORE_SERVE_TOKEN)')
  .option('--no-watch', 'Disable the freshness watcher + debounced call-graph re-analyze')
  .option('--idle-timeout <minutes>', `Self-terminate after this many minutes with no requests, so orphaned daemons can't pile up in RAM (0 disables). Default: ${DEFAULT_IDLE_TIMEOUT_MIN}`)
  .option('--stop', 'Stop a running daemon for --directory and exit')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore serve                          Warm daemon, substrate preset (default), ephemeral port
  $ openlore serve --preset all --port 7077 All tools on a fixed port
  $ openlore serve --stop                   Stop the daemon serving this directory

  $ curl 127.0.0.1:$PORT/health
  $ curl -XPOST 127.0.0.1:$PORT/tool/orient -d '{"args":{"task":"add rate limiting"}}'
`,
  )
  .action(async (options: ServeCliOptions) => {
    await startServe(options);
  });
