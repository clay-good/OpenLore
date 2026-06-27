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
 * surface (default: `navigation`).
 *
 * Endpoints (all loopback):
 *   GET  /health           → { ok, version, root, preset, tools, uptimeMs }
 *   POST /tool/:name       body { directory?, args }  → handler result (JSON)
 *
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
import { timingSafeEqual } from 'node:crypto';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, FULL_PRESET, FULL_PRESET_ALIAS } from '../../constants.js';
import { dispatchTool, UnknownToolError } from '../../core/services/tool-dispatch.js';
import { validateDirectory, waitForGraphRebuild } from '../../core/services/mcp-handlers/utils.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import { openloreAnalyze } from '../../api/analyze.js';
import { TOOL_DEFINITIONS, TOOL_PRESETS, selectActiveTools } from './mcp.js';
import { validateToolArgs } from '../../core/services/mcp-handlers/tool-guard.js';

/**
 * Debounce before a full call-graph re-analyze after edits settle. Longer than
 * the watcher's signature debounce (WATCH_DEBOUNCE_MS=400) because re-analysis
 * is heavier; a few seconds of quiet is the signal that an edit burst is done.
 */
const REANALYZE_DEBOUNCE_MS = 4000;

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

/** Daemon discovery descriptor written to <root>/.openlore/serve.json. */
interface ServeDescriptor {
  port: number;
  pid: number;
  host: string;
  token?: string;
  startedAt: string;
  version: string;
}

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

const SERVE_FILE = 'serve.json';
const MAX_BODY_BYTES = 1_000_000; // tool args are small; reject anything larger

/** Hostnames that denote the loopback interface (no DNS resolution involved). */
const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '0000:0000:0000:0000:0000:0000:0000:0001',
]);

/** True if `host` is a loopback literal/name (127.0.0.0/8, ::1, localhost). */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // Any 127.x.y.z address is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Extract the hostname (sans port, sans brackets) from a Host/Origin authority. */
function hostnameOf(authority: string): string {
  let a = authority.trim();
  // Strip scheme if this came from an Origin (e.g. http://host:port).
  const scheme = a.indexOf('://');
  if (scheme !== -1) a = a.slice(scheme + 3);
  // Bracketed IPv6: [::1]:port
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    if (close !== -1) return a.slice(1, close).toLowerCase();
  }
  // host:port → host (IPv4 / name only; bare IPv6 has no port form here)
  const colon = a.indexOf(':');
  if (colon !== -1 && a.indexOf(':') === a.lastIndexOf(':')) a = a.slice(0, colon);
  return a.toLowerCase();
}

/**
 * Constant-time string equality. Returns false for length mismatch, but still
 * runs a same-length compare first so timing does not leak the secret's length.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    // Compare ab to itself to burn comparable time, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * DNS-rebinding / cross-origin defense for the loopback daemon. A browser tricked
 * into resolving an attacker domain to 127.0.0.1 still sends the attacker's name in
 * the `Host` header (and an attacker page sends a cross-site `Origin`). We accept a
 * request only when both the Host and any Origin name the loopback interface or the
 * exact bound host. Returns an error string to reject with, or null to allow.
 */
function originDefenseError(req: IncomingMessage, boundHost: string): string | null {
  const boundName = hostnameOf(boundHost);
  const allowed = (name: string): boolean => isLoopbackHost(name) || name === boundName;

  const hostHeader = req.headers.host;
  if (hostHeader === undefined || !allowed(hostnameOf(hostHeader))) {
    return `Host header "${hostHeader ?? ''}" is not an allowed loopback name (DNS-rebinding guard)`;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null' && !allowed(hostnameOf(origin))) {
    return `cross-site Origin "${origin}" is not permitted`;
  }
  return null;
}

function serveFilePath(root: string): string {
  return join(root, OPENLORE_DIR, SERVE_FILE);
}

/** Read a JSON request body with a hard size ceiling. Rejects on overflow/parse error. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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
        resolve_(JSON.parse(raw) as Record<string, unknown>);
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
 * could ship a poisoned serve.json. We fail closed unless every field has the expected
 * type AND the host is a loopback name — otherwise `daemonAlive` would fetch an
 * arbitrary host (egress / SSRF) and `stopDaemon` could SIGTERM an arbitrary pid.
 *
 * Exported for the serve.json validation tests.
 */
