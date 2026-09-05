/**
 * Gryph bridge — runtime behavioral observability provider.
 *
 * Promotes Gryph from optional score enrichment to first-class behavioral source.
 * Runs a background poll loop that updates panic state independently of MCP tool
 * calls, closing the blind spot where agents work purely via Bash/Edit/Read.
 *
 * Architecture:
 *   RuntimeBehaviorProvider (interface)
 *     └── GryphBehaviorProvider (impl: gryph query CLI)
 *         └── startGryphPolling (background loop → panic state)
 *
 * All failures degrade to zero-impact null semantics:
 * - gryph binary absent → null
 * - timeout → null
 * - malformed output → null
 * - any exception → null
 *
 * The poll loop MUST NOT block MCP execution, delay tool responses, or overlap.
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { emit } from '../telemetry.js';
import { readPanicState, casWritePanicState, applyPanicHysteresis, LOCK_ATTEMPTS_DAEMON } from './panic-response.js';
import type { PanicState, PanicLevel } from './panic-response.js';
import type { EpistemicTracker } from './epistemic-lease.js';
import {
  PANIC_SCORE_MAX,
  GRYPH_RETRY_BURST_DELTA,
  GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA,
  GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA,
  GRYPH_LARGE_PATCH_LOC_THRESHOLD,
  GRYPH_ENTROPY_LOW_THRESHOLD,
  GRYPH_ENTROPY_HIGH_THRESHOLD,
  GRYPH_FAILING_RATE_THRESHOLD,
  PANIC_DECAY_PER_MIN,
  GRYPH_POLL_INTERVAL_MS,
  GRYPH_POLL_INTERVAL_MIN_MS,
} from './panic-constants.js';

// ============================================================================
// TYPES
// ============================================================================

/** Behavioral snapshot from a runtime observability source. */
export interface RuntimeBehaviorSnapshot {
  timestamp: number;
  commandEntropy?: number;
  repetitiveRetryBurst?: boolean;
  failingCommandRate?: number;
  largePatchWhileStale?: { loc: number; entropy: number };
  commandCount?: number;
  shellActivity?: boolean;
}

/** Abstraction for runtime behavioral data sources. */
export interface RuntimeBehaviorProvider {
  collect(since: string): Promise<RuntimeBehaviorSnapshot | null>;
}

/** Kept for backward compat with panic-check.ts enrichment path. */
export interface GryphSignals {
  commandEntropy: number;
  repetitiveRetryBurst: boolean;
  largePatchWhileStale: boolean;
  largePatchLoc: number;
}

interface GryphExecEvent {
  // PascalCase — actual Gryph schema
  Command?: string;
  ExitCode?: number;
  ResultStatus?: string;
  Timestamp?: string;
  // snake_case / camelCase — kept for custom/future sources
  command?: string;
  cmd?: string;
  exit_code?: number;
  exitCode?: number;
  result_status?: string;
}

interface GryphWriteEvent {
  // PascalCase — actual Gryph schema
  Path?: string;
  LinesAdded?: number;
  LinesRemoved?: number;
  Timestamp?: string;
  // snake_case / camelCase — kept for custom/future sources
  path?: string;
  file?: string;
  lines?: number;
  loc?: number;
  additions?: number;
}

