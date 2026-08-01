/**
 * Adaptive heap sizing (change: make-analyze-scale-to-any-repo).
 *
 * A large repository's call graph can outgrow Node's default old-space heap, and the only recourse
 * used to be knowing to pass `--max-old-space-size` by hand. This module removes that: at CLI
 * entry, before any heavy work, it sizes the heap to the memory ACTUALLY available to the process
 * (the container/cgroup limit when there is one, else host RAM) by re-executing itself ONCE with
 * the right flag. "It works if you set a Node flag" becomes "it just works."
 *
 * The whole module is designed to be safe and quiet:
 *   - at most once — a marker env var prevents any re-exec loop, whatever the outcome;
 *   - never when the user already chose a heap (`--max-old-space-size`, `NODE_OPTIONS`) or opted
 *     out (`OPENLORE_NO_AUTO_HEAP`);
 *   - transparent to the stdio MCP server — stdio is inherited untouched and the one-line
 *     disclosure goes to STDERR, never stdout (which carries JSON-RPC);
 *   - fail-open — any error in sizing continues at the default heap rather than breaking the CLI.
 *
 * The decision ({@link planHeapReexec}) and the cgroup parsers are pure so they are unit-tested
 * directly; the side-effecting {@link maybeReexecForHeap} is the thin orchestrator the bootstrap
 * calls.
 */

import { getHeapStatistics } from 'node:v8';
import { totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MB = 1024 * 1024;

/**
 * The commands whose heap is worth sizing — the FINITE, graph-building runs: `analyze` and the
 * commands that run it in-process. Everything else (the `orient`/`search` query hot paths an agent
 * drives constantly, `--version`, `doctor`, …) reads bounded data and runs fine at the default heap,
 * so it is NOT re-executed — an extra process spawn on those would be pure latency, exactly the
 * attention this feature removes.
 *
 * The long-lived daemons `mcp` and `serve` are deliberately EXCLUDED. Re-execution here is a
 * blocking `spawnSync` supervisor, which cannot forward a signal to the child while it blocks; a
 * directed `SIGTERM` to the supervisor (how a programmatic MCP host stops a stdio server) would
 * orphan the real server holding the whole graph. A finite batch command's supervisor blocks only
 * for the run and its child dies with the foreground process group, so the hazard is theirs alone.
 * A daemon on a huge repo can still be given a heap the ordinary way (`--max-old-space-size` /
 * `OPENLORE_HEAP_MB`), which this feature honors.
 *
 * An allowlist, not a denylist, on purpose: a command mistakenly omitted merely runs at the default
 * heap (today's behavior — no regression), whereas a hot path mistakenly INCLUDED would pay a second
 * process spawn on every call. The safe failure is "no improvement," never "slower."
 */
export const HEAP_SIZED_COMMANDS: ReadonlySet<string> = new Set([
  'analyze', 'install', 'prove', 'import', 'run',
]);

/**
 * Top-level options that take a VALUE (see `src/cli/index.ts`). In the space-separated form
 * (`--config prod.json`) the value is a non-dash token that must NOT be mistaken for the
 * subcommand — otherwise `openlore --config prod.json analyze` would read `prod.json` as the
 * command and silently skip heap sizing for a config-guarded analyze. The `=`-joined form
 * (`--config=prod.json`) already starts with `-`, so only the space form needs this.
 */
const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--config', '--api-base', '--timeout',
]);

/**
 * The subcommand from a raw argv (`[node, script, ...rest]`): the first token that is neither a
 * flag nor the value of a global value-taking option. `undefined` for a bare `openlore` or a
 * global-flag-only invocation (`openlore --version`).
 */
