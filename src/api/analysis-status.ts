/**
 * `openloreAnalysisStatus` — ask the lock instead of tripping over it
 * (change: extend-api-for-supervising-hosts).
 *
 * `AnalysisInProgressError` already carries the owner, the elapsed time and the heartbeat age, so
 * the facts exist — they were just only reachable by STARTING an analysis that then fails. A host
 * that wants to report "reconciling, owned by another process, healthy heartbeat" should not have
 * to provoke an error to learn it, least of all when the honest response is to not start a
 * competing analysis at all.
 *
 * This is `readAnalysisOwner` published, with its semantics intact: it never acquires, steals or
 * waits, and a stale lock left by a crashed holder reports NOT in progress — which is exactly the
 * distinction a host needs to decide whether starting one would be a duplicate.
 */
import { realpath } from 'node:fs/promises';
import { OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { readAnalysisOwner, type AnalysisOwnerPayload } from '../core/runtime/analysis-ownership.js';
import { withLoggerOptions } from '../utils/logger.js';
import { safeJoin } from '../utils/path-confinement.js';
import type { BaseOptions } from './types.js';

export interface AnalysisStatusResult {
  inProgress: boolean;
  /** The recorded owner, when one is live. Absent on a stale or missing lock. */
  owner?: AnalysisOwnerPayload;
  /** Milliseconds since the owning analysis started. */
  elapsedMs?: number;
  /** Milliseconds since the owner last refreshed its heartbeat. */
  heartbeatAgeMs?: number;
}

async function openloreAnalysisStatusImpl(options: BaseOptions): Promise<AnalysisStatusResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(options.rootPath ?? process.cwd()).catch(() => null);
  if (root === null) return { inProgress: false };

  const analysisDir = safeJoin(root, `${OPENLORE_ANALYSIS_REL_PATH}/`);
  const held = await readAnalysisOwner(root, analysisDir);
  if (held === null) return { inProgress: false };

  return {
    inProgress: true,
    ...(held.owner !== null ? { owner: held.owner } : {}),
    ...(held.elapsedMs !== null ? { elapsedMs: held.elapsedMs } : {}),
    heartbeatAgeMs: held.heartbeatAgeMs,
  };
}

/**
 * Report whether an analysis currently owns this repository.
 *
 * A pure, non-blocking read: no ownership is acquired, stolen or awaited, nothing is written, and
 * no analysis is started.
 */
export function openloreAnalysisStatus(options: BaseOptions = {}): Promise<AnalysisStatusResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, () => openloreAnalysisStatusImpl(options));
}