interface SnapshotDeltaResult {
  newScore: number;
  newLevel: PanicLevel;
  provenance: Array<{ name: string; delta: number; evidence: Record<string, unknown> }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Parse an env override to a finite int >= min; a non-numeric/blank value falls back to `def`
 *  (NOT NaN — `Math.max(min, Number("abc"))` is NaN, which crashes downstream date/timer math). */
function envInt(name: string, def: number, min: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? def : Number(raw);
  return Math.max(min, Number.isFinite(n) ? n : def);
}

const GRYPH_TIMEOUT_MS        = envInt('OPENLORE_GRYPH_TIMEOUT_MS', 150, 50);
const GRYPH_DETECT_TIMEOUT_MS = 50;

// ============================================================================
// ENTROPY COMPUTATION
// ============================================================================

function computeCommandEntropy(commands: string[]): number {
  if (commands.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const cmd of commands) {
    const key = cmd.trim().split(/\s+/)[0] ?? cmd;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const n = commands.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.max(counts.size, 1));
  return maxEntropy > 0 ? Math.min(1, entropy / maxEntropy) : 1;
}

// ============================================================================
// GRYPH DETECTION
// ============================================================================

let _gryphAvailable: boolean | undefined;
let _gryphBin = 'gryph';

/** Reset availability cache — for testing only. */
export function _resetGryphAvailabilityForTesting(available = false): void {
  _gryphAvailable = available;
  _gryphBin = 'gryph';
}

function isGryphAvailable(): boolean {
  if (_gryphAvailable !== undefined) return _gryphAvailable;
  // Try PATH-resolution first (fast, works in interactive shells)
  const result = spawnSync('which', ['gryph'], {
    timeout: GRYPH_DETECT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const fromPath = result.status === 0 ? result.stdout?.toString().trim() : '';
  if (fromPath) {
    _gryphBin = fromPath;
    _gryphAvailable = true;
    return true;
  }
  // Fallback: check common install locations (hook environments often have restricted PATH)
  const home = process.env['HOME'] ?? '';
  const candidates = [
    `${home}/.local/bin/gryph`,
    `${home}/go/bin/gryph`,
    '/usr/local/bin/gryph',
    '/opt/homebrew/bin/gryph',
  ];
  for (const p of candidates) {
    if (existsSync(p)) { _gryphBin = p; _gryphAvailable = true; return true; }
  }
  _gryphAvailable = false;
  return false;
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/** Kill the entire process group of a spawned gryph child (reaps any grandchildren it forked).
 *  Falls back to a direct child kill if the group kill isn't available. Never throws. */
function killGryphGroup(pid: number | undefined, child?: { kill: (s?: NodeJS.Signals) => boolean }): void {
  if (typeof pid === 'number' && pid > 0) {
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* group gone / unsupported → fall through */ }
  }
  try { child?.kill('SIGKILL'); } catch { /* ignore */ }
}

/** Synchronous query — used by the backward-compat panic-check enrichment path.
 *  spawnSync's timeout signals the direct child (the real `gryph` is a single binary, so no
 *  grandchildren to orphan). The continuously-running daemon path uses the group-killing async
 *  query below, which is where orphan accumulation would otherwise matter. */
function queryGryphSync(action: 'exec' | 'write', since: string): unknown[] {
  const result = spawnSync(
    _gryphBin,
    ['query', '--format', 'json', '--action', action, '--since', since],
    { timeout: GRYPH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
  );
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Async query — used by GryphBehaviorProvider polling path (non-blocking). */
async function queryGryphAsync(action: 'exec' | 'write', since: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const child = spawn(
      _gryphBin,
      ['query', '--format', 'json', '--action', action, '--since', since],
      // own group → reap grandchildren on timeout; windowsHide — detached alone surfaces
      // a console window on Windows, and this path polls, so it would flash repeatedly.
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true },
    );
    const timer = setTimeout(() => { killGryphGroup(child.pid, child); resolve([]); }, GRYPH_TIMEOUT_MS);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !output) { resolve([]); return; }
      try {
        const parsed = JSON.parse(output.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

// ============================================================================
// SNAPSHOT DELTA — applies RuntimeBehaviorSnapshot to a panic state
// ============================================================================

function applySnapshotDelta(
  snapshot: RuntimeBehaviorSnapshot,
  state: PanicState,
  staleDepth: number,
): SnapshotDeltaResult {
  const now = Date.now();
  const elapsedMin = state.updatedAt
    ? Math.max(0, (now - new Date(state.updatedAt).getTime()) / 60_000)
    : 0;
  const decayDelta = -Math.floor(elapsedMin * PANIC_DECAY_PER_MIN);

  let delta = decayDelta;
  const provenance: SnapshotDeltaResult['provenance'] = [];
  if (decayDelta < 0) {
    provenance.push({ name: 'passive_decay', delta: decayDelta, evidence: { elapsed_min: Math.round(elapsedMin * 100) / 100 } });
  }

  const isStale = staleDepth >= 2;

  if (snapshot.repetitiveRetryBurst) {
    delta += GRYPH_RETRY_BURST_DELTA;
    provenance.push({
      name: 'gryph_retry_burst',
      delta: GRYPH_RETRY_BURST_DELTA,
      evidence: { source: 'gryph', entropy: snapshot.commandEntropy ?? null },
    });
  }

  if (snapshot.largePatchWhileStale && isStale) {
    const { loc, entropy } = snapshot.largePatchWhileStale;
    const attenuated = entropy > GRYPH_ENTROPY_HIGH_THRESHOLD;
    const d = attenuated ? GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA : GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA;
    delta += d;
    provenance.push({
      name: 'large_patch_while_stale',
      delta: d,
      evidence: { source: 'gryph', loc, entropy },
    });
  }

  if (delta === 0 || (delta === decayDelta && state.panicScore === 0)) {
    return { newScore: state.panicScore, newLevel: state.panicLevel, provenance: [] };
  }

  const newScore = Math.min(PANIC_SCORE_MAX, Math.max(0, state.panicScore + delta));
  const newLevel = applyPanicHysteresis(state.panicLevel, newScore, staleDepth);
  return { newScore, newLevel, provenance };
}

// ============================================================================
// GryphBehaviorProvider — RuntimeBehaviorProvider implementation
// ============================================================================

export class GryphBehaviorProvider implements RuntimeBehaviorProvider {
  async collect(since: string): Promise<RuntimeBehaviorSnapshot | null> {
    try {
      if (!isGryphAvailable()) return null;

      const [execEvents, writeEvents] = await Promise.all([
        queryGryphAsync('exec', since) as Promise<GryphExecEvent[]>,
        queryGryphAsync('write', since) as Promise<GryphWriteEvent[]>,
      ]);

      const commands = (execEvents as GryphExecEvent[])
        .map(e => e.Command ?? e.command ?? e.cmd ?? '')
        .filter(Boolean);
      const commandEntropy = computeCommandEntropy(commands);

      const failingCount = (execEvents as GryphExecEvent[])
        .filter(e => {
          const status = e.ResultStatus ?? e.result_status;
          return status === 'error' || (e.ExitCode ?? e.exit_code ?? e.exitCode ?? 0) !== 0;
        }).length;
      const failingCommandRate = execEvents.length > 0 ? failingCount / execEvents.length : 0;
      // Low entropy + any failure (pure retry loop) OR high failure rate regardless of entropy
      const repetitiveRetryBurst =
        (commandEntropy < GRYPH_ENTROPY_LOW_THRESHOLD && failingCount > 0) ||
        failingCommandRate > GRYPH_FAILING_RATE_THRESHOLD;

      const locs = (writeEvents as GryphWriteEvent[]).map(
        e => e.LinesAdded ?? e.lines ?? e.loc ?? e.additions ?? 0,
      );
      const maxLoc = locs.length > 0 ? Math.max(...locs) : 0;

      return {
        timestamp: Date.now(),
        commandEntropy,
        repetitiveRetryBurst,
        failingCommandRate,
        largePatchWhileStale: maxLoc > GRYPH_LARGE_PATCH_LOC_THRESHOLD
          ? { loc: maxLoc, entropy: commandEntropy }
          : undefined,
        commandCount: commands.length,
        shellActivity: execEvents.length > 0,
      };
    } catch {
      return null;
    }
  }
}

// ============================================================================
// POLLING LIFECYCLE
// ============================================================================

export interface GryphPollingOptions {
  directory: string;
  /** Returns current stale depth from in-memory tracker. */
  getTracker: () => EpistemicTracker | null;
  /** Optional provider override (for testing). */
  provider?: RuntimeBehaviorProvider;
}

/** One active poller per workspace directory — enforced by startGryphPolling. */
const _pollerRegistry = new Map<string, () => void>();

/**
 * Start background Gryph polling. Returns a cleanup function (call on shutdown).
 *
 * Invariants:
 * - One per workspace: registry stops any existing poller for the same directory
 * - Never overlaps: single-flight protection skips polls while previous is running
 * - Never blocks: async spawn, isolated from MCP execution path
 * - Never throws: all errors caught, fail-open
 * - CAS writes: uses compare-and-swap to prevent overwriting concurrent MCP writes
 * - Syncs tracker: panicScore/panicLevel/panicRevision updated in-memory after write
 *   so the MCP path doesn't overwrite Gryph-elevated state on the next tool call
 */
export function startGryphPolling(opts: GryphPollingOptions): () => void {
  const { directory, getTracker, provider = new GryphBehaviorProvider() } = opts;

  // Enforce one-per-workspace: stop any existing poller for this directory
  _pollerRegistry.get(directory)?.();

  const intervalMs = envInt('OPENLORE_GRYPH_POLL_INTERVAL_MS', GRYPH_POLL_INTERVAL_MS, GRYPH_POLL_INTERVAL_MIN_MS);

  let isPolling = false;
  let lastPollAt = new Date(Date.now() - intervalMs).toISOString();
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (isPolling) return;
    isPolling = true;
    try {
      const since = lastPollAt;
      lastPollAt = new Date().toISOString();

      const snapshot = await provider.collect(since);

      emit(directory, 'panic', {
        event: 'gryph_poll',
        success: snapshot !== null,
        shell_activity: snapshot?.shellActivity ?? false,
      });

      if (!snapshot) return;

      // No actionable signals — skip state update
      if (!snapshot.repetitiveRetryBurst && !snapshot.largePatchWhileStale) return;

      const tracker = getTracker();
      const staleDepth = tracker?.staleDepth ?? 0;

      // CAS write with one retry on conflict (MCP may write between our read and write).
      // All ops inside casWritePanicState are synchronous — atomic within the Node.js event loop.
      let readState = readPanicState(directory);
      let applyResult = applySnapshotDelta(snapshot, readState, staleDepth);
      if (applyResult.newScore === readState.panicScore && applyResult.newLevel === readState.panicLevel) return;

      for (let attempt = 0; attempt < 2; attempt++) {
        const candidate: PanicState = {
          ...readState,
          panicScore: applyResult.newScore,
          panicLevel: applyResult.newLevel,
          updatedAt: new Date().toISOString(),
          triggers: [...(readState.triggers ?? []), ...applyResult.provenance.map(p => p.name)],
        };
        // Short lock budget on the daemon path: a contended write is skipped and retried next poll
        // rather than blocking this background event loop.
        if (casWritePanicState(directory, readState.revision, candidate, LOCK_ATTEMPTS_DAEMON)) {
          const writtenRevision = readState.revision + 1;
          // Sync in-memory tracker so MCP path doesn't overwrite with stale state
          if (tracker) {
            tracker.panicScore = applyResult.newScore;
            tracker.panicLevel = applyResult.newLevel as PanicLevel;
            tracker.panicRevision = writtenRevision;
          }
          emit(directory, 'panic', {
            event: 'panic_score_delta',
            source: 'gryph',
            delta: applyResult.newScore - readState.panicScore,
            from_score: readState.panicScore,
            to_score: applyResult.newScore,
            from_level: readState.panicLevel,
            to_level: applyResult.newLevel,
            provenance: applyResult.provenance,
          });
          return;
        }
        // Conflict on first attempt — re-read and retry once
        if (attempt === 0) {
          readState = readPanicState(directory);
          applyResult = applySnapshotDelta(snapshot, readState, staleDepth);
          if (applyResult.newScore === readState.panicScore && applyResult.newLevel === readState.panicLevel) return;
        }
      }
      // Both CAS attempts failed — skip this poll cycle, try again next interval
    } catch {
      // fail-open: no error propagates
    } finally {
      isPolling = false;
    }
  };

  // While loop: sleep-before-poll preserves "first poll after one interval" semantics.
  // Sequential await eliminates setInterval's timer drift and stop lifecycle races.
  const run = async (): Promise<void> => {
    while (!stopped) {
      await new Promise<void>(r => setTimeout(r, intervalMs));
      if (!stopped) await poll();
    }
  };
  void run();

  const stop = (): void => {
    stopped = true;
    _pollerRegistry.delete(directory);
  };
  _pollerRegistry.set(directory, stop);
  return stop;
}

// ============================================================================
// BACKWARD COMPAT — panic-check.ts enrichment path (sync, pre-existing)
// ============================================================================

/**
 * Synchronous Gryph query for the panic-check hook enrichment path.
 * Returns null when Gryph is absent or any error occurs.
 */
export function queryGryphSignals(since: string): GryphSignals | null {
  try {
    if (!isGryphAvailable()) return null;

    const execEvents = queryGryphSync('exec', since) as GryphExecEvent[];
    const writeEvents = queryGryphSync('write', since) as GryphWriteEvent[];

    const commands = execEvents.map(e => e.Command ?? e.command ?? e.cmd ?? '').filter(Boolean);
    const commandEntropy = computeCommandEntropy(commands);
    const hasFailures = execEvents.some(e => {
      const status = e.ResultStatus ?? e.result_status;
      return status === 'error' || (e.ExitCode ?? e.exit_code ?? e.exitCode ?? 0) !== 0;
    });
    const repetitiveRetryBurst = commandEntropy < GRYPH_ENTROPY_LOW_THRESHOLD && hasFailures;

    const locs = writeEvents.map(e => e.LinesAdded ?? e.lines ?? e.loc ?? e.additions ?? 0);
    const largePatchLoc = locs.length > 0 ? Math.max(...locs) : 0;
    const largePatchWhileStale = largePatchLoc > GRYPH_LARGE_PATCH_LOC_THRESHOLD;

    return { commandEntropy, repetitiveRetryBurst, largePatchWhileStale, largePatchLoc };
  } catch {
    return null;
  }
}

/**
 * Apply Gryph-derived score deltas (backward compat — panic-check enrichment).
 */
export function applyGryphDelta(
  baseScore: number,
  signals: GryphSignals,
  isStale: boolean,
  triggers: string[],
): number {
  let delta = 0;

  if (signals.repetitiveRetryBurst) {
    delta += GRYPH_RETRY_BURST_DELTA;
    triggers.push('repetitive_retry_burst');
  }

  if (signals.largePatchWhileStale && isStale) {
    const attenuated = signals.commandEntropy > GRYPH_ENTROPY_HIGH_THRESHOLD;
    delta += attenuated ? GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA : GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA;
    triggers.push(attenuated ? 'large_patch_attenuated' : 'large_patch_stale');
  }

  return Math.min(PANIC_SCORE_MAX, Math.max(0, baseScore + delta));
}
