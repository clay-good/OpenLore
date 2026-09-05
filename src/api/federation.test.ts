/**
 * `openloreFederationList` (change: extend-api-for-supervising-hosts).
 *
 * The load-bearing test is the NON-WRITE one. The CLI's status path calls `adoptEmptyFingerprints`,
 * which baselines an unbaselined entry and persists the registry; a host that promised to only read
 * must not inherit that write through the API. So an `unbaselined` entry stays `unbaselined`, and
 * the manifest bytes are identical after the call.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { openloreFederationList } from './federation.js';
import { addRepo, federationManifestPath } from '../core/federation/registry.js';
import { ARTIFACT_FINGERPRINT, OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { isOpenLoreError } from '../utils/errors.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dir(prefix: string): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(made);
  // The registry canonicalizes paths, so the test compares against the resolved form too.
  return realpathSync(made);
}

/** Give a repo a built index by writing the fingerprint the registry reads. */
async function writeFingerprint(repo: string, hash: string): Promise<void> {
  const analysisDir = join(repo, OPENLORE_ANALYSIS_REL_PATH);
  await mkdir(analysisDir, { recursive: true });
  await writeFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({ hash }), 'utf8');
}

describe('openloreFederationList', () => {
  it('returns an empty list for a repo with no federation manifest, and creates nothing', async () => {
    const home = await dir('openlore-federation-home-');

    await expect(openloreFederationList({ rootPath: home })).resolves.toEqual({ repos: [], states: [] });

    expect(existsSync(federationManifestPath(home))).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });

  it('reports each registered repo with its evaluated index state', async () => {
    const home = await dir('openlore-federation-home-');
    const indexed = await dir('openlore-federation-indexed-');
    const unindexed = await dir('openlore-federation-unindexed-');
    const gone = await dir('openlore-federation-gone-');

    await writeFingerprint(indexed, 'hash-a');
    addRepo(home, indexed);
    addRepo(home, unindexed);
    addRepo(home, gone);
    await rm(gone, { recursive: true, force: true });

    const { repos, states } = await openloreFederationList({ rootPath: home });

    // The registry keeps its entries sorted by name, which is what the API republishes.
    const byPath = new Map(states.map(s => [s.path, s]));
    expect(new Set(repos.map(r => r.path))).toEqual(new Set([indexed, unindexed, gone]));
    expect(byPath.get(indexed)?.state).toBe('indexed');
    expect(byPath.get(unindexed)?.state).toBe('unindexed');
    expect(byPath.get(gone)?.state).toBe('missing');
    // An inventory, not a query: nothing was loaded, so nothing is reported consulted.
    expect(states.every(s => s.consulted === false)).toBe(true);
    expect(byPath.get(indexed)?.reason).toBeUndefined();
    expect(byPath.get(unindexed)?.reason).toContain('openlore analyze');
    expect(byPath.get(gone)?.reason).toContain('no longer exists');
  });

  it('never baselines an unbaselined entry — the registry file is byte-identical after the call', async () => {
    const home = await dir('openlore-federation-home-');
    const repo = await dir('openlore-federation-repo-');

    // Registered BEFORE its first analyze: the stored fingerprint is empty.
    addRepo(home, repo);
    // ...and analyzed afterwards, which is exactly the shape `adoptEmptyFingerprints` adopts.
    await writeFingerprint(repo, 'hash-built-later');

    const manifest = federationManifestPath(home);
    const before = await readFile(manifest, 'utf8');

    const first = await openloreFederationList({ rootPath: home });
    const second = await openloreFederationList({ rootPath: home });

    expect(first.states[0].state).toBe('unbaselined');
    // A read that had adopted would report `indexed` the second time round.
    expect(second.states[0].state).toBe('unbaselined');
    expect(first.repos[0].fingerprint).toBe('');
    expect(await readFile(manifest, 'utf8')).toBe(before);
    // Consultable despite being unassessable — the caveat is disclosed, not hidden.
    expect(first.states[0].reason).toContain('staleness not assessable');
  });

  it('surfaces a corrupt manifest as a typed error rather than reporting no federated repos', async () => {
    const home = await dir('openlore-federation-home-');
    const repo = await dir('openlore-federation-repo-');
    addRepo(home, repo);
    await writeFile(federationManifestPath(home), '{ not json', 'utf8');

    const error = await openloreFederationList({ rootPath: home }).catch((err: unknown) => err);

    expect(isOpenLoreError(error)).toBe(true);
    expect((error as Error).message).toContain('Federation registry could not be read');
  });

  it('returns an empty list for an unresolvable root instead of throwing', async () => {
    const home = await dir('openlore-federation-home-');
    await expect(openloreFederationList({ rootPath: join(home, 'nope') }))
      .resolves.toEqual({ repos: [], states: [] });
  });
});
