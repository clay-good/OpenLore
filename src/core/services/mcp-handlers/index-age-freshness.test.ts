/**
 * An aged index is stale only when its source changed. Drives the real readCachedContext
 * read path on an on-disk analysis whose artifacts are 48 hours old.
 *
 * Regression: every index older than 24 hours was reported "Served from a stale index" and
 * force-rebuilt, even when the code had not changed in months, and agents that read the
 * note fell back to grep instead of using the (current) index.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readCachedContext,
  computeProjectFingerprint,
  fingerprintHashOfConfiguration,
  _resetContextCacheForTesting,
} from './utils.js';
import { registerRepairBuilder, repairStatusFor, _resetRepairServiceForTesting } from '../cold-start-bootstrap.js';
import { ARTIFACT_FINGERPRINT, ARTIFACT_LLM_CONTEXT, DEFAULT_MAX_FILES, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../../constants.js';

const AGED = new Date(Date.now() - 48 * 60 * 60 * 1000);

/** A repository with one source file and an analysis of it, aged past the 24-hour threshold. */
async function layAgedIndex(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'idx-age-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'tariff.ts'), 'export function computeTariff(kwh: number) { return kwh * 0.12; }\n');
  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(analysisDir, { recursive: true });
  // The configuration a repository without .openlore/config.json is fingerprinted with.
  const configuration = { includePatterns: [], excludePatterns: [], maxFiles: DEFAULT_MAX_FILES };
  await writeFile(join(analysisDir, ARTIFACT_FINGERPRINT), JSON.stringify({
    hash: await computeProjectFingerprint(dir, { configuration }),
    analysisConfigHash: fingerprintHashOfConfiguration(configuration),
  }));
  const context = join(analysisDir, ARTIFACT_LLM_CONTEXT);
  await writeFile(context, JSON.stringify({ callGraph: { nodes: [], edges: [] } }));
  await utimes(context, AGED, AGED);
  return dir;
}

const markerPath = (dir: string): string => join(dir, OPENLORE_DIR, 'runtime', 'freshness-verified.json');

describe('aged index — content decides staleness, not the clock', () => {
  const dirs: string[] = [];
  const repaired: string[] = [];
  afterEach(async () => {
    _resetContextCacheForTesting();
    _resetRepairServiceForTesting();
    repaired.length = 0;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const setup = async (): Promise<string> => {
    _resetRepairServiceForTesting();
    registerRepairBuilder(async (dir) => { repaired.push(resolve(dir)); });
    const dir = await layAgedIndex();
    dirs.push(dir);
    return dir;
  };
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('an aged index over unchanged source is served as current: no rebuild, no stale disclosure', async () => {
    const dir = await setup();
    expect(await readCachedContext(dir)).not.toBeNull();
    await settle();
    expect(repaired).toEqual([]);
    expect(repairStatusFor(dir)).toBeUndefined();
    expect(JSON.parse(await readFile(markerPath(dir), 'utf8'))).toMatchObject({ current: true, verifiedAtMs: expect.any(Number) });
  });

  it('the verification holds for the age window, so later reads do not re-check the source', async () => {
    const dir = await setup();
    await readCachedContext(dir);
    const first = await readFile(markerPath(dir), 'utf8');
    _resetContextCacheForTesting(); // a new process (one-shot hook) reads from cold
    await readCachedContext(dir);
    await settle();
    expect(await readFile(markerPath(dir), 'utf8')).toBe(first);
    expect(repaired).toEqual([]);
  });

  it('an aged index whose source changed still triggers the background repair', async () => {
    const dir = await setup();
    await writeFile(join(dir, 'src', 'tariff.ts'), 'export function computeTariff(kwh: number) { return kwh * 0.15; }\n');
    await readCachedContext(dir);
    await settle();
    expect(repaired).toEqual([resolve(dir)]);
  });

  it('a verification recorded for an earlier analysis does not vouch for this one', async () => {
    const dir = await setup();
    await mkdir(join(dir, OPENLORE_DIR, 'runtime'), { recursive: true });
    await writeFile(markerPath(dir), JSON.stringify({ artifactMtimeMs: 1, verifiedAtMs: Date.now() }));
    await writeFile(join(dir, 'src', 'tariff.ts'), 'export const changed = true;\n');
    await readCachedContext(dir);
    await settle();
    expect(repaired).toEqual([resolve(dir)]);
  });

  it('a source found changed is recorded, so later reads repair without hashing again', async () => {
    const dir = await setup();
    await writeFile(join(dir, 'src', 'tariff.ts'), 'export const changed = true;\n');
    await readCachedContext(dir);
    const first = await readFile(markerPath(dir), 'utf8');
    expect(JSON.parse(first)).toMatchObject({ current: false });
    _resetContextCacheForTesting();
    _resetRepairServiceForTesting(); // a new process
    registerRepairBuilder(async (d) => { repaired.push(resolve(d)); });
    await readCachedContext(dir);
    await settle();
    expect(await readFile(markerPath(dir), 'utf8')).toBe(first);
    expect(repaired).toEqual([resolve(dir), resolve(dir)]);
  });

  it('where no repair could follow, the source is not hashed at all', async () => {
    _resetRepairServiceForTesting(); // no builder registered (plain CLI commands, tests)
    const dir = await layAgedIndex();
    dirs.push(dir);
    await readCachedContext(dir);
    await expect(readFile(markerPath(dir), 'utf8')).rejects.toThrow();
  });
});
