/**
 * Federation registry — load/save/add/remove/list the project-local
 * `.openlore/federation.json` index-of-indexes manifest, plus per-repo index
 * liveness evaluation.
 *
 * The registry is intentionally tiny and synchronous: it references repos, it is
 * never a build artifact. Adding or removing a repo edits only this file (and that
 * repo builds its own index independently) — never a global rebuild.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, basename } from 'node:path';
import {
  ARTIFACT_FINGERPRINT,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_DIR,
} from '../../constants.js';
import {
  FEDERATION_MANIFEST_FILENAME,
  FEDERATION_SCHEMA_VERSION,
  type ConsultedRepo,
  type FederationRegistry,
  type FederationRepoEntry,
  type RepoIndexState,
} from './types.js';

/** Absolute path to the federation manifest inside a home repo's `.openlore/`. */
export function federationManifestPath(homeDir: string): string {
  return join(resolve(homeDir), OPENLORE_DIR, FEDERATION_MANIFEST_FILENAME);
}

/**
 * Canonicalize a path for identity comparison. `process.cwd()` (the home dir the
 * CLI passes) is already symlink-resolved by the OS, but a user-supplied repo path
 * (`resolve()`d) is not — so on a system where the working tree sits behind a
 * symlink (macOS `/tmp` → `/private/tmp`, a symlinked checkout) a plain `resolve()`
 * comparison silently fails to match the same directory. Resolve symlinks so the
 * home-repo self-add guard, path de-dup, and remove-by-path all compare canonically.
 * Falls back to `resolve()` when the path does not exist (realpath would throw).
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Absolute path to a repo's index fingerprint file. */
function fingerprintPath(repoPath: string): string {
  return join(resolve(repoPath), OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT);
}

/**
 * Read a repo's current index fingerprint hash, or null when the repo has no
 * built index (or the file is unreadable/malformed).
 */
export function readRepoFingerprint(repoPath: string): string | null {
  const fp = fingerprintPath(repoPath);
  if (!existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf8')) as { hash?: unknown };
    return typeof parsed.hash === 'string' ? parsed.hash : null;
  } catch {
    return null;
  }
}

/**
 * Load the federation registry for a home repo. Returns an empty registry when no
 * manifest exists. Throws only on a present-but-corrupt manifest, so a typo never
 * silently degrades to "no federation".
 */
