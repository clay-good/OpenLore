/**
 * Background index repair service (changes: add-zero-interaction-onboarding →
 * make-index-self-healing).
 *
 * Originally the cold-start self-bootstrap: if an agent wired the OpenLore MCP
 * server but never ran `openlore install`, the very first session had no index
 * and every tool returned "run analyze first." That warmed an ABSENT index once,
 * in the background.
 *
 * `make-index-self-healing` generalizes it: every read-path staleness signal that
 * today only produces a warning (integrity `mismatched`, an over-threshold stale
 * region, a schema reset, an aged analysis) now triggers the SAME at-most-once,
 * non-blocking background rebuild — so detection finally closes the loop into
 * repair instead of stopping at disclosure.
 *
 * Guarantees (unchanged from the bootstrap it grew out of):
 *   - AT MOST ONCE per process per repo. A completed repair that still observes
 *     its trigger discloses and stops — it never loops or thrashes. The guard is
 *     cleared only on FAILURE, so a transient build error can retry.
 *   - NEVER blocks the caller: the build runs detached from the call path; reads
 *     during it are served from the stale index with an honest "refresh started"
 *     disclosure, never held.
 *   - NEVER throws: a build failure leaves the graceful guidance in place.
 *   - Opt-out via `OPENLORE_NO_AUTO_ANALYZE` or `.openlore/config.json` `autoInit:false`.
 *
 * Deterministic, no LLM, no new dependency.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep, win32 } from 'node:path';
import {
  AUTO_INIT_DEGRADED_FILE_CEILING,
  OPENLORE_ANALYSIS_REL_PATH,
} from '../../constants.js';
import { resolveOpenLoreConfigPath } from './config-manager.js';

/**
 * Why a background repair was started. `index-absent` is the original cold-start
 * case (no artifact at all); the rest are the self-healing triggers layered on by
 * make-index-self-healing.
 */
export type RepairReason =
  | 'index-absent'
  | 'integrity-mismatched'
  | 'stale-region'
  | 'schema-reset'
  | 'analysis-age';

/** Human-facing label for each reason, used in the "refresh started" disclosure. */
export const REPAIR_REASON_DETAIL: Record<RepairReason, string> = {
  'index-absent': 'no index found',
  'integrity-mismatched': 'the index did not reconcile against its build attestation',
  'stale-region': 'part of the index is explicitly stale',
  'schema-reset': 'the index schema was reset by a version upgrade',
  'analysis-age': 'the analysis is older than the freshness threshold',
};

/** Directories already repaired (or in flight) this process — build at most once each. */
const attempted = new Set<string>();

/** In-flight repairs, keyed by directory, so a read can disclose "refresh started". */
const inFlight = new Map<string, {
  reason: RepairReason;
  startedAt: number;
  mode: RepairBuildMode;
  ceiling: number;
  sizedFiles: number;
}>();

/** How a repository's first build is described once its lane is known. */
const firstTouchLanes = new Map<string, { mode: RepairBuildMode; sizedFiles: number; ceiling: number }>();

/**
 * First-touch notices not yet delivered to a caller, keyed by directory.
 *
 * A repo's FIRST background build is disclosed exactly once — the response that
 * takes the notice clears it. Kept separate from {@link inFlight} so the notice
 * survives a build that finishes before any tool call reads it: a first touch the
 * user never saw disclosed is precisely the silent auto-indexing this guardrail
 * exists to prevent (change: unify-onboarding-entrypoint).
 */
const firstTouchNotices = new Set<string>();

/** Analyzer children owned by the MCP transport lifetime. */
const activeBuildChildren = new Set<ChildProcess>();
let childBuildsStopping = false;

/**
 * The default index builder, registered once by the MCP server at startup. Lets a
 * read-path caller (mcp-handlers/utils.ts) — which deliberately never imports the
 * analyzer or install layer — trigger a repair without threading a builder through
 * every handler. When nothing is registered (CLI, tests, a non-server host), a
 * read-path repair is a silent no-op: detection and disclosure are unchanged, only
 * the automatic rebuild is skipped.
 */
