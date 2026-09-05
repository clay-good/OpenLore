/**
 * `openloreHealth` — functional readiness as a value (change: extend-api-for-supervising-hosts).
 *
 * A supervising host must never report "ready" because a process is alive. The distinctions it
 * needs — runtime available, index present and whole, watcher healthy, background repair running —
 * are ones OpenLore already draws internally; today a host assembles them by parsing the daemon's
 * `/health` payload and inferring the rest from the shape of an analyze result. That is inference
 * where a fact would do, and it couples the host to a transport payload rather than a contract.
 *
 * DISK IS THE BASE CASE, NOT A FALLBACK. Index state, degradations and repair-in-progress are read
 * from disk, so the answer is meaningful with no daemon at all: a repository with a whole index and
 * nothing running is `ready`, never `unavailable`. A discoverable daemon only REFINES the answer,
 * by supplying the one fact disk cannot hold — whether the freshness watcher is running.
 */
import { realpath, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { readGenerationSnapshot, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';
import { readAnalysisOwner } from '../core/runtime/analysis-ownership.js';
import { readDescriptor } from '../cli/commands/serve.js';
import { serveHttpBaseUrl, validateServeHealth } from '../cli/commands/serve-descriptor.js';
import { fileExists } from '../utils/command-helpers.js';
import { withLoggerOptions } from '../utils/logger.js';
import { safeJoin } from '../utils/path-confinement.js';
import type { BaseOptions } from './types.js';

/**
 * One analysis artifact that is not usable on disk.
 *
 * Artifact-level, and deliberately NOT the same thing as `AnalyzeIndexDegradation`: that one
 * reports a SEARCH index built at reduced fidelity, this one reports a file that is missing or
 * unparseable. A host watching for "my index is not whole" needs this one.
 */
export interface HealthIndexDegradation {
  /** The artifact filename, e.g. `dependency-graph.json`. */
  artifact: string;
  reason: 'missing' | 'corrupt';
}

/**
 * Why the result is not ready, as a value a host can switch on. The `reason` string beside it is
 * for a human; a caller must never have to parse it.
 */
export type HealthReasonCode =
  | 'no-root'
  | 'no-index'
  | 'building'
  | 'analysis-changed'
  | 'degraded-index';

export interface HealthResult {
  /** Whether OpenLore can operate on this root at all. */
  runtime: 'available' | 'unavailable';
  /**
   * `absent` — nothing analyzed yet. `building` — no usable index, but an analysis owns the
   * repository right now. `degraded` — an index exists but at least one artifact is missing or
   * corrupt. `ready` — every required artifact is present and parseable.
   */
  index: 'absent' | 'building' | 'ready' | 'degraded';
  /** Present only when `index` is `degraded`; names each artifact and why. */
  indexDegradations?: HealthIndexDegradation[];
  /**
   * `unknown` whenever no healthy daemon is discoverable, or the daemon predates watcher
   * reporting. Never guessed: a stopped watcher and an unobservable one are different facts.
   */
  watcher: 'healthy' | 'stopped' | 'unknown';
  /** True while an analysis owns the repository — a rebuild or repair is running. */
  repairInProgress: boolean;
  /** Present whenever `index` is not `ready`, or the runtime is unavailable. */
  reasonCode?: HealthReasonCode;
  /** The human-readable form of `reasonCode`. Never the machine-readable one. */
  reason?: string;
}

/** Classify each required analysis artifact on disk. */
async function inspectArtifacts(analysisDir: string): Promise<{ present: number; degradations: HealthIndexDegradation[] }> {
  const degradations: HealthIndexDegradation[] = [];
  let present = 0;
  for (const artifact of REQUIRED_ANALYSIS_ARTIFACTS) {
    const path = join(analysisDir, artifact);
    if (!(await fileExists(path))) {
      degradations.push({ artifact, reason: 'missing' });
      continue;
    }
    present += 1;
    try {
      JSON.parse(await readFile(path, 'utf-8'));
    } catch {
      degradations.push({ artifact, reason: 'corrupt' });
    }
  }
  return { present, degradations };
}

/**
 * Ask a discoverable daemon for its watcher state. Returns `unknown` on every uncertainty — no
 * descriptor, an unreachable daemon, a health response that fails the SHARED validator, or a
 * daemon too old to report it. The descriptor is an untrusted artifact, so it is resolved through
 * `readDescriptor`/`validateServeHealth` like every other reader
 * (mcp-security: ServeDescriptorValidatedAtEveryReader) — never parsed here.
 */
async function watcherState(root: string, signal?: AbortSignal): Promise<'healthy' | 'stopped' | 'unknown'> {
  const descriptor = await readDescriptor(root).catch(() => null);
  if (!descriptor) return 'unknown'; // no daemon announced → no request is issued at all
  // Hoisted so the whole file-to-network flow is attributed to the one reviewed call below,
  // exactly as `serve-client` does for the identical probe.
  const headers = descriptor.token ? { 'x-openlore-token': descriptor.token } : undefined;
  try {
    // INTENTIONAL EGRESS: validated descriptors are loopback-only and redirects are disabled.
    // codeql[js/file-access-to-http]
    const response = await fetch(`${serveHttpBaseUrl(descriptor.host, descriptor.port)}/health`, {
      headers,
      // The descriptor is attacker-writable, and this request carries the daemon token. A followed
      // redirect would send it off-loopback — the exact egress the shared validator exists to
      // prevent. Every other descriptor reader refuses redirects; so does this one.
      redirect: 'error',
      // The caller's cancellation and our own deadline are both reasons to stop waiting.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000),
    });
    if (!response.ok) return 'unknown';
    const health = validateServeHealth(await response.json(), root, descriptor);
    return health?.watcher ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function openloreHealthImpl(options: BaseOptions): Promise<HealthResult> {
  options.signal?.throwIfAborted();
  let root: string;
  try {
    root = await realpath(options.rootPath ?? process.cwd());
  } catch {
    return {
      runtime: 'unavailable',
      index: 'absent',
      watcher: 'unknown',
      repairInProgress: false,
      reasonCode: 'no-root',
      reason: `${resolve(options.rootPath ?? process.cwd())} could not be resolved.`,
    };
  }

  const analysisDir = safeJoin(root, `${OPENLORE_ANALYSIS_REL_PATH}/`);
  const [snapshot, owner, watcher] = await Promise.all([
    // A readiness verdict is a MULTI-ARTIFACT read, so it runs under the generation contract like
    // every other one: a full analyze rewrites artifacts in place and publishes its manifest last,
    // so reading the files independently can combine an old artifact with a new one and still call
    // the mixture `ready`. The artifacts this read itself found missing or corrupt are declared as
    // allowed mismatches — they are the answer (`degraded`), not evidence of a racing rebuild.
    readGenerationSnapshot(
      analysisDir,
      [...REQUIRED_ANALYSIS_ARTIFACTS],
      () => inspectArtifacts(analysisDir),
      value => value.degradations.map(degradation => degradation.artifact),
    ),
    readAnalysisOwner(root, analysisDir),
    watcherState(root, options.signal),
  ]);
  // `watcherState` swallows an aborted fetch as `unknown`, so re-check here: a caller that
  // cancelled gets an abort, not a confidently degraded answer it never asked for.
  options.signal?.throwIfAborted();
  const repairInProgress = owner !== null;

  if (snapshot.state === 'analysis-changed') {
    // The generation moved under the read. Nothing observed can be vouched for as one index, and
    // claiming `ready` from a mixture is precisely what the contract forbids.
    return {
      runtime: 'available',
      index: 'building',
      watcher,
      repairInProgress,
      reasonCode: 'analysis-changed',
      reason: `${snapshot.message} No readiness verdict is claimed for a mixed generation.`,
    };
  }

  const { present, degradations } = snapshot.state === 'ok'
    ? snapshot.value
    // No manifest and no legacy artifact set: there is no generation to read at all.
    : { present: 0, degradations: [] as HealthIndexDegradation[] };

  if (present === 0) {
    return {
      runtime: 'available',
      index: repairInProgress ? 'building' : 'absent',
      watcher,
      repairInProgress,
      reasonCode: repairInProgress ? 'building' : 'no-index',
      reason: repairInProgress
        ? 'An analysis owns this repository; no index is readable yet.'
        : 'This repository has not been analyzed. Run "openlore analyze".',
    };
  }

  if (degradations.length > 0) {
    return {
      runtime: 'available',
      index: 'degraded',
      indexDegradations: degradations,
      watcher,
      repairInProgress,
      reasonCode: 'degraded-index',
      reason: `${degradations.map(d => `${d.artifact} (${d.reason})`).join(', ')}. Re-run "openlore analyze".`,
    };
  }

  return { runtime: 'available', index: 'ready', watcher, repairInProgress };
}

/**
 * Report whether OpenLore is functionally ready for this working tree.
 *
 * A pure read: no artifact is written, no analysis is started, no LLM provider is needed. At most
 * one loopback request is issued, and only when a daemon is already announced.
 */
export function openloreHealth(options: BaseOptions = {}): Promise<HealthResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, () => openloreHealthImpl(options));
}
