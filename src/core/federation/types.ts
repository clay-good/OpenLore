/**
 * Multi-repo federation — shared types.
 *
 * Federation is an *index-of-indexes*: each repository keeps its own
 * independently-built `.openlore/` index, and a small project-local registry
 * (`.openlore/federation.json`) references those indexes by path, fingerprint and
 * schema version. No merged cross-repo graph is ever materialized; federated
 * queries load only the per-repo indexes they need, on demand.
 *
 * See: openspec/changes/add-multi-repo-federation and decisions bf5aff2d (registry
 * schema) + 67ca60fe (cross-repo resolution contract).
 */

/** Current registry manifest schema version. Bumped on a breaking shape change. */
export const FEDERATION_SCHEMA_VERSION = 1;

/** Registry manifest filename, stored under the home repo's `.openlore/` dir. */
export const FEDERATION_MANIFEST_FILENAME = 'federation.json';

/** One federated repository: a reference to its independently-built index. */
export interface FederationRepoEntry {
  /** Stable, user-facing name for the repo within the federation. */
  name: string;
  /** Absolute path to the repository root (the dir containing its `.openlore/`). */
  path: string;
  /**
   * The repo index fingerprint captured at registration time
   * (`.openlore/analysis/fingerprint.json` → `hash`). Used to detect staleness:
   * a query re-reads the live fingerprint and flags a mismatch.
   */
  fingerprint: string;
  /** Federation manifest schema version this entry was written under. */
  schemaVersion: number;
  /** ISO-8601 timestamp the entry was added/refreshed. */
  lastBuilt: string;
}

/** The on-disk registry manifest. */
export interface FederationRegistry {
  schemaVersion: number;
  repos: FederationRepoEntry[];
}

/** Liveness of a repo's index relative to the registry, evaluated at query time. */
export type RepoIndexState =
  /** Index present and its live fingerprint matches the registry. */
  | 'indexed'
  /**
   * Index present but the entry carries no stored fingerprint baseline yet (the
   * repo was registered before its first `openlore analyze`). Staleness cannot be
   * assessed until a baseline is adopted; consultable but disclosed as such — never
   * reported as a freshness-checked `indexed`.
   */
  | 'unbaselined'
  /** Index present but its fingerprint differs from the registry baseline (re-register to re-baseline). */
  | 'stale'
  /** No `.openlore/` index found at the repo path (run `openlore analyze`). */
  | 'unindexed'
  /** The repo path no longer exists. */
  | 'missing';

/** A repo's status the moment a federated query consulted (or skipped) it. */
export interface ConsultedRepo {
  name: string;
  path: string;
  state: RepoIndexState;
  /** True when the query actually loaded and used this repo's index. */
  consulted: boolean;
  /**
   * Present when the repo was skipped (why it was not consulted), or as a caveat
   * when it was consulted but its freshness could not be assessed (`unbaselined`).
   */
  reason?: string;
}

/**
 * Coverage block attached to every federation-scoped conclusion. It names which
 * repos were consulted and which were skipped (unindexed/stale/missing), so the
 * answer never silently under-reports its scope.
 */
export interface FederationCoverage {
  /** True when federation scope was actually applied to this conclusion. */
  applied: boolean;
  reposConsulted: ConsultedRepo[];
  reposSkipped: ConsultedRepo[];
  /** Human-readable caveats (e.g. name-collision risk on bare exported names). */
  caveats: string[];
}