let registeredBuilder: RepairBuilder | null = null;

/**
 * How much work an auto-init build does. `full` is the ordinary lane; `degraded`
 * sheds the semantic-embedding pass on a tree above
 * {@link AUTO_INIT_DEGRADED_FILE_CEILING} files, leaving signatures + the keyword
 * (BM25) corpus — enough for `orient` to answer, without pinning a laptop on a
 * monorepo (change: unify-onboarding-entrypoint).
 */
export type RepairBuildMode = 'full' | 'degraded';

/** The index builder a host registers. `mode` is advisory: an older builder ignores it. */
export type RepairBuilder = (directory: string, opts?: { mode?: RepairBuildMode }) => Promise<void>;

/**
 * A long-lived host's non-blocking handoff for files found stale by a cited-file
 * read check. Returning true means the host accepted the repair request (it may
 * coalesce it with work already queued); false means disclosure must remain
 * repair-agnostic. The callback must not await the repair itself.
 */
export type RepairHost = (staleFiles: readonly string[]) => boolean;

interface RepairHostRegistration {
  callback: RepairHost;
  token: symbol;
}

/** Repair hosts keyed by canonical repository root; newest active registration wins. */
const repairHosts = new Map<string, RepairHostRegistration[]>();

/** Resolve path aliases to the same stable repository identity. */
function canonicalRoot(directory: string): string {
  let root: string;
  try {
    root = realpathSync.native(resolve(directory));
  } catch {
    root = resolve(directory);
  }
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

/**
 * Register the repair path owned by one watcher/serve host. Registrations are
 * exact-root scoped: hosting repo A never authorizes repair work in repo B.
 *
 * The disposer is identity-safe. If a replacement host registers for the same
 * root before the old host tears down, the old disposer cannot remove the new
 * registration.
 */
export function registerRepairHost(directory: string, callback: RepairHost): () => void {
  const root = canonicalRoot(directory);
  const registration = { callback, token: Symbol(root) };
  const registrations = repairHosts.get(root) ?? [];
  registrations.push(registration);
  repairHosts.set(root, registrations);
  return () => {
    const active = repairHosts.get(root);
    if (!active) return;
    const index = active.findIndex(candidate => candidate.token === registration.token);
    if (index < 0) return;
    active.splice(index, 1);
    if (active.length === 0) repairHosts.delete(root);
  };
}

/**
 * Offer cited stale files to the host for this exact repository. Returns true
 * only when a registered host accepted the request. Missing or throwing hosts
 * fail soft so a read can still serve its factual staleness disclosure.
 */
export function requestRepairFromHost(directory: string, staleFiles: readonly string[]): boolean {
  if (!directory || staleFiles.length === 0) return false;
  const registrations = repairHosts.get(canonicalRoot(directory));
  const host = registrations?.[registrations.length - 1];
  if (!host) return false;
  try {
    return host.callback([...staleFiles]) === true;
  } catch {
    return false;
  }
}

/** Register the process-wide repair builder (the MCP server injects install's forced buildIndex). */
export function registerRepairBuilder(fn: RepairBuilder): void {
  registeredBuilder = fn;
}

/** True once an `openlore analyze` artifact exists for the directory. */
export function hasAnalysis(directory: string): boolean {
  return existsSync(join(directory, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'));
}

/** True when `.openlore/config.json` explicitly sets `autoInit: false`. Fail-open. */
function autoInitDisabled(directory: string): boolean {
  try {
    const raw = readFileSync(resolveOpenLoreConfigPath(directory), 'utf-8');
    return (JSON.parse(raw) as { autoInit?: unknown }).autoInit === false;
  } catch {
    return false; // no config / unreadable → auto-init not disabled
  }
}

/**
 * Is `directory` inside a git work tree?
 *
 * A filesystem walk-up for a `.git` entry (a directory at a repository root, a
 * FILE in a linked worktree or submodule), not a `git rev-parse` shell-out: this
 * guard runs on the read path, must be synchronous, and must not spawn a process
 * per tool call. It is deliberately CONSERVATIVE — a path inside a `.git`
 * directory is rejected outright — because the cost of a false positive (indexing
 * a directory the user never asked about) is the exact harm the guard exists to
 * prevent (change: unify-onboarding-entrypoint).
 */
export function isInsideGitWorkTree(directory: string, home = homedir()): boolean {
  let dir: string;
  try {
    dir = canonicalRoot(directory);
  } catch {
    return false;
  }
  // Never treat the repository's own metadata directory as a work tree.
  if (dir.split(sep).includes('.git')) return false;
  // Canonical on BOTH sides. A home directory reached through a symlink (a home on
  // another volume, /home/u -> /mnt/data/u) or spelled with different case on
  // Windows would otherwise compare unequal and let the very case below through.
  let homeRoot: string | null;
  try { homeRoot = canonicalRoot(home); } catch { homeRoot = null; }
  for (;;) {
    if (isGitDirEntry(join(dir, '.git'))) {
      // A repository at or ABOVE the home directory makes EVERY directory under it
      // — Downloads, Desktop, a scratch folder — pass a plain work-tree test, which
      // would let one wired agent auto-index the user's whole home. A dotfiles repo
      // rooted at $HOME is the common shape; a `.git` at `/Users` or `/` is the
      // pathological one. Both are out of scope for auto-init; an explicit
      // `openlore analyze` there still works.
      if (homeRoot === null) return true;
      // `dir` may already end in the separator at a filesystem root ("/", "C:\\"),
      // where a naive `dir + sep` yields "//" and matches nothing.
      const prefix = dir.endsWith(sep) ? dir : dir + sep;
      return !(homeRoot === dir || homeRoot.startsWith(prefix));
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Is `path` a real `.git` entry — a directory, or the `gitdir: …` pointer file a
 * linked worktree or submodule uses? A plain file called `.git` with arbitrary
 * content (an extracted archive, a stray artifact) is not a repository, and this
 * guard is the one thing standing between "an agent opened a directory" and "we
 * indexed it".
 */
function isGitDirEntry(path: string): boolean {
  // Open ONCE, then answer every question from that descriptor. Any
  // stat-the-path-then-use-the-path pair is a time-of-check/time-of-use race: the
  // entry can become a directory, a device, or a link to elsewhere in between, so
  // what gets classified is not what got checked.
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    // Windows cannot open a directory for reading. There is nothing to race here:
    // this answers and returns without touching the path again.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') {
      try { return statSync(path).isDirectory(); } catch { return false; }
    }
    return false;
  }
  try {
    const info = fstatSync(fd);
    if (info.isDirectory()) return true;
    if (!info.isFile()) return false;
    // A `gitdir:` pointer is one short line; a fixed prefix bounds the read
    // whatever the entry turns out to be.
    const head = Buffer.alloc(64);
    const bytes = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, bytes).toString('utf-8').trimStart().startsWith('gitdir:');
  } catch {
    return false;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Directory names never descended when sizing a tree for the auto-init ceiling. */
const SIZING_SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', '.openlore', 'dist', 'build', 'out', 'target',
  'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'coverage',
]);

/**
 * Count files under `directory`, stopping as soon as `limit` is exceeded.
 *
 * Bounded by construction (both the count and a directory budget), so sizing a
 * 400,000-file monorepo costs the same as sizing a small one. The answer is only
 * ever used as "at or above the ceiling?", so an approximate count is sufficient
 * and an unreadable directory simply contributes nothing.
 */
export function countFilesBounded(directory: string, limit: number): number {
  let count = 0;
  let directoriesVisited = 0;
  const queue = [resolve(directory)];
  while (queue.length > 0 && count <= limit && directoriesVisited < 20_000) {
    const dir = queue.pop()!;
    directoriesVisited++;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SIZING_SKIP_DIRECTORIES.has(entry.name)) continue;
        queue.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        if (++count > limit) return count;
      }
    }
  }
  return count;
}

