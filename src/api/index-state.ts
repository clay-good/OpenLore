/**
 * `openloreIndexState` — does the persisted index still represent this working tree?
 * (change: extend-api-for-supervising-hosts)
 *
 * A supervising host must treat a branch or HEAD change as a SNAPSHOT TRANSITION, not a file edit:
 * the tree becomes a different tree, and analysis computed before it is not merely stale, it is
 * about something else. So the question gets asked at every checkout — and the only way to answer
 * it today is a full `analyze({ force: true })`, where a comparison would do.
 *
 * SOUND DIRECTION ONLY. The comparison recomputes the working tree's fingerprint under the
 * configuration the INDEX RECORDED, never under a guessed one. `--include` / `--exclude` /
 * `--max-files` are per-invocation inputs that decide which files the hash covers and are not
 * persisted anywhere else; recomputing under defaults would fingerprint a different corpus and
 * report a mismatch on a tree nobody touched — a false mismatch, which for a host that treats
 * mismatch as a snapshot transition means the spurious re-analysis this function exists to remove.
 * An index that recorded no configuration is therefore reported `config-unrecorded`: not
 * assessable, rather than confidently wrong.
 */
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_FINGERPRINT, OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { computeProjectFingerprint } from '../core/services/mcp-handlers/utils.js';
import { withLoggerOptions } from '../utils/logger.js';
import { safeJoin } from '../utils/path-confinement.js';
import type { BaseOptions } from './types.js';

/** The persisted configuration a fingerprint was computed under. */
export interface IndexFingerprintConfig {
  includePatterns: string[];
  excludePatterns: string[];
  maxFiles: number;
  protectedExcludePatterns: string[];
}

export interface IndexStateResult {
  /** True only when the recorded hash and the freshly computed one agree. */
  matchesWorkingTree: boolean;
  /** The hash the index was built from, when one is recorded. */
  fingerprint?: string;
  /**
   * Why the index does not represent the working tree.
   * `no-index` — nothing analyzed here. `unbaselined` — an artifact exists but records no hash.
   * `config-unrecorded` — the index predates configuration persistence, so no sound comparison is
   * possible. `fingerprint-mismatch` — recomputed under the recorded configuration, and it differs.
   */
  reason?: 'no-index' | 'unbaselined' | 'config-unrecorded' | 'fingerprint-mismatch';
}

interface FingerprintArtifact {
  hash?: unknown;
  fingerprintConfig?: unknown;
}

/** Accept a persisted config only when every field it must reproduce is actually there. */
function readConfig(value: unknown): IndexFingerprintConfig | null {
  if (value === null || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (!strings(c.includePatterns) || !strings(c.excludePatterns) || !strings(c.protectedExcludePatterns)) return null;
  if (typeof c.maxFiles !== 'number' || !Number.isFinite(c.maxFiles)) return null;
  return {
    includePatterns: c.includePatterns,
    excludePatterns: c.excludePatterns,
    protectedExcludePatterns: c.protectedExcludePatterns,
    maxFiles: c.maxFiles,
  };
}

async function openloreIndexStateImpl(options: BaseOptions): Promise<IndexStateResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(options.rootPath ?? process.cwd()).catch(() => null);
  if (root === null) return { matchesWorkingTree: false, reason: 'no-index' };

  const artifactPath = join(safeJoin(root, `${OPENLORE_ANALYSIS_REL_PATH}/`), ARTIFACT_FINGERPRINT);
  let artifact: FingerprintArtifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, 'utf-8')) as FingerprintArtifact;
  } catch {
    // Absent or unreadable are the same answer: there is no index to compare against.
    return { matchesWorkingTree: false, reason: 'no-index' };
  }

  const recorded = typeof artifact.hash === 'string' ? artifact.hash : '';
  if (recorded === '') return { matchesWorkingTree: false, reason: 'unbaselined' };

  const configuration = readConfig(artifact.fingerprintConfig);
  if (configuration === null) {
    // An index written before this field existed. Guessing a configuration here is how a false
    // mismatch gets manufactured, so say what is true: this cannot be assessed.
    return { matchesWorkingTree: false, fingerprint: recorded, reason: 'config-unrecorded' };
  }

  // The only expensive step in any of these reads — re-hashing the corpus. A caller that gave up
  // (a checkout superseded by the next one) should not pay for the rest of it.
  options.signal?.throwIfAborted();
  const live = await computeProjectFingerprint(root, {
    configuration,
    protectedExcludePatterns: configuration.protectedExcludePatterns,
  });
  if (live !== recorded) {
    return { matchesWorkingTree: false, fingerprint: recorded, reason: 'fingerprint-mismatch' };
  }
  return { matchesWorkingTree: true, fingerprint: recorded };
}

/**
 * Compare the persisted index's fingerprint against the working tree's.
 *
 * COST: this re-hashes the analyzed corpus, so it is O(repo bytes) of I/O. That is cheap next to an
 * analysis — no parsing, no call graph, no index write — but it is NOT an O(1) metadata check, and
 * a caller that runs it per keystroke will feel it. Per checkout is what it is for.
 *
 * There is deliberately no `files` scope. If a caller scoped to files A and B while file C changed,
 * an honest answer is still "does not match" — so the scope would buy nothing — and an
 * implementation that answered "matches" would be unsound. (`openloreDrift`'s `files` scope answers
 * a different question: which of these specs drifted.)
 *
 * A pure read: no artifact is written, no analysis ownership is acquired, no analysis is started.
 */
export function openloreIndexState(options: BaseOptions = {}): Promise<IndexStateResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, () => openloreIndexStateImpl(options));
}
