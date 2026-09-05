/**
 * `openloreIndexState` (change: extend-api-for-supervising-hosts).
 *
 * The test that matters most here is the FALSE-MISMATCH one: an index built with a narrowed corpus
 * must still compare equal on an untouched tree. That is the failure a naive implementation ships
 * — recompute under the default configuration, report a mismatch on a tree nobody edited, and hand
 * a supervising host a spurious re-analysis at every checkout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreIndexState } from './index-state.js';
import { openloreInit } from './init.js';
import { openloreAnalyze } from './analyze.js';
import { ARTIFACT_FINGERPRINT, DEFAULT_MAX_FILES, OPENLORE_ANALYSIS_REL_PATH } from '../constants.js';
import { computeProjectFingerprint } from '../core/services/mcp-handlers/utils.js';
import { runtimeDirOf } from '../core/runtime/analysis-ownership.js';
import { fileExists } from '../utils/command-helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Config {
  includePatterns: string[];
  excludePatterns: string[];
  maxFiles: number;
  protectedExcludePatterns: string[];
}

const defaultConfig = (): Config => ({
  includePatterns: [],
  excludePatterns: [],
  maxFiles: DEFAULT_MAX_FILES,
  protectedExcludePatterns: [],
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openlore-index-state-'));
  dirs.push(dir);
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
  await mkdir(join(dir, 'vendor'), { recursive: true });
  await writeFile(join(dir, 'vendor', 'big.ts'), 'export const vendored = 1;\n');
  return dir;
}

/** Write a fingerprint artifact the way an analysis run does, under `configuration`. */
async function baseline(root: string, configuration: Config): Promise<string> {
  const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
  await mkdir(analysisDir, { recursive: true });
  const hash = await computeProjectFingerprint(root, {
    configuration,
    protectedExcludePatterns: configuration.protectedExcludePatterns,
  });
  await writeFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({
    hash,
    computedAt: new Date().toISOString(),
    fingerprintConfig: configuration,
  }));
  return hash;
}

describe('openloreIndexState', () => {
  it('reports a match on an unchanged tree and carries the fingerprint', async () => {
    const root = await workspace();
    const hash = await baseline(root, defaultConfig());

    const state = await openloreIndexState({ rootPath: root });

    expect(state.matchesWorkingTree).toBe(true);
    expect(state.fingerprint).toBe(hash);
    expect(state.reason).toBeUndefined();
  });

  it('does not report a false mismatch for an index built with a narrowed corpus', async () => {
    const root = await workspace();
    // The index was built excluding vendor/ — a per-invocation `--exclude` that lives nowhere else.
    const narrowed = { ...defaultConfig(), excludePatterns: ['vendor/**'] };
    await baseline(root, narrowed);

    const state = await openloreIndexState({ rootPath: root });

    expect(state.reason).toBeUndefined();
    expect(state.matchesWorkingTree).toBe(true);

    // Pin the trap: recomputing under the DEFAULT configuration would have disagreed, which is
    // exactly the false mismatch this test exists to catch.
    const underDefaults = await computeProjectFingerprint(root, { configuration: defaultConfig() });
    expect(underDefaults).not.toBe(state.fingerprint);
  });

  it('reports a mismatch after a source edit, without starting an analysis', async () => {
    const root = await workspace();
    await baseline(root, defaultConfig());
    await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');

    const state = await openloreIndexState({ rootPath: root });

    expect(state.matchesWorkingTree).toBe(false);
    expect(state.reason).toBe('fingerprint-mismatch');
    // No ownership was taken: the runtime dir holds no lock.
    const lock = join(runtimeDirOf(join(root, OPENLORE_ANALYSIS_REL_PATH)), 'analysis-ownership.lock');
    expect(await fileExists(lock)).toBe(false);
  });

  it('distinguishes a never-analyzed repository from a stale one', async () => {
    const root = await workspace();
    const state = await openloreIndexState({ rootPath: root });
    expect(state.matchesWorkingTree).toBe(false);
    expect(state.reason).toBe('no-index');
    expect(state.fingerprint).toBeUndefined();
  });

  it('reports an artifact with no recorded hash as unbaselined', async () => {
    const root = await workspace();
    const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({ hash: '', fingerprintConfig: defaultConfig() }));

    const state = await openloreIndexState({ rootPath: root });
    expect(state.reason).toBe('unbaselined');
  });

  it('refuses to compare an index that recorded no configuration', async () => {
    const root = await workspace();
    const analysisDir = join(root, OPENLORE_ANALYSIS_REL_PATH);
    await mkdir(analysisDir, { recursive: true });
    // An artifact from before fingerprintConfig existed: a real hash, no configuration.
    const hash = await computeProjectFingerprint(root, { configuration: defaultConfig() });
    await writeFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({ hash, computedAt: new Date().toISOString() }));

    const state = await openloreIndexState({ rootPath: root });

    // Even though the tree is genuinely unchanged, an unassessable index is not claimed to match.
    expect(state.matchesWorkingTree).toBe(false);
    expect(state.reason).toBe('config-unrecorded');
    expect(state.fingerprint).toBe(hash);
  });

  it('a real analysis records the configuration it fingerprinted under, and the read agrees', async () => {
    const root = await workspace();
    await openloreInit({ rootPath: root });
    await openloreAnalyze({ rootPath: root, excludePatterns: ['vendor/**'] });

    const artifact = JSON.parse(
      await readFile(join(root, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT), 'utf-8'),
    ) as { fingerprintConfig?: Config };

    // The per-invocation --exclude survives into the artifact; without it the read below could not
    // reproduce this hash.
    expect(artifact.fingerprintConfig?.excludePatterns).toContain('vendor/**');

    const state = await openloreIndexState({ rootPath: root });
    expect(state.matchesWorkingTree).toBe(true);
  }, 60_000);

  it('writes nothing', async () => {
    const root = await workspace();
    await baseline(root, defaultConfig());
    const artifact = join(root, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT);
    const before = await readFile(artifact, 'utf-8');

    await openloreIndexState({ rootPath: root });

    expect(await readFile(artifact, 'utf-8')).toBe(before);
  });
});