/**
 * Why background auto-init is suppressed for `directory`, or undefined when it is
 * allowed to run.
 *
 * Read by the not-ready path so a repo that opted out is told WHY nothing is
 * building — an opted-out repo that merely says "no analysis found" reads as a
 * broken install (change: unify-onboarding-entrypoint).
 */
export function autoInitSuppression(
  directory: string,
): { reason: 'config' | 'env' | 'not-a-git-work-tree'; detail: string } | undefined {
  if (process.env.OPENLORE_NO_AUTO_ANALYZE) {
    return { reason: 'env', detail: 'OPENLORE_NO_AUTO_ANALYZE is set in this environment' };
  }
  if (autoInitDisabled(directory)) {
    return { reason: 'config', detail: '"autoInit": false in .openlore/config.json' };
  }
  if (!isInsideGitWorkTree(directory)) {
    return { reason: 'not-a-git-work-tree', detail: 'this directory is not inside a git work tree' };
  }
  return undefined;
}

export interface RepairOptions {
  /**
   * The index builder to run. Optional: when omitted, the process-wide builder
   * registered via {@link registerRepairBuilder} is used. Production registers
   * install's forced buildIndex (init + structural analyze + BM25 search corpus,
   * no API key) so `orient` heals to FULL parity, not just the structural graph.
   */
  analyze?: RepairBuilder;
  /** Opt out entirely (env OPENLORE_NO_AUTO_ANALYZE, or a caller flag). */
  disabled?: boolean;
  /** Status sink (defaults to process.stderr). Never stdout — that is protocol. */
  log?: (msg: string) => void;
  /** Injected at-most-once guard set (tests). */
  seen?: Set<string>;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * File-count ceiling above which an auto-init build sheds the embedding pass.
   * Defaults to {@link AUTO_INIT_DEGRADED_FILE_CEILING}; a test seam, not a knob.
   */
  degradeAboveFiles?: number;
  /** Injected tree sizer (tests). Defaults to the bounded filesystem count. */
  countFiles?: (directory: string, limit: number) => number;
}

