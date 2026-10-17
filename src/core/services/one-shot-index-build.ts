/**
 * Background index build for one-shot hosts (change: bootstrap-index-from-one-shot-orient).
 *
 * The MCP server heals an absent or stale index itself because it outlives the build. A
 * one-shot `openlore orient` — the command install wires as agent hooks, and the first
 * thing that runs in a fresh git worktree — exits in milliseconds, so it hands the build
 * to a detached supervisor process and returns at once.
 *
 * Two guards keep that from multiplying. Full-analysis ownership already allows one
 * analysis per repository across processes; the attempt stamp names the live supervisor
 * and stops a build that cannot succeed from being restarted on every prompt.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { AUTO_INIT_DEGRADED_FILE_CEILING, OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { OWNERSHIP_LOCK_FILE } from '../runtime/advisory-lock.js';
import { isOwnershipStale, isProcessAlive, runtimeDirOf } from '../runtime/analysis-ownership.js';
import {
  autoInitSuppression,
  buildIndexInChildProcess,
  countFilesBounded,
  registerRepairBuilder,
  registerRepairHost,
  repairDisclosureText,
  type ChildProcessBuildOptions,
  type RepairReason,
} from './cold-start-bootstrap.js';
import { childEnvWithoutScopedTlsRelaxation } from './tls-scope.js';

/** A finished attempt is not repeated inside this window, whatever its outcome. */
export const ONE_SHOT_BUILD_COOLDOWN_MS = 2 * 60_000;

const ATTEMPT_STAMP_FILE = 'auto-build-attempt';
/**
 * Held only while an EXPIRED stamp is replaced, so two racing hooks cannot both delete
 * and re-create it. A claim older than this is a crashed claimant and is broken.
 */
const STAMP_CLAIM_STALE_MS = 10_000;

/** Exclusive claim on replacing an expired stamp, or false when a peer holds it. */
function claimStampReplacement(claimPath: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(claimPath, 'wx'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const claim = readState(claimPath);
      if (claim && now - claim.mtimeMs < STAMP_CLAIM_STALE_MS) return false;
      try { unlinkSync(claimPath); } catch { /* a peer broke it first */ }
    }
  }
  return false;
}
/** Both files hold one short line; a fixed prefix bounds the read whatever is there. */
const MAX_STATE_BYTES = 64 * 1024;

export type OneShotBuild =
  | { state: 'started' | 'running' | 'recently-attempted' | 'unavailable' }
  | { state: 'suppressed'; detail: string };

