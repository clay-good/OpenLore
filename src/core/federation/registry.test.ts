/**
 * Federation registry unit tests (change: add-multi-repo-federation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  addRepo,
  removeRepo,
  listRepos,
  loadRegistry,
  evaluateRepoState,
  adoptEmptyFingerprints,
  repoStatus,
  federationManifestPath,
} from './registry.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';

let home: string;
const peers: string[] = [];

function makePeer(name: string, fingerprint?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fed-peer-${name}-`));
  peers.push(dir);
  if (fingerprint !== undefined) writeFingerprint(dir, fingerprint);
  return dir;
}

function writeFingerprint(dir: string, hash: string): void {
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash, computedAt: '2026-06-19T00:00:00.000Z', fileCount: 1 }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fed-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const p of peers.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('federation registry', () => {
  it('starts empty when no manifest exists', () => {
    expect(listRepos(home)).toEqual([]);
    expect(loadRegistry(home).schemaVersion).toBe(1);
  });

  it('adds a repo, persists the manifest, and captures its fingerprint', () => {
    const peer = makePeer('a', 'hash-a');
    const { entry } = addRepo(home, peer, { now: '2026-06-19T00:00:00.000Z' });
    expect(entry.name).toMatch(/^fed-peer-a-/); // basename-derived
    expect(entry.fingerprint).toBe('hash-a');
    expect(existsSync(federationManifestPath(home))).toBe(true);
    expect(listRepos(home)).toHaveLength(1);
  });

  it('uses an explicit --name and rejects the home repo', () => {
    const peer = makePeer('a', 'h');
    const { entry } = addRepo(home, peer, { name: 'svc-a' });
    expect(entry.name).toBe('svc-a');
    expect(() => addRepo(home, home)).toThrow(/home repo/i);
  });

  it('de-duplicates by path (refresh) rather than appending', () => {
    const peer = makePeer('a', 'h1');
    addRepo(home, peer, { name: 'a' });
    writeFingerprint(peer, 'h2');
    addRepo(home, peer, { name: 'a' });
    const repos = listRepos(home);
    expect(repos).toHaveLength(1);
    expect(repos[0].fingerprint).toBe('h2');
  });

  it('rejects a name collision on a different path', () => {
    const p1 = makePeer('a', 'h');
    const p2 = makePeer('b', 'h');
    addRepo(home, p1, { name: 'dup' });
    expect(() => addRepo(home, p2, { name: 'dup' })).toThrow(/already used/i);
  });

  it('removes by name and by path', () => {
    const p1 = makePeer('a', 'h');
    const p2 = makePeer('b', 'h');
    addRepo(home, p1, { name: 'a' });
    addRepo(home, p2, { name: 'b' });
    expect(removeRepo(home, 'a')).toBe(true);
    expect(removeRepo(home, p2)).toBe(true);
    expect(listRepos(home)).toHaveLength(0);
    expect(removeRepo(home, 'nope')).toBe(false);
  });

  it('classifies index state: indexed / stale / unindexed / missing', () => {
    const indexed = makePeer('a', 'h');
    const stale = makePeer('b', 'h');
    const unindexed = makePeer('c'); // no fingerprint
    addRepo(home, indexed, { name: 'indexed' });
    addRepo(home, stale, { name: 'stale' });
    addRepo(home, unindexed, { name: 'unindexed' });
    writeFingerprint(stale, 'h-changed'); // fingerprint drifts after registration

    const byName = Object.fromEntries(listRepos(home).map(r => [r.name, r]));
    expect(evaluateRepoState(byName['indexed'])).toBe('indexed');
    expect(evaluateRepoState(byName['stale'])).toBe('stale');
    expect(evaluateRepoState(byName['unindexed'])).toBe('unindexed');

    rmSync(indexed, { recursive: true, force: true });
    expect(evaluateRepoState(byName['indexed'])).toBe('missing');
  });

  // Regression: path identity must be symlink-canonical. The CLI passes
  // `process.cwd()` as the home dir, which the OS already symlink-resolves, but a
  // user-supplied repo path is only `resolve()`d. On a system where the working
  // tree is behind a symlink (macOS /tmp → /private/tmp, a symlinked checkout) a
  // plain string compare fails to match the same directory — so the home-repo
  // self-add guard and the path de-dup silently broke. canonicalize() fixes it.
  // skipIf(win32): creating a directory symlink needs elevated privileges or Developer Mode,
  // so the alias this is about cannot be built on a stock runner. Canonicalisation itself is
  // platform-independent and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('canonicalizes symlinked paths: rejects the home repo and de-dups across spellings', () => {
    const realHome = realpathSync(home);
    const linkRoot = mkdtempSync(join(tmpdir(), 'fed-link-'));
    peers.push(linkRoot);
    // A symlink whose target is the (real) home repo — a different spelling of it.
    const homeLink = join(linkRoot, 'home-alias');
    symlinkSync(realHome, homeLink);
    // Adding the home repo via its symlinked spelling must still be rejected.
    expect(() => addRepo(realHome, homeLink)).toThrow(/home repo/i);

    // A real peer, then the same peer via a symlinked spelling → refresh, not append.
    const peer = makePeer('a', 'h');
    const peerLink = join(linkRoot, 'peer-alias');
    symlinkSync(realpathSync(peer), peerLink);
    addRepo(realHome, peer, { name: 'a' });
    addRepo(realHome, peerLink, { name: 'a' });
    expect(listRepos(realHome)).toHaveLength(1);
    // remove via yet another spelling (the symlink) still matches.
    expect(removeRepo(realHome, peerLink)).toBe(true);
    expect(listRepos(realHome)).toHaveLength(0);
  });

  it('throws on a corrupt manifest rather than silently degrading', () => {
    mkdirSync(join(home, '.openlore'), { recursive: true });
    writeFileSync(federationManifestPath(home), '{ not json');
    expect(() => loadRegistry(home)).toThrow(/not valid JSON/i);
  });

  // Regression (change: harden-federation-freshness). A repo registered before its
  // first analyze stores an empty fingerprint; once its index appears it must be
  // disclosed as `unbaselined`, never reported as a freshness-checked `indexed`
  // forever while its index drifts arbitrarily.
  it('classifies a registered-before-analyze repo as unbaselined once it has an index', () => {
    const peer = makePeer('a'); // registered with no index → empty stored fingerprint
    addRepo(home, peer, { name: 'a' });
    expect(listRepos(home)[0].fingerprint).toBe('');
    // No index yet → unindexed (adoption needs a live fingerprint).
    expect(evaluateRepoState(listRepos(home)[0])).toBe('unindexed');
    // Index built after registration → unbaselined, not indexed.
    writeFingerprint(peer, 'h1');
    expect(evaluateRepoState(listRepos(home)[0])).toBe('unbaselined');
  });

  it('adopts the live hash on observation, closing the forever-indexed blind spot', () => {
    const peer = makePeer('a'); // empty fingerprint at registration
    addRepo(home, peer, { name: 'a' });
    writeFingerprint(peer, 'h1'); // index appears

    const adopted = adoptEmptyFingerprints(home);
    expect(adopted).toEqual(['a']);
    // Baseline is now persisted: h1.
    expect(listRepos(home)[0].fingerprint).toBe('h1');
    expect(evaluateRepoState(listRepos(home)[0])).toBe('indexed');

    // Subsequent drift is now detectable as stale (was silently 'indexed' before).
    writeFingerprint(peer, 'h2');
    expect(evaluateRepoState(listRepos(home)[0])).toBe('stale');

    // Idempotent: a second adoption pass has nothing to do.
    expect(adoptEmptyFingerprints(home)).toEqual([]);
  });

  it('adoption only fires for an empty-fingerprint entry that has a live index', () => {
    const noIndex = makePeer('a'); // empty fingerprint, no index
    const baselined = makePeer('b', 'h'); // already carries a fingerprint
    addRepo(home, noIndex, { name: 'a' });
    addRepo(home, baselined, { name: 'b' });

    expect(adoptEmptyFingerprints(home)).toEqual([]); // 'a' has no index; 'b' already baselined
    expect(evaluateRepoState(listRepos(home).find(r => r.name === 'a')!)).toBe('unindexed');
    expect(evaluateRepoState(listRepos(home).find(r => r.name === 'b')!)).toBe('indexed');
  });

  it('adoption is harmless on a corrupt registry (nothing to adopt, no throw)', () => {
    mkdirSync(join(home, '.openlore'), { recursive: true });
    writeFileSync(federationManifestPath(home), '{ not json');
    expect(adoptEmptyFingerprints(home)).toEqual([]); // swallowed; caller degrades separately
  });

  // chmod is a no-op for root (write always permitted), so this assertion of a
  // failed write only holds for a non-root user.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  // Also skipped on Windows: the premise is a directory that REFUSES a write, and chmod does
  // not express that there — Node maps the mode to the read-only attribute, which does not stop
  // a write inside the directory. saveRegistry therefore SUCCEEDS, the entry gets baselined,
  // and the test reports 'indexed' vs 'unbaselined' — a result about the fixture, not the code.
  // Expressing it would need an ACL denial (icacls), which is a different test.
  (isRoot || process.platform === 'win32' ? it.skip : it)('adoption is harmless on a read-only registry (no crash; state still honest)', () => {
    const peer = makePeer('a'); // empty fingerprint
    addRepo(home, peer, { name: 'a' });
    writeFingerprint(peer, 'h1'); // index appears → would-be adoption
    const dotDir = dirname(federationManifestPath(home));
    chmodSync(dotDir, 0o555); // read+execute, no write → saveRegistry's tmp write fails
    try {
      expect(() => adoptEmptyFingerprints(home)).not.toThrow();
      expect(adoptEmptyFingerprints(home)).toEqual([]); // write failed → nothing baselined
      // The state is still reported honestly (a read never depends on the write).
      expect(evaluateRepoState(listRepos(home)[0])).toBe('unbaselined');
    } finally {
      chmodSync(dotDir, 0o755); // restore so afterEach can clean up
    }
  });

  it('repoStatus reports an unbaselined repo as consultable but labeled', () => {
    const peer = makePeer('a'); // empty fingerprint
    addRepo(home, peer, { name: 'a' });
    writeFingerprint(peer, 'h1');
    const status = repoStatus(listRepos(home)[0], true);
    expect(status.state).toBe('unbaselined');
    expect(status.consulted).toBe(true); // consultable
    expect(status.reason).toMatch(/no fingerprint baseline/i); // but disclosed
  });
});