export interface ChildProcessBuildOptions {
  /** Rebuild even when the source fingerprint is unchanged. */
  repair?: boolean;
  /**
   * `degraded` sheds the semantic-embedding pass (`analyze --no-embed`), leaving
   * signatures + the keyword (BM25) corpus. Defaults to `full`.
   */
  mode?: RepairBuildMode;
  /** Test seam; production uses the current OpenLore CLI entry point. */
  cliPath?: string;
  /** Test seam for observing the child-process boundary. */
  spawnProcess?: typeof spawn;
}

/** Open a fresh MCP transport lifetime for child-process builds. */
export function enableChildProcessBuilds(): void {
  childBuildsStopping = false;
}

function terminateBuildChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform = process.platform,
  spawnTreeKiller: typeof spawn = spawn,
): void {
  // Detached POSIX children lead their own process group. Analyze may heap-
  // reexec beneath that leader, so signal the group before falling back to the
  // supervisor PID. Windows has no negative-PID process-group signaling.
  if (platform === 'win32' && child.pid !== undefined) {
    const fallback = () => {
      try { child.kill(signal); } catch { /* already gone */ }
    };
    try {
      const configuredRoot = process.env.SystemRoot ?? process.env.WINDIR;
      const systemRoot = configuredRoot && win32.isAbsolute(configuredRoot)
        ? configuredRoot
        : 'C:\\Windows';
      const killer = spawnTreeKiller(
        win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
        { stdio: 'ignore', windowsHide: true },
      );
      let settled = false;
      killer.once('error', () => {
        if (settled) return;
        settled = true;
        fallback();
      });
      killer.once('close', code => {
        if (settled) return;
        settled = true;
        if (code !== 0) fallback();
      });
      killer.unref();
      return;
    } catch {
      fallback();
      return;
    }
  }
  if (platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone or unavailable; try the leader below.
    }
  }
  child.kill(signal);
}