export interface OneShotBuildOptions {
  /** Test seam; production uses the current OpenLore CLI entry point. */
  cliPath?: string;
  /** Test seam for observing the child-process boundary. */
  spawnProcess?: typeof spawn;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/** Read a small runtime state file through one descriptor, or undefined when absent. */
function readState(path: string): { mtimeMs: number; contents: string } | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_STATE_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return { mtimeMs: info.mtimeMs, contents: buffer.subarray(0, bytes).toString('utf8') };
  } catch {
    return undefined;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Start one detached index build for `directory`, unless one is running, one ran inside
 * the cooldown, or auto-init is off. Synchronous and fail-soft: it never waits for the
 * build and never throws, so a hook that calls it cannot hold or break the user's turn.
 */
export function startDetachedIndexBuild(
  directory: string,
  reason: RepairReason,
  opts: OneShotBuildOptions = {},
): OneShotBuild {
  const suppression = autoInitSuppression(directory);
  // Git work trees only for a FIRST build; a stale index is one the user already chose
  // to build (the same rule `repairInBackground` applies).
  if (suppression && (reason === 'index-absent' || suppression.reason !== 'not-a-git-work-tree')) {
    return { state: 'suppressed', detail: suppression.detail };
  }

  const runtimeDir = runtimeDirOf(join(directory, OPENLORE_ANALYSIS_REL_PATH));
  const owner = readState(join(runtimeDir, OWNERSHIP_LOCK_FILE));
  if (owner && !isOwnershipStale(owner.mtimeMs, owner.contents, directory)) return { state: 'running' };

  const stampPath = join(runtimeDir, ATTEMPT_STAMP_FILE);
  const stamp = readState(stampPath);
  if (stamp) {
    const pid = Number.parseInt(stamp.contents, 10);
    const fresh = (opts.now ?? Date.now)() - stamp.mtimeMs < ONE_SHOT_BUILD_COOLDOWN_MS;
    // An empty fresh stamp is a peer between claiming it and recording its supervisor.
    if (Number.isNaN(pid) ? fresh : isProcessAlive(pid)) return { state: 'running' };
    if (fresh) return { state: 'recently-attempted' };
  }

  const cliPath = opts.cliPath ?? process.argv[1];
  if (!cliPath) return { state: 'unavailable' };
  const claimPath = `${stampPath}.claim`;
  let claimed = false;
  try {
    mkdirSync(runtimeDir, { recursive: true });
    if (stamp) {
      // Replace the expired stamp under a claim: without it, a peer that read the same
      // expired stamp could delete the fresh one this call creates, and both would spawn.
      if (!claimStampReplacement(claimPath, (opts.now ?? Date.now)())) return { state: 'running' };
      claimed = true;
      const current = readState(stampPath);
      if (current && current.mtimeMs !== stamp.mtimeMs) return { state: 'running' };
      if (current) unlinkSync(stampPath);
    }
    // Exclusive create: of several hook calls racing here, one claims the attempt.
    closeSync(openSync(stampPath, 'wx'));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'running' : 'unavailable' };
  } finally {
    if (claimed) {
      try { unlinkSync(claimPath); } catch { /* already gone */ }
    }
  }
  try {
    const child = (opts.spawnProcess ?? spawn)(
      process.execPath,
      [
        cliPath, 'orient', '--background-build',
        ...(reason === 'index-absent' ? [] : ['--background-repair']),
        '--directory', directory,
      ],
      {
        cwd: directory,
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
        env: childEnvWithoutScopedTlsRelaxation(),
      },
    );
    child.once('error', () => { /* fail-soft: the stamp's cooldown bounds the retry */ });
    child.unref();
    if (child.pid !== undefined) writeFileSync(stampPath, `${child.pid}\n`);
    return { state: 'started' };
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * The supervisor's whole job: run init (when needed) and analyze as child processes and
 * stay alive until they finish, so the attempt stamp's PID means "a build is running".
 */
export async function runBackgroundIndexBuild(
  directory: string,
  opts: {
    repair?: boolean;
    build?: (directory: string, opts: ChildProcessBuildOptions) => Promise<void>;
  } = {},
): Promise<void> {
  // The build children are unref'd; without a live handle this process would exit first.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    let mode: ChildProcessBuildOptions['mode'] = 'full';
    try {
      if (countFilesBounded(directory, AUTO_INIT_DEGRADED_FILE_CEILING) > AUTO_INIT_DEGRADED_FILE_CEILING) {
        mode = 'degraded';
      }
    } catch {
      // Sizing is advisory; an unreadable tree takes the ordinary lane.
    }
    await (opts.build ?? buildIndexInChildProcess)(directory, { repair: opts.repair, mode });
  } catch {
    // Fail-soft: a later one-shot call, past the cooldown, tries again.
  } finally {
    clearInterval(keepAlive);
    // The cooldown counts from the END of the attempt. Counted from the spawn, a build
    // that runs past the cooldown and fails would be restarted on the very next prompt.
    const stampPath = join(runtimeDirOf(join(directory, OPENLORE_ANALYSIS_REL_PATH)), ATTEMPT_STAMP_FILE);
    try {
      const at = new Date();
      utimesSync(stampPath, at, at);
    } catch {
      // No stamp (the build was started another way): nothing to refresh.
    }
  }
}

/**
 * Route the read path's staleness signals to the detached build for this one-shot
 * process. A request counts as accepted only when a build is really in flight, so the
 * "repair scheduled" and "refresh started" disclosures stay true.
 */
export function registerOneShotRepair(directory: string, opts: OneShotBuildOptions = {}): void {
  const inFlight = (dir: string): boolean => {
    const { state } = startDetachedIndexBuild(dir, 'stale-region', opts);
    return state === 'started' || state === 'running';
  };
  registerRepairHost(directory, () => inFlight(directory));
  registerRepairBuilder(async (dir) => {
    if (!inFlight(dir)) throw new Error('no background build was started');
    // The build outlives this process, so its outcome is never observed here.
    await new Promise<void>(() => {});
  });
}

/** What a one-shot caller is told about the build, or undefined when there is nothing to add. */
export function oneShotBuildNote(build: OneShotBuild): string | undefined {
  switch (build.state) {
    case 'started':
      return `${repairDisclosureText('index-absent')} It writes to ${OPENLORE_ANALYSIS_REL_PATH}. `
        + 'Opt out with `"autoInit": false` in .openlore/config.json, or OPENLORE_NO_AUTO_ANALYZE=1.';
    case 'running':
      return 'No index exists for this repository yet; a build is already running and did not block this call. '
        + 'Re-run once it completes.';
    case 'suppressed':
      return `Background auto-init is off for this directory (${build.detail}), so no index is being built. `
        + 'Run `openlore analyze` to build one.';
    case 'recently-attempted':
      return 'A background build ran in the last few minutes and produced no index. '
        + 'Run `openlore analyze` to see why.';
    default:
      return undefined;
  }
}
