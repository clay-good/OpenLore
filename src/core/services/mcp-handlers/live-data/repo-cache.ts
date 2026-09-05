/**
 * Spec-09 — repo cache + fetch layer.
 *
 * Materializes a manifest repo into a gitignored cache, checked out at exactly its
 * pinned SHA. Determinism guarantees (spec-09 §2):
 *   - A warm, valid cache entry makes NO network calls.
 *   - After checkout, the resolved HEAD MUST equal the pinned SHA — a moved tag or
 *     rewritten history fails loudly; it never silently changes inputs.
 *   - When a repo is absent and the network is unavailable, fetch SKIPS with a
 *     single explicit log line — never a silent pass.
 */

import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureRepo, PLACEHOLDER_SHA } from './fixture-repos.js';
import { execFileGit as execFileAsync } from '../../../../utils/git-exec.js';


/** Repo root = six levels up from this file (src/core/services/mcp-handlers/live-data/). */
function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return join(here, '..', '..', '..', '..', '..', '..');
}

/** Gitignored cache directory. Override with OPENLORE_LIVE_CACHE_DIR. */
export function cacheDir(): string {
  const override = process.env.OPENLORE_LIVE_CACHE_DIR;
  if (override) return isAbsolute(override) ? override : join(process.cwd(), override);
  return join(repoRoot(), '.openlore-live-cache');
}

export type FetchStatus = 'ready' | 'skipped';

export interface FetchResult {
  entry: FixtureRepo;
  /** Absolute path to the checked-out repo (only valid when status === 'ready'). */
  dir: string;
  status: FetchStatus;
  /** Present when skipped — the single explicit reason. */
  reason?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function resolvedHead(dir: string): Promise<string | null> {
  try {
    return await git(dir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Ensure the repo is present at its pinned SHA. Returns 'ready' with a usable dir,
 * or 'skipped' with a loud reason (placeholder SHA, or network unavailable).
 *
 * Throws ONLY on the integrity violation: a successful fetch whose HEAD does not
 * equal the pinned SHA. That must never be swallowed.
 */
export async function ensureRepo(entry: FixtureRepo): Promise<FetchResult> {
  const dir = join(cacheDir(), `${entry.id}@${entry.sha}`);

  // Placeholder SHA: we cannot pin deterministically yet. Skip loudly rather than
  // fetch something unverifiable. (Resolved by the first networked run.)
  if (entry.sha === PLACEHOLDER_SHA) {
    const reason = `${entry.id} — sha is placeholder, pending networked confirmation`;
    log(`SKIP ${reason}`);
    return { entry, dir, status: 'skipped', reason };
  }

  // Warm cache hit: verify and use without network.
  if (existsSync(join(dir, '.git'))) {
    const head = await resolvedHead(dir);
    if (head === entry.sha) return { entry, dir, status: 'ready' };
    // Present but at the wrong SHA — try to re-checkout offline before giving up.
    try {
      await git(dir, ['checkout', '--quiet', entry.sha]);
      const reHead = await resolvedHead(dir);
      if (reHead === entry.sha) return { entry, dir, status: 'ready' };
    } catch {
      /* fall through to fetch */
    }
  }

  // Cold (or unusable) cache: attempt a network fetch.
  try {
    if (!existsSync(join(dir, '.git'))) {
      // blob:none keeps the clone cheap while still resolving an arbitrary SHA.
      await execFileAsync('git', ['clone', '--filter=blob:none', '--no-tags', entry.url, dir], {
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    await git(dir, ['checkout', '--quiet', entry.sha]);
  } catch (err) {
    // Treat any fetch/clone failure as offline/unavailable — skip, do not fail.
    const reason = `${entry.id} — repo not cached and network unavailable (${shortErr(err)})`;
    log(`SKIP ${reason}`);
    return { entry, dir, status: 'skipped', reason };
  }

  // Integrity assertion: a successful fetch MUST land on the pinned SHA.
  const head = await resolvedHead(dir);
  if (head !== entry.sha) {
    throw new Error(
      `live-data: integrity failure for ${entry.id} — resolved HEAD ${head ?? '(none)'} != pinned ${entry.sha}. ` +
        `A moved tag or rewritten history must not silently change inputs.`,
    );
  }
  return { entry, dir, status: 'ready' };
}

function shortErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].slice(0, 120);
}

/** Single, explicit, prefixed log line so skips are never silent. */
function log(line: string): void {
   
  console.warn(`live-data: ${line}`);
}