/** Test seam for the platform-specific process-tree termination contract. */
export function _terminateBuildChildForTesting(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  spawnTreeKiller: typeof spawn,
): void {
  terminateBuildChild(child, signal, platform, spawnTreeKiller);
}

/** Terminate analyzer children when their owning MCP transport closes. */
export async function stopChildProcessBuilds(graceMs = 1_000): Promise<void> {
  childBuildsStopping = true;
  const children = [...activeBuildChildren];
  await Promise.all(children.map(child => new Promise<void>(resolveStop => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeBuildChildren.delete(child);
      resolveStop();
    };
    const timer = setTimeout(() => {
      try { terminateBuildChild(child, 'SIGKILL'); } catch { /* already gone */ }
      done();
    }, graceMs);
    child.once('close', done);
    child.once('error', done);
    try { terminateBuildChild(child, 'SIGTERM'); } catch { done(); }
  })));
}

/**
 * Build the complete first-use index outside the MCP server's event loop.
 * Initialization is also delegated when the repository has no config yet, so
 * the parent process performs no analyzer or install work.
 */
export async function buildIndexInChildProcess(
  directory: string,
  opts: ChildProcessBuildOptions = {},
): Promise<void> {
  const cliPath = opts.cliPath ?? process.argv[1];
  if (!cliPath) throw new Error('Cannot locate the OpenLore CLI entry point');
  const spawnProcess = opts.spawnProcess ?? spawn;

  const run = (args: string[]): Promise<void> => new Promise((resolveRun, rejectRun) => {
    if (childBuildsStopping) {
      rejectRun(new Error('OpenLore child build canceled during shutdown'));
      return;
    }
    let settled = false;
    const child: ChildProcess = spawnProcess(
      process.execPath,
      [cliPath, ...args],
      // windowsHide: detached alone surfaces a console window on Windows.
      { cwd: directory, stdio: 'ignore', detached: true, windowsHide: true },
    );
    activeBuildChildren.add(child);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      activeBuildChildren.delete(child);
      rejectRun(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      activeBuildChildren.delete(child);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`OpenLore ${args[0]} child exited with code ${code ?? 'unknown'}`));
    });
    child.unref();
  });

  if (!existsSync(resolveOpenLoreConfigPath(directory))) await run(['init']);
  await run([
    'analyze',
    ...(opts.repair ? ['--reanalyze'] : []),
    ...(opts.mode === 'degraded' ? ['--no-embed'] : []),
    '--embedded',
  ]);
}

/**
 * Kick a one-time background repair for `directory` using the caller-supplied or
 * process-registered builder. Returns the in-flight build promise (so tests can
 * await it), or null when nothing was started (already repaired this process,
 * disabled, no builder available, or empty directory). NEVER throws, NEVER blocks.
 */