export async function readDescriptor(root: string): Promise<ServeDescriptor | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(serveFilePath(root), 'utf-8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;
  const portOk = typeof d.port === 'number' && Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535;
  const pidOk = typeof d.pid === 'number' && Number.isInteger(d.pid) && d.pid > 0;
  // Confine host to loopback: a recorded non-loopback host must never become an
  // outbound fetch target during liveness probing.
  const hostOk = typeof d.host === 'string' && isLoopbackHost(d.host);
  const tokenOk = d.token === undefined || typeof d.token === 'string';
  if (!portOk || !pidOk || !hostOk || !tokenOk) return null;
  return {
    port: d.port as number,
    pid: d.pid as number,
    host: d.host as string,
    token: d.token as string | undefined,
    startedAt: typeof d.startedAt === 'string' ? d.startedAt : '',
    version: typeof d.version === 'string' ? d.version : '',
  };
}

/**
 * Confirm a descriptor points at a LIVE openlore daemon — not a stale serve.json
 * left by a SIGKILL'd process, nor a recycled port now owned by something else.
 * Verifies GET /health returns our `ok: true` shape, so we never signal a PID we
 * can't positively identify as our own daemon.
 */
async function daemonAlive(desc: ServeDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Stop a daemon previously started for `root` by signalling its recorded pid. */
async function stopDaemon(root: string): Promise<void> {
  const path = serveFilePath(root);
  const desc = await readDescriptor(root);
  if (!desc) {
    logger.warning(`No running openlore serve daemon found for ${root}.`);
    return;
  }
  // Only signal a PID we've confirmed is our live daemon on the recorded port.
  // A stale serve.json could otherwise point at a recycled PID belonging to an
  // unrelated process — SIGTERM to that would be a nasty surprise.
  if (!(await daemonAlive(desc))) {
    await unlink(path).catch(() => {});
    logger.warning(`No live daemon at ${desc.host}:${desc.port}; removed stale ${SERVE_FILE}.`);
    return;
  }
  try {
    process.kill(desc.pid, 'SIGTERM');
    logger.success(`Sent SIGTERM to openlore serve (pid ${desc.pid}).`);
  } catch {
    await unlink(path).catch(() => {});
    logger.warning(`Daemon pid ${desc.pid} not signalable; removed stale ${SERVE_FILE}.`);
  }
}

export async function startServe(options: ServeCliOptions): Promise<ServeHandle | undefined> {
  const root = resolve(options.directory ?? process.cwd());

  if (options.stop) {
    await stopDaemon(root);
    return undefined;
  }

  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? (process.env.OPENLORE_SERVE_TOKEN || undefined);

  // A non-loopback bind exposes the tool surface to other hosts on the network;
  // refuse it without a token (mcp-security: Local Daemon Authentication).
  if (!isLoopbackHost(host) && !token) {
    logger.error(
      `Refusing to bind non-loopback host "${host}" without a token. ` +
      `A non-loopback bind exposes openlore tools to the network; pass --token <secret> ` +
      `(or set OPENLORE_SERVE_TOKEN) to require authentication.`,
    );
    process.exitCode = 1;
    return;
  }
  // A loopback bind with no token is still reachable by other local processes.
  if (isLoopbackHost(host) && !token) {
    logger.warning(
      `[serve] No token configured — any local process on this machine can call openlore tools ` +
      `on ${host}. Pass --token to restrict access.`,
    );
  }

  const presetName = options.preset ?? 'navigation';
  // Full-surface selectors: serve historically used `all`; accept `full` too so
  // the selector vocabulary matches `openlore mcp` (change: default-to-lean-tool-
  // surface added `full`/`all` there). Both mean every tool.
  const isFullSurface = presetName === FULL_PRESET_ALIAS || presetName === FULL_PRESET;
  if (!isFullSurface && !TOOL_PRESETS[presetName]) {
    logger.error(`Unknown --preset "${presetName}". Known: ${Object.keys(TOOL_PRESETS).join(', ')}, ${FULL_PRESET_ALIAS}, ${FULL_PRESET}.`);
    process.exitCode = 1;
    return;
  }
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
  function touchActivity(): void {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
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
  const existing = await readDescriptor(root);
  if (existing && (await daemonAlive(existing))) {
    logger.success(
      `openlore serve already running for ${root} at http://${existing.host}:${existing.port} — reusing.`,
    );
    return {
      port: existing.port,
      host: existing.host,
      token: existing.token,
      baseUrl: `http://${existing.host}:${existing.port}`,
      close: async () => {}, // never tear down a daemon this process didn't start
    };
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Per-directory schema-reset flag. Set once (at startup or first request);
  // cleared after waitForGraphRebuild() succeeds so subsequent requests don't
  // re-open EdgeStore. Uses a Map because the daemon can serve multiple dirs.
  const schemaResetByDir = new Map<string, boolean>();

  // Single forced-rebuild coordinator, keyed by directory. BOTH the schema-reset
  // healer (below) and the watcher's debounced re-analyze (further down) funnel
  // through here, so at most one `analyze --force` ever runs per directory at a
  // time — two concurrent ones would clear+repopulate the same EdgeStore
  // non-atomically and could tear the graph. A trigger that arrives mid-rebuild
  // is coalesced into a single follow-up run rather than dropped or stacked.
  //
  // Why serve must drive this at all: a schema-version bump makes EdgeStore.open()
  // wipe the DB and report wasReset ONCE (the on-disk version is rewritten on that
  // first open, so every later open reports false). serve consumes that flag at
  // startup / first request, so the watcher's wasReset-keyed self-heal never sees
  // it; without an explicit trigger, waitForGraphRebuild() would poll an empty
  // store until it times out.
  const rebuildRunning = new Set<string>();
  const rebuildPending = new Set<string>();
  function triggerRebuild(directory: string): void {
    if (rebuildRunning.has(directory)) { rebuildPending.add(directory); return; }
    rebuildRunning.add(directory);
    logger.discovery(`[serve] rebuilding graph index (${directory})`);
    void openloreAnalyze({ rootPath: directory, force: true })
      .then(() => logger.discovery(`[serve] graph index rebuilt (${directory})`))
      .catch((err) => logger.warning(`[serve] graph rebuild failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        rebuildRunning.delete(directory);
        if (rebuildPending.delete(directory)) {
          // Re-run for the coalesced trigger. For the served root, go back through
          // the debounce so sustained editing doesn't spin back-to-back analyzes;
          // other dirs (per-request schema heal) re-run immediately.
          if (directory === root) scheduleReanalyze();
          else triggerRebuild(directory);
        }
      });
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    touchActivity(); // any request (incl. /health) keeps an in-use daemon alive
    const url = new URL(req.url ?? '/', `http://${host}`);

    // DNS-rebinding / cross-origin defense — runs before ANY dispatch, including
    // /health, so a malicious page can't even probe the daemon's existence.
    const originErr = originDefenseError(req, host);
    if (originErr) {
      sendJson(res, 403, { error: originErr });
      return;
    }

    // Token gate (skips /health so liveness checks need no secret). Compared in
    // constant time so a timing oracle can't recover the token byte-by-byte.
    if (token && url.pathname !== '/health') {
      const presented = req.headers['x-openlore-token'];
      if (typeof presented !== 'string' || !constantTimeEqual(presented, token)) {
        sendJson(res, 401, { error: 'invalid or missing x-openlore-token' });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        version: _pkgVersion,
        root,
        preset: presetName,
        tools: [...activeNames],
        uptimeMs: Date.now() - startMs,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/tool/')) {
      const name = decodeURIComponent(url.pathname.slice('/tool/'.length));
      // The preset is ADVISORY (reported by /health for clients that want a
      // curated list, e.g. the Pi extension). The daemon dispatches any known
      // tool so it can back multiple clients with different surfaces — notably
      // the MCP server, which delegates all ~60 tools here. Unknown tools 404
      // via UnknownToolError below.
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
        return;
      }
      // `args` must be a plain object; a primitive/array (e.g. {"args":"foo"}) would throw
      // on the `args.directory = …` assignment below — coerce it to {} so a malformed body
      // yields a clean validation error downstream, not a raw TypeError.
      const rawArgs = body.args;
      const args: Record<string, unknown> =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      // Directory precedence: explicit body.directory → args.directory → served root.
      const directory = (typeof body.directory === 'string' && body.directory)
        || (typeof args.directory === 'string' && args.directory)
        || root;
      // Ensure handlers receive directory in args (they read it from there).
      if (typeof args.directory !== 'string') args.directory = directory;

      try {
        await validateDirectory(directory);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid directory' });
        return;
      }

      // Auto-heal schema mismatch: on first request for a directory, open
      // EdgeStore once to detect wasReset; cache the result so we never
      // re-open on subsequent requests. If reset, block until rebuild done.
      if (!schemaResetByDir.has(directory)) {
        try {
          const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
          if (EdgeStore.exists(analysisDir)) {
            const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
            schemaResetByDir.set(directory, es.wasReset);
            es.close();
          } else {
            schemaResetByDir.set(directory, false);
          }
        } catch {
          schemaResetByDir.set(directory, false);
        }
      }
      if (schemaResetByDir.get(directory)) {
        logger.debug(`[serve] Schema mismatch — waiting for graph rebuild before dispatching…`);
        // Kick the rebuild ourselves (coalesced) — nothing else will, because the
        // wasReset flag has already been consumed by the open above.
        triggerRebuild(directory);
        // waitForGraphRebuild polls readCachedContext until edgeStore is
        // non-null. readCachedContext invalidates on llm-context.json mtime,
        // which openloreAnalyze rewrites as its last step — so the poll sees
        // the rebuilt state as soon as analyze completes.
        const rebuilt = await waitForGraphRebuild(directory, 60_000);
        schemaResetByDir.set(directory, !rebuilt);
        if (!rebuilt) logger.warning(`[serve] Graph rebuild timed out — graph tools may return empty results.`);
      }

      // Validate args against the tool's declared inputSchema before dispatch, so a
      // missing/malformed required argument returns a clear "Invalid arguments" message
      // instead of a raw handler TypeError (e.g. "Cannot read properties of undefined").
      // The MCP stdio transport validates the same way; this keeps the daemon transport —
      // used directly by the Pi extension and other HTTP clients — from leaking internal
      // errors to weak tool-callers.
      const toolDef = TOOL_DEFINITIONS.find(t => t.name === name);
      if (toolDef) {
        const argError = validateToolArgs(args, toolDef.inputSchema);
        if (argError) {
          sendJson(res, 400, { error: `Invalid arguments for "${name}": ${argError}` });
          return;
        }
      }

      try {
        const result = await dispatchTool(name, args, directory);
        sendJson(res, 200, result ?? null);
      } catch (err) {
        if (err instanceof UnknownToolError) {
          sendJson(res, 404, { error: err.message });
          return;
        }
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
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

  const descriptor: ServeDescriptor = {
    port: boundPort,
    pid: process.pid,
    host,
    token,
    startedAt,
    version: _pkgVersion,
  };
  await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  await writeFile(serveFilePath(root), JSON.stringify(descriptor, null, 2) + '\n', 'utf-8');

  logger.success(`openlore serve listening on http://${host}:${boundPort} (preset: ${presetName})`);
  logger.discovery(`Discovery file: ${serveFilePath(root)}`);

  // Pre-populate the schema-reset flag for the served root so the startup
  // warning fires immediately and the first request doesn't pay the open cost.
  try {
    const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    if (EdgeStore.exists(analysisDir)) {
      const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
      const reset = es.wasReset;
      es.close();
      schemaResetByDir.set(root, reset);
      if (reset) {
        logger.warning(
          `[serve] Schema version mismatch detected — graph index is being rebuilt in the background. ` +
          `Graph-dependent tools will wait for completion on first request.`
        );
        // Actually start the rebuild — the warning above is only honest if
        // something kicks `analyze --force`. The watcher won't: its self-heal
        // keys off wasReset, which this startup open just consumed.
        triggerRebuild(root);
      }
    } else {
      schemaResetByDir.set(root, false);
    }
  } catch (err) {
    logger.debug(`[serve] Failed to check schema on startup: ${err instanceof Error ? err.message : String(err)}`);
    schemaResetByDir.set(root, false);
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
    if (reanalyzeTimer) clearTimeout(reanalyzeTimer);
    reanalyzeTimer = setTimeout(() => triggerRebuild(root), REANALYZE_DEBOUNCE_MS);
  }

  if (options.watch !== false) {
    watcher = new McpWatcher({ rootPath: root, onBatchFlushed: () => scheduleReanalyze() });
    try {
      await watcher.start();
      logger.discovery(`[serve] watching ${root} — signatures/vector live, call-graph re-analyze debounced`);
    } catch (err) {
      logger.warning(`[serve] watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
      watcher = undefined;
    }
  }

  // Clean shutdown: drop the descriptor so clients don't reuse a dead port.
  // Signal handlers exit the process; the returned close() is for in-process
  // callers (tests) that must not kill the host.
  // Store handler refs so teardown() can remove them — without this, every
  // startServe() call (including each test) adds permanent process listeners
  // that accumulate and trigger MaxListenersExceededWarning.
  let shuttingDown = false;
  const teardown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off('SIGINT',  onSigInt);
    process.off('SIGTERM', onSigTerm);
    if (idleTimer) clearTimeout(idleTimer);
    if (reanalyzeTimer) clearTimeout(reanalyzeTimer);
    if (watcher) await watcher.stop().catch(() => {});
    await unlink(serveFilePath(root)).catch(() => {});
    await new Promise<void>((res) => server.close(() => res()));
  };
  const exitAfterTeardown = async (): Promise<void> => {
    await teardown();
    process.exit(0);
  };
  const onSigInt  = () => void exitAfterTeardown();
  const onSigTerm = () => void exitAfterTeardown();
  process.on('SIGINT',  onSigInt);
  process.on('SIGTERM', onSigTerm);

  // Arm the idle timer now that teardown exists. Until the first request, the
  // daemon already counts as idle — a client that spawns one but never calls it
  // (e.g. a crashed session) will still be reaped.
  touchActivity();
  if (idleMs > 0) logger.discovery(`[serve] idle shutdown after ${idleMs / 60_000}min of inactivity`);

  return {
    port: boundPort,
    host,
    token,
    baseUrl: `http://${host}:${boundPort}`,
    close: teardown,
  };
}

export const serveCommand = new Command('serve')
  .description('Start a warm local HTTP daemon exposing openlore tools (loopback, for editor/agent integrations like Pi)')
  .option('-d, --directory <path>', 'Project root to serve (discovery file written here)', process.cwd())
  .option('-p, --port <number>', 'Port to bind (default: ephemeral free port)')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option(
    '--preset <name>',
    'Advisory tool surface reported by /health (navigation, substrate, minimal, or all/full). The daemon still ' +
      'dispatches any known tool; clients curate their own surface. Default: navigation',
    'navigation',
  )
  .option('--token <token>', 'Require this token as the x-openlore-token header (default: $OPENLORE_SERVE_TOKEN)')
  .option('--no-watch', 'Disable the freshness watcher + debounced call-graph re-analyze')
  .option('--idle-timeout <minutes>', `Self-terminate after this many minutes with no requests, so orphaned daemons can't pile up in RAM (0 disables). Default: ${DEFAULT_IDLE_TIMEOUT_MIN}`)
  .option('--stop', 'Stop a running daemon for --directory and exit')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore serve                          Warm daemon, navigation preset, ephemeral port
  $ openlore serve --preset all --port 7077 All tools on a fixed port
  $ openlore serve --stop                   Stop the daemon serving this directory

  $ curl 127.0.0.1:$PORT/health
  $ curl -XPOST 127.0.0.1:$PORT/tool/orient -d '{"args":{"task":"add rate limiting"}}'
`,
  )
  .action(async (options: ServeCliOptions) => {
    await startServe(options);
  });
