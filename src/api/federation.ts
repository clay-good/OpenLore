/**
 * `openloreFederationList` — a read of the federation registry
 * (change: extend-api-for-supervising-hosts).
 *
 * A host that isolates workspaces must be able to SAY what a federated answer covered, and must be
 * able to prove it never wrote the registry. Reading is enough: registration stays an explicit user
 * act through the CLI and tools.
 *
 * Deliberately does NOT call `adoptEmptyFingerprints`. That baselines empty fingerprints and
 * persists the registry — correct for the CLI's status path, wrong for a caller that has promised
 * not to write. A host may therefore observe `unbaselined` where the CLI would have adopted; the
 * per-repo `reason` already discloses that caveat, so the honest read loses nothing.
 */
import { realpath } from 'node:fs/promises';
import { federationManifestPath, listRepos, repoStatus } from '../core/federation/registry.js';
import type { ConsultedRepo, FederationRepoEntry } from '../core/federation/types.js';
import { OpenLoreError } from '../utils/errors.js';
import { withLoggerOptions } from '../utils/logger.js';
import type { BaseOptions } from './types.js';

export interface FederationListResult {
  /** Registered entries, sorted by name. Empty when no registry exists. */
  repos: FederationRepoEntry[];
  /** Each entry's evaluated index state, with the reason it is not freshly indexed. */
  states: ConsultedRepo[];
}

async function openloreFederationListImpl(options: BaseOptions): Promise<FederationListResult> {
  options.signal?.throwIfAborted();
  const root = await realpath(options.rootPath ?? process.cwd()).catch(() => null);
  if (root === null) return { repos: [], states: [] };

  // A MISSING manifest is an empty federation, not a failure — `loadRegistry` already returns an
  // empty registry for it, so a host asking "what did this cover?" on a repo that federates
  // nothing gets an answer rather than an exception. A CORRUPT manifest is the opposite: reporting
  // it as "no federated repos" would be a claim the bytes do not support, so it surfaces typed.
  let repos: FederationRepoEntry[];
  try {
    repos = listRepos(root);
  } catch (err) {
    throw new OpenLoreError(
      `Federation registry could not be read: ${(err as Error).message}`,
      'INVALID_CONFIG',
      `Repair or remove ${federationManifestPath(root)}, then re-run.`,
      { cause: err },
    );
  }
  // `consulted: false` — this is an inventory, not a query; nothing was loaded or used.
  return { repos, states: repos.map(entry => repoStatus(entry, false)) };
}

/**
 * List the repositories registered in this root's federation, with each one's index state.
 *
 * A pure read: the registry is never created, modified, removed or baselined.
 */
export function openloreFederationList(options: BaseOptions = {}): Promise<FederationListResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, () => openloreFederationListImpl(options));
}