export function repairInBackground(
  directory: string,
  reason: RepairReason,
  opts: RepairOptions = {},
): Promise<void> | null {
  const seen = opts.seen ?? attempted;
  if (opts.disabled || process.env.OPENLORE_NO_AUTO_ANALYZE) return null;
  if (!directory) return null;
  if (seen.has(directory)) return null; // at-most-once per process per repo
  if (autoInitDisabled(directory)) return null;
  // Git work trees only — but ONLY for auto-init. `index-absent` is the case where
  // OpenLore would start indexing a directory nobody asked it to; every other
  // reason repairs an index the user already chose to build, and refusing there
  // would silently kill self-healing for an imported bundle, a vendored tree, or
  // any checkout that is not itself a work tree. Deliberately NOT latched in
  // `seen`: a directory that is not a repository today may be one after
  // `git init`, and the next tool call should be able to bootstrap it
  // (change: unify-onboarding-entrypoint).
  if (reason === 'index-absent' && !isInsideGitWorkTree(directory)) return null;

  const build = opts.analyze ?? registeredBuilder;
  if (!build) return null; // no builder registered (CLI/tests) — detection unchanged, repair skipped

  const ceiling = opts.degradeAboveFiles ?? AUTO_INIT_DEGRADED_FILE_CEILING;
  const countFiles = opts.countFiles ?? countFilesBounded;

  seen.add(directory);
  const now = opts.now ?? Date.now;
  inFlight.set(directory, { reason, startedAt: now(), mode: 'full', ceiling, sizedFiles: 0 });
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  // Registered SYNCHRONOUSLY, so the very response that triggered this build can
  // carry the disclosure. Registered before sizing, the notice is rendered from the
  // in-flight record when it is taken, so it always describes the lane actually
  // chosen (change: unify-onboarding-entrypoint).
  if (reason === 'index-absent') firstTouchNotices.add(directory);

  const run = async (): Promise<void> => {
    // Yield before doing ANY work. An async function body runs synchronously up to
    // its first await, so without this the tree sizing below would still execute on
    // the read path's stack — the exact thing moving it here was meant to avoid.
    await Promise.resolve();
    try {
      // Size the tree HERE, not on the caller's stack. `repairInBackground` is
      // called from the read path, and a synchronous walk of a cold or
      // network-mounted tree would stall the very tool call this service promises
      // never to block. Bounded either way — it stops counting one past the
      // ceiling.
      let mode: RepairBuildMode = 'full';
      let sizedFiles = 0;
      try {
        sizedFiles = countFiles(directory, ceiling);
        if (sizedFiles > ceiling) mode = 'degraded';
      } catch {
        // Sizing is advisory; an unreadable tree simply takes the ordinary lane.
      }
      const record = inFlight.get(directory);
      if (record) {
        record.mode = mode;
        record.sizedFiles = sizedFiles;
      }
      log(
        `[openlore] Index repair (${reason}) — rebuilding in the background (non-blocking, no API key)…`
        + (mode === 'degraded'
          ? ` Tree exceeds ${ceiling} files: building signatures + keyword index only.`
          : ''),
      );
      await build(directory, { mode });
      // Verify, do not assume. The builder reports some failures (an unwritable
      // directory, EACCES on `.openlore`) by LOGGING and returning normally rather
      // than throwing, so the catch below never fires and this line would claim
      // "Index rebuilt" over the top of the builder's own error — the exact
      // false-success this substrate is supposed to never produce. Ask the
      // filesystem whether an artifact actually exists now.
      if (hasAnalysis(directory)) {
        log('[openlore] Index rebuilt — the next tool call serves fresh results.');
      } else {
        // Deliberately does NOT clear the at-most-once latch. A build that completed
        // without producing an artifact (an unwritable `.openlore`, an empty repo)
        // will fail the same way every time, and retrying it on each tool call is the
        // thrashing the latch exists to prevent. Report honestly and stop.
        log('[openlore] Background index repair completed without producing an index — results stay stale. See the error above.');
      }
      // Guard stays set: a completed repair that still observes its trigger
      // discloses and stops (at-most-once latch), never thrashes.
    } catch (err) {
      // Fail-soft: leave the graceful guidance in place; allow a later retry.
      seen.delete(directory);
      log(`[openlore] Background index repair skipped: ${(err as Error).message}`);
    } finally {
      const record = inFlight.get(directory);
      if (record && firstTouchNotices.has(directory)) {
        firstTouchLanes.set(directory, {
          mode: record.mode,
          sizedFiles: record.sizedFiles,
          ceiling: record.ceiling,
        });
      }
      inFlight.delete(directory);
    }
  };

  return run();
}

/**
 * The one-line notice a repository's FIRST background build is disclosed with.
 *
 * Names what is being built, where it lands, that the call was not blocked, and
 * both opt-outs — the disclosure half of the auto-init consent contract.
 */