export function commandFromArgv(argv: readonly string[]): string | undefined {
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith('-')) {
      // A space-separated global value-flag consumes the next token as its value — skip it so the
      // value can never be read as the command.
      if (GLOBAL_VALUE_FLAGS.has(token)) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

/** Opt-out: any non-empty value restores the prior behavior (Node's default or the user's flag). */
export const NO_AUTO_HEAP_ENV = 'OPENLORE_NO_AUTO_HEAP';
/** Explicit target old-space size in MB — skips detection and the fraction math. */
export const HEAP_MB_ENV = 'OPENLORE_HEAP_MB';
/** Override the fraction of the memory budget used for the heap (default {@link DEFAULT_HEAP_FRACTION}). */
export const HEAP_FRACTION_ENV = 'OPENLORE_HEAP_FRACTION';
/** Internal marker set on the re-executed child so it never re-execs again (at-most-once). */
export const HEAP_REEXEC_MARKER_ENV = 'OPENLORE_HEAP_REEXEC';

/**
 * Fraction of the available-memory budget used for the old-space heap. Generous enough that a large
 * repository fits, conservative enough to leave headroom for young-gen, code, native (tree-sitter,
 * SQLite) and external buffers so a hard container limit is not blown (which the kernel answers with
 * SIGKILL, past the reach of the degradation ladder). Overridable with {@link HEAP_FRACTION_ENV}.
 */
export const DEFAULT_HEAP_FRACTION = 0.75;

/** Never target a heap smaller than this — below it re-exec is pointless. */
export const MIN_TARGET_MB = 512;

/**
 * Only re-exec when the target beats the current limit by at least this margin. Stops a pointless
 * re-exec for a trivial gain (Node already auto-sizes the default heap from physical RAM on recent
 * versions, so the gain is often small on a roomy host — exactly where re-exec is not worth it).
 */
export const MIN_GAIN_MB = 512;

/**
 * A cgroup limit at or above this is treated as "unlimited" (absent), not a real cap. cgroup v1
 * reports no-limit as a near-`INT64_MAX` sentinel; cgroup v2 reports the literal string `max`
 * (handled separately). Also guards against a value so large it clearly is not a real memory cap.
 */
const CGROUP_UNLIMITED_FLOOR = 2 ** 53;

// ============================================================================
// CGROUP PARSING (pure — unit-tested directly)
// ============================================================================

/**
 * Parse a cgroup v2 `memory.max` value. It is either a byte count or the literal `max` (no limit).
 * Returns the byte limit, or `undefined` for `max`, an unlimited sentinel, or an unparseable value.
 */
export function parseCgroupV2Max(content: string | null | undefined): number | undefined {
  if (content == null) return undefined;
  const t = content.trim();
  if (t === '' || t === 'max') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n >= CGROUP_UNLIMITED_FLOOR) return undefined;
  return n;
}

/**
 * Parse a cgroup v1 `memory.limit_in_bytes` value — a byte count, or a near-`INT64_MAX` sentinel
 * when there is no limit. Returns the byte limit, or `undefined` when unlimited/unparseable.
 */
export function parseCgroupV1Limit(content: string | null | undefined): number | undefined {
  if (content == null) return undefined;
  const t = content.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n >= CGROUP_UNLIMITED_FLOOR) return undefined;
  return n;
}

/** Read a file synchronously, returning null on any error (absent path, permission, non-Linux). */
function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The `memory.max` file paths to consult for the current cgroup v2 process, from the mount root down
 * to the process's own leaf, derived from `/proc/self/cgroup` (a single `0::<path>` line under v2).
 * Pure so the path logic is unit-tested without a Linux filesystem. Always includes the root; adds
 * each ancestor when the process is in a non-root cgroup. `unified` is the cgroup v2 mount root.
 */
export function cgroupV2MemoryMaxPaths(procCgroupContent: string | null | undefined, unified = '/sys/fs/cgroup'): string[] {
  const paths = [`${unified}/memory.max`];
  const line = procCgroupContent?.split('\n').find(l => l.startsWith('0::'));
  const rel = line ? line.slice('0::'.length).trim() : '';
  if (rel && rel !== '/') {
    let dir = unified;
    for (const seg of rel.split('/').filter(Boolean)) {
      dir += `/${seg}`;
      paths.push(`${dir}/memory.max`);
    }
  }
  return paths;
}

/**
 * The effective cgroup v2 memory limit in bytes, walking the process's cgroup and its ancestors and
 * taking the SMALLEST finite `memory.max`. The effective cap is the tightest limit anywhere up the
 * hierarchy — with nested systemd slices the leaf often reads `max` while a parent slice carries the
 * real cap — and reading only the leaf would miss it and size to host RAM, blowing the parent cap
 * (which the kernel answers with SIGKILL, past the reach of the fail-open ladder). `undefined` when
 * no ancestor sets a real limit. Bounded: the chain is a handful of directories.
 */
function readCgroupV2EffectiveLimitBytes(): number | undefined {
  let best: number | undefined;
  for (const path of cgroupV2MemoryMaxPaths(readFileSafe('/proc/self/cgroup'))) {
    const limit = parseCgroupV2Max(readFileSafe(path));
    if (limit !== undefined) best = best === undefined ? limit : Math.min(best, limit);
  }
  return best;
}

/**
 * The cgroup/container memory limit in bytes, or `undefined` when there is none (non-Linux, no
 * cgroup, or an "unlimited" limit). Reads cgroup v2 (walking the hierarchy for the tightest cap)
 * first, then v1.
 */