export function loadRegistry(homeDir: string): FederationRegistry {
  const manifest = federationManifestPath(homeDir);
  if (!existsSync(manifest)) {
    return { schemaVersion: FEDERATION_SCHEMA_VERSION, repos: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (err) {
    throw new Error(`Federation manifest is not valid JSON (${manifest}): ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as FederationRegistry).repos)) {
    throw new Error(`Federation manifest has an unexpected shape (${manifest}); expected { schemaVersion, repos[] }.`);
  }
  const reg = parsed as FederationRegistry;
  return {
    schemaVersion: typeof reg.schemaVersion === 'number' ? reg.schemaVersion : FEDERATION_SCHEMA_VERSION,
    repos: reg.repos.filter(r => r && typeof r.path === 'string' && typeof r.name === 'string'),
  };
}

/** Persist the registry atomically (write-tmp-then-rename) under `.openlore/`. */
export function saveRegistry(homeDir: string, registry: FederationRegistry): void {
  const manifest = federationManifestPath(homeDir);
  mkdirSync(join(resolve(homeDir), OPENLORE_DIR), { recursive: true });
  const tmp = `${manifest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  // rename is atomic on the same filesystem; avoids a torn manifest on crash.
  renameSync(tmp, manifest);
}

/**
 * Add (or refresh) a repo in the home repo's federation registry. Reads the
 * target's live fingerprint at registration time; a missing index is allowed
 * (recorded with an empty fingerprint) so a repo can be registered before its
 * first `openlore analyze`. De-duplicates by absolute path; a duplicate path
 * refreshes the existing entry rather than appending.
 */
export function addRepo(
  homeDir: string,
  repoPath: string,
  opts: { name?: string; now?: string } = {},
): { registry: FederationRegistry; entry: FederationRepoEntry } {
  const absRepo = canonicalize(isAbsolute(repoPath) ? repoPath : resolve(homeDir, repoPath));
  if (!existsSync(absRepo) || !statSync(absRepo).isDirectory()) {
    throw new Error(`Cannot add repo: ${absRepo} is not an existing directory.`);
  }
  if (absRepo === canonicalize(homeDir)) {
    throw new Error('Cannot add the home repo to its own federation registry; it is always in scope.');
  }
  const registry = loadRegistry(homeDir);
  const name = (opts.name ?? basename(absRepo)).trim();
  if (!name) throw new Error('Repo name resolved to empty; pass --name explicitly.');

  // A name must be unique unless it points at the same path (a refresh).
  const nameClash = registry.repos.find(r => r.name === name && canonicalize(r.path) !== absRepo);
  if (nameClash) {
    throw new Error(`Repo name "${name}" is already used by ${nameClash.path}; choose a different --name.`);
  }

  const entry: FederationRepoEntry = {
    name,
    path: absRepo,
    fingerprint: readRepoFingerprint(absRepo) ?? '',
    schemaVersion: FEDERATION_SCHEMA_VERSION,
    lastBuilt: opts.now ?? new Date().toISOString(),
  };
  const idx = registry.repos.findIndex(r => canonicalize(r.path) === absRepo);
  if (idx >= 0) registry.repos[idx] = entry;
  else registry.repos.push(entry);
  registry.repos.sort((a, b) => a.name.localeCompare(b.name));
  saveRegistry(homeDir, registry);
  return { registry, entry };
}

/** Remove a repo by name or absolute/relative path. Returns true if one was removed. */
export function removeRepo(homeDir: string, nameOrPath: string): boolean {
  const registry = loadRegistry(homeDir);
  const absCandidate = canonicalize(isAbsolute(nameOrPath) ? nameOrPath : resolve(homeDir, nameOrPath));
  const before = registry.repos.length;
  registry.repos = registry.repos.filter(
    r => r.name !== nameOrPath && canonicalize(r.path) !== absCandidate,
  );
  if (registry.repos.length === before) return false;
  saveRegistry(homeDir, registry);
  return true;
}

/** List registry entries (sorted by name). */
export function listRepos(homeDir: string): FederationRepoEntry[] {
  return loadRegistry(homeDir).repos;
}

/** Classify a registry entry's live index state without loading the graph. */
export function evaluateRepoState(entry: FederationRepoEntry): RepoIndexState {
  if (!existsSync(entry.path)) return 'missing';
  const live = readRepoFingerprint(entry.path);
  if (live === null) return 'unindexed';
  // An entry registered before its first analyze has an empty stored fingerprint.
  // Without a baseline, staleness cannot be assessed, so a now-present index is
  // 'unbaselined' — never a freshness-checked 'indexed'. A status/consult path
  // adopts the live hash on observation (adoptEmptyFingerprints) so the next drift
  // is detected as 'stale'.
  if (!entry.fingerprint) return 'unbaselined';
  if (live !== entry.fingerprint) return 'stale';
  return 'indexed';
}

/**
 * Baseline any registered repo whose stored fingerprint is empty (registered
 * before its first analyze) but now has a built index: adopt the live index hash
 * as the stored baseline, persisted through the atomic registry write. Makes the
 * "adopt the live hash on next refresh" promise true — once a baseline exists,
 * subsequent index drift is detected as `stale` instead of reported `indexed`
 * forever. Best-effort by design: a corrupt registry (nothing to adopt) or a
 * read-only registry (write fails) is swallowed and the caller still reports the
 * observed state honestly. Returns the names of the entries baselined (empty when
 * none applied or the write could not be persisted).
 */
export function adoptEmptyFingerprints(homeDir: string): string[] {
  let registry: FederationRegistry;
  try {
    registry = loadRegistry(homeDir);
  } catch {
    return []; // corrupt registry: the caller degrades it separately; nothing to adopt
  }
  const adopted: string[] = [];
  for (const entry of registry.repos) {
    if (entry.fingerprint) continue; // already baselined
    const live = readRepoFingerprint(entry.path);
    if (live === null) continue; // no index yet — adoption needs a live fingerprint
    entry.fingerprint = live;
    adopted.push(entry.name);
  }
  if (adopted.length === 0) return [];
  try {
    saveRegistry(homeDir, registry);
  } catch {
    return []; // read-only registry: report state honestly, never crash
  }
  return adopted;
}

/** Build a ConsultedRepo status record (consulted flag set by the caller). */
export function repoStatus(entry: FederationRepoEntry, consulted: boolean): ConsultedRepo {
  const state = evaluateRepoState(entry);
  const reasons: Record<Exclude<RepoIndexState, 'indexed'>, string> = {
    unbaselined: `index present but no fingerprint baseline yet — staleness not assessable until "openlore analyze" or re-registration in ${entry.path}`,
    stale: `index fingerprint changed since registration — re-run "openlore analyze" in ${entry.path}`,
    unindexed: `no .openlore index found — run "openlore analyze" in ${entry.path}`,
    missing: `repo path no longer exists: ${entry.path}`,
  };
  // An unbaselined repo has a live index, so it is consultable — its freshness just
  // cannot be assessed; the caveat is disclosed via `reason` even while consulted.
  const consultable = state === 'indexed' || state === 'unbaselined';
  return {
    name: entry.name,
    path: entry.path,
    state,
    consulted: consulted && consultable,
    reason: state === 'indexed' ? undefined : reasons[state],
  };
}