function firstTouchNotice(
  directory: string,
  mode: RepairBuildMode,
  sizedFiles: number,
  ceiling: number,
): string {
  const built = mode === 'degraded'
    ? `signatures + the keyword (BM25) index only — this tree is over the ${ceiling}-file ceiling `
      + `(counted ${sizedFiles}+), so the semantic-embedding pass was shed`
    // Names the embedding pass explicitly: it is the one step that can reach
    // outside the repository (a local model in the user-level cache), and the
    // degraded notice only makes sense if the full lane is understood to run it.
    : 'the structural index (call graph, signatures, keyword search) and, if an embedding '
      + 'provider is configured, the semantic index it needs';
  return (
    `First OpenLore touch in ${basename(resolve(directory)) || directory}: building ${built} in the background, `
    + `into ${OPENLORE_ANALYSIS_REL_PATH}. This call was not blocked and was answered from what exists now. `
    + 'Opt out with `"autoInit": false` in .openlore/config.json, or OPENLORE_NO_AUTO_ANALYZE=1.'
  );
}

/**
 * The sentence that discloses an in-flight background repair to a caller.
 *
 * `index-absent` is the one reason with NO stale index behind it — there was
 * nothing to serve from — so it gets its own wording. Every other reason served
 * an existing (stale) index and says so. One helper, so the three response paths
 * that disclose a repair cannot drift apart (change: unify-onboarding-entrypoint).
 */
export function repairDisclosureText(reason: RepairReason): string {
  if (reason === 'index-absent') {
    return 'No index existed for this repository yet; a background build has started and did not block '
      + 'this call. Re-run once it completes for results computed from the full graph.';
  }
  return `Served from a stale index (${REPAIR_REASON_DETAIL[reason]}); a background refresh has started `
    + 'and did not block this call. Re-run for fresh results once it completes.';
}

/**
 * Take this repository's undelivered first-touch notice, if any.
 *
 * Destructive by design: the notice is disclosed on exactly ONE response per repo
 * per process. Returns undefined when the repo has already been disclosed, or when
 * no auto-init ever started for it.
 */
export function takeFirstTouchNotice(directory: string): string | undefined {
  if (!firstTouchNotices.has(directory)) return undefined;
  firstTouchNotices.delete(directory);
  // Rendered at delivery time from whichever record still knows the lane: the
  // in-flight one while the build runs, the retained one once it has finished.
  const lane = inFlight.get(directory) ?? firstTouchLanes.get(directory);
  return firstTouchNotice(
    directory,
    lane?.mode ?? 'full',
    lane?.sizedFiles ?? 0,
    lane?.ceiling ?? AUTO_INIT_DEGRADED_FILE_CEILING,
  );
}

/**
 * The in-progress repair for `directory`, or undefined when none is running. The
 * read path threads this into the response so a stale answer is served with an
 * honest "background refresh started" marker — never presented as fresh.
 */
export function repairStatusFor(
  directory: string,
): { inProgress: true; reason: RepairReason } | undefined {
  const rec = inFlight.get(directory);
  return rec ? { inProgress: true, reason: rec.reason } : undefined;
}

/**
 * Cold-start self-bootstrap for an ABSENT index — the original entry point, kept
 * as a thin wrapper over {@link repairInBackground} so existing callers/tests are
 * unchanged. Only fires when no analysis artifact exists yet.
 */
export function bootstrapAnalysisInBackground(
  directory: string,
  opts: RepairOptions & { analyze: RepairBuilder },
): Promise<void> | null {
  const seen = opts.seen ?? attempted;
  if (opts.disabled || process.env.OPENLORE_NO_AUTO_ANALYZE) return null;
  if (!directory) return null;
  if (seen.has(directory)) return null;
  if (hasAnalysis(directory)) {
    seen.add(directory);
    return null;
  }
  return repairInBackground(directory, 'index-absent', opts);
}

/** Test-only: clear the process-wide repair guards and registered builder. */
export function _resetRepairServiceForTesting(): void {
  attempted.clear();
  inFlight.clear();
  firstTouchNotices.clear();
  firstTouchLanes.clear();
  repairHosts.clear();
  registeredBuilder = null;
  activeBuildChildren.clear();
  childBuildsStopping = false;
}