export function readCgroupMemoryLimitBytes(): number | undefined {
  const v2 = readCgroupV2EffectiveLimitBytes();
  if (v2 !== undefined) return v2;
  return parseCgroupV1Limit(readFileSafe('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
}

/**
 * The memory budget this process should size to: the cgroup/container limit when present and
 * smaller than host RAM, otherwise host RAM. Never larger than host RAM, so a stale or huge cgroup
 * value can never inflate the budget past the physical machine.
 */
export function detectMemoryBudgetBytes(): number {
  const total = totalmem();
  const cgroup = readCgroupMemoryLimitBytes();
  return cgroup !== undefined ? Math.min(cgroup, total) : total;
}

// ============================================================================
// USER-HEAP DETECTION
// ============================================================================

const MAX_OLD_SPACE_RE = /--max[-_]old[-_]space[-_]size/;

/**
 * True when the user already chose the heap — via a `--max-old-space-size` in the Node exec args or
 * in `NODE_OPTIONS`. Their choice is respected: adaptive sizing then does nothing.
 */
export function userHasSetHeap(execArgv: readonly string[], nodeOptions: string | undefined): boolean {
  if (execArgv.some(a => MAX_OLD_SPACE_RE.test(a))) return true;
  return !!nodeOptions && MAX_OLD_SPACE_RE.test(nodeOptions);
}

// ============================================================================
// THE DECISION (pure — unit-tested directly)
// ============================================================================

export interface HeapPlanInputs {
  /** Available-memory budget in bytes (cgroup limit or host RAM). */
  budgetBytes: number;
  /** The heap old-space limit in bytes this process currently has. */
  currentHeapLimitBytes: number;
  /** The user already chose a heap (`--max-old-space-size` / `NODE_OPTIONS`). */
  userSetHeap: boolean;
  /** The opt-out is set. */
  optOut: boolean;
  /** This process is itself a re-exec (the marker is set) — so it must NOT re-exec again. */
  alreadyReexeced: boolean;
  /** Explicit target old-space MB (from {@link HEAP_MB_ENV}), or undefined. */
  explicitTargetMb: number | undefined;
  /** Fraction of the budget to use (from {@link HEAP_FRACTION_ENV}), or undefined for the default. */
  fraction: number | undefined;
}

export interface HeapPlan {
  action: 'reexec' | 'skip';
  /** The old-space MB to re-exec with. Present only when `action === 'reexec'`. */
  targetMb?: number;
  /** One-line human explanation, for the disclosure line or a `--verbose` skip trace. */
  reason: string;
}

/**
 * Decide whether to re-exec with a larger heap, and to what size. Pure and total: every path
 * returns a plan with a reason, and the ordering guarantees at-most-once (the marker is checked
 * FIRST, so a re-executed process can never re-exec again regardless of any other input).
 */
export function planHeapReexec(inputs: HeapPlanInputs): HeapPlan {
  // At-most-once, unconditionally: a re-executed process never re-execs, whatever else is true.
  if (inputs.alreadyReexeced) return { action: 'skip', reason: 'already re-executed (marker set)' };
  if (inputs.optOut) return { action: 'skip', reason: `adaptive heap sizing disabled (${NO_AUTO_HEAP_ENV})` };
  // The user's explicit Node-level heap choice wins over everything below it.
  if (inputs.userSetHeap) {
    return { action: 'skip', reason: 'user set the heap (--max-old-space-size / NODE_OPTIONS)' };
  }

  const currentMb = Math.round(inputs.currentHeapLimitBytes / MB);

  // Explicit target: an operator asked for exactly this heap via OPENLORE_HEAP_MB.
  if (inputs.explicitTargetMb !== undefined) {
    const targetMb = Math.max(MIN_TARGET_MB, Math.floor(inputs.explicitTargetMb));
    if (targetMb > currentMb) {
      return { action: 'reexec', targetMb, reason: `explicit ${HEAP_MB_ENV}=${inputs.explicitTargetMb}` };
    }
    return { action: 'skip', reason: `${HEAP_MB_ENV} (${targetMb} MB) not larger than the current heap (${currentMb} MB)` };
  }

  // Auto: a fraction of the available-memory budget.
  const fraction = normalizeFraction(inputs.fraction);
  if (!Number.isFinite(inputs.budgetBytes) || inputs.budgetBytes <= 0) {
    return { action: 'skip', reason: 'memory budget unknown' };
  }
  const targetMb = Math.max(MIN_TARGET_MB, Math.floor((inputs.budgetBytes * fraction) / MB));
  if (targetMb >= currentMb + MIN_GAIN_MB) {
    return {
      action: 'reexec',
      targetMb,
      reason: `${Math.round(fraction * 100)}% of a ${Math.round(inputs.budgetBytes / MB)} MB budget`,
    };
  }
  return { action: 'skip', reason: `current heap (${currentMb} MB) already adequate for a ${Math.round(inputs.budgetBytes / MB)} MB budget` };
}

/** Clamp the fraction to a sane (0, 0.95] range; fall back to the default for a bad value. */
function normalizeFraction(fraction: number | undefined): number {
  if (fraction === undefined || !Number.isFinite(fraction) || fraction <= 0) return DEFAULT_HEAP_FRACTION;
  return Math.min(fraction, 0.95);
}

// ============================================================================
// ORCHESTRATOR (side-effecting — the bootstrap calls this)
// ============================================================================

function readPositiveNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Gather the live inputs for the decision from the current process/environment. */
export function gatherHeapPlanInputs(): HeapPlanInputs {
  return {
    budgetBytes: detectMemoryBudgetBytes(),
    currentHeapLimitBytes: getHeapStatistics().heap_size_limit,
    userSetHeap: userHasSetHeap(process.execArgv, process.env.NODE_OPTIONS),
    optOut: !!process.env[NO_AUTO_HEAP_ENV] && process.env[NO_AUTO_HEAP_ENV] !== '',
    alreadyReexeced: process.env[HEAP_REEXEC_MARKER_ENV] === '1',
    explicitTargetMb: readPositiveNumberEnv(HEAP_MB_ENV),
    fraction: readPositiveNumberEnv(HEAP_FRACTION_ENV),
  };
}

/**
 * Size the heap by re-executing once when the plan calls for it, then exit with the child's status.
 * When no re-exec is warranted (the common case) this returns immediately and the CLI runs normally.
 * Fail-open: any surprise leaves the process running at its current heap rather than aborting.
 */
export function maybeReexecForHeap(): void {
  // Only the graph-building / graph-holding commands are sized; the query hot paths run at the
  // default heap so they pay no extra process spawn (see HEAP_SIZED_COMMANDS). Checked before any
  // detection so a light command does no work here at all.
  if (!HEAP_SIZED_COMMANDS.has(commandFromArgv(process.argv) ?? '')) return;

  let plan: HeapPlan;
  try {
    plan = planHeapReexec(gatherHeapPlanInputs());
  } catch {
    return; // never let heap sizing break the CLI
  }
  if (plan.action !== 'reexec' || plan.targetMb === undefined) return;

  try {
    // Strip any stale heap flag from the exec args, then add ours. (There should be none — a
    // user-set heap would have skipped above — but stripping keeps the child's flag authoritative.)
    const execArgv = process.execArgv.filter(a => !MAX_OLD_SPACE_RE.test(a));
    const childArgs = [...execArgv, `--max-old-space-size=${plan.targetMb}`, ...process.argv.slice(1)];

    // Disclosure: ONE line, on STDERR (stdout carries the MCP JSON-RPC stream and must stay clean).
    process.stderr.write(
      `[openlore] heap sized to ${plan.targetMb} MB (${plan.reason}); ` +
      `set ${NO_AUTO_HEAP_ENV}=1 to disable.\n`,
    );

    const result = spawnSync(process.execPath, childArgs, {
      stdio: 'inherit',
      env: { ...process.env, [HEAP_REEXEC_MARKER_ENV]: '1' },
    });

    if (result.error) {
      // The re-exec could not be spawned — continue in THIS process at the default heap rather than
      // failing. The user loses the larger heap, not the command.
      process.stderr.write(
        `[openlore] heap re-exec failed (${result.error.message}); continuing at the default heap.\n`,
      );
      return;
    }
    // Propagate a signal death faithfully; otherwise exit with the child's status.
    if (result.signal) {
      // Re-raise so the parent dies the same way the child did, then exit as a guaranteed
      // terminator: signal delivery is not synchronous, and control must NEVER return to index.ts
      // (which would load commander and run the command a second time at the default heap).
      process.kill(process.pid, result.signal);
      process.exit(1);
    }
    process.exit(result.status ?? 0);
  } catch (err) {
    // Any unexpected failure (e.g. process.exit stubbed in a test) must not crash the CLI.
    if (process.env.DEBUG) {
      process.stderr.write(`[openlore] heap sizing skipped: ${(err as Error).message}\n`);
    }
  }
}
