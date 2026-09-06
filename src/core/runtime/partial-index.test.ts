import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PARTIAL_REQUIRED_ARTIFACTS,
  PARTIAL_STAMP_MAX_AGE_MS,
  clearPartialIndex,
  describePartialIndex,
  flushPartialIndex,
  partialCompletenessPercent,
  partialIndexDirOf,
  partialStampPathOf,
  readPartialArtifact,
  readPartialIndexStamp,
  refreshPartialIndexStamp,
  type PartialIndexStamp,
} from './partial-index.js';

let root: string;
let analysisDir: string;

function stampOf(overrides: Partial<PartialIndexStamp> = {}): PartialIndexStamp {
  return {
    partial: true,
    phase: 'dependency-graph',
    filesExtracted: 0,
    filesTotal: 120,
    filesMapped: 118,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    absent: ['the call graph'],
    ...overrides,
  };
}

async function flush(stamp = stampOf()): Promise<boolean> {
  return flushPartialIndex(analysisDir, {
    repoStructure: { projectName: 'demo' },
    llmContext: { phase1_survey: { purpose: 'partial', files: [] }, partial: stamp },
    dependencyGraph: { statistics: { nodeCount: 3 } },
    stamp,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-partial-'));
  analysisDir = join(root, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('partial first-run index', () => {
  it('lives outside the analysis directory so no artifact reader can see it', async () => {
    expect(await flush()).toBe(true);

    // The single structural guarantee the whole design rests on: everything the
    // exporter, the attester, the fingerprint and the generation manifest read is
    // under `analysisDir`, and none of it moved.
    expect(partialIndexDirOf(analysisDir).startsWith(analysisDir)).toBe(false);
    expect(existsSync(join(analysisDir, 'llm-context.json'))).toBe(false);
    expect(existsSync(join(analysisDir, 'repo-structure.json'))).toBe(false);
    expect(existsSync(join(analysisDir, 'generation.json'))).toBe(false);
    expect(existsSync(join(analysisDir, 'fingerprint.json'))).toBe(false);
  });

  it('never publishes a fingerprint, so a partial index cannot answer "is this tree analyzed?"', async () => {
    await flush();
    expect([...PARTIAL_REQUIRED_ARTIFACTS]).not.toContain('fingerprint.json');
    expect(existsSync(join(partialIndexDirOf(analysisDir), 'fingerprint.json'))).toBe(false);
  });

  it('serves a committed artifact and reports the stamp', async () => {
    const stamp = stampOf({ phase: 'extractors', filesMapped: 90, filesTotal: 100 });
    await flush(stamp);

    const live = await readPartialIndexStamp(analysisDir);
    expect(live?.phase).toBe('extractors');
    expect(partialCompletenessPercent(live!)).toBe(50);

    const raw = await readPartialArtifact(analysisDir, 'llm-context.json');
    expect(JSON.parse(raw!).partial.partial).toBe(true);
  });

  it('refuses an artifact whose bytes no longer match the published commit', async () => {
    await flush();
    const contextPath = join(partialIndexDirOf(analysisDir), 'llm-context.json');
    await writeFile(contextPath, JSON.stringify({ tampered: true }), 'utf8');

    expect(await readPartialArtifact(analysisDir, 'llm-context.json')).toBeNull();
  });

  it('refuses artifacts that were written but never committed', async () => {
    const dir = partialIndexDirOf(analysisDir);
    await mkdir(dir, { recursive: true });
    for (const name of PARTIAL_REQUIRED_ARTIFACTS) {
      await writeFile(join(dir, name), JSON.stringify({ smuggled: true }), 'utf8');
    }
    await writeFile(partialStampPathOf(analysisDir), JSON.stringify(stampOf()), 'utf8');

    // The stamp parses, but no generation was published: the bytes are unattested.
    expect(await readPartialIndexStamp(analysisDir)).not.toBeNull();
    expect(await readPartialArtifact(analysisDir, 'llm-context.json')).toBeNull();
  });

  it('abandons a partial index whose owning process is gone', async () => {
    // PID 2^22 is above every default pid_max; nothing is running there.
    await flush(stampOf({ pid: 4_194_303 }));
    expect(await readPartialIndexStamp(analysisDir)).toBeNull();
  });

  it('abandons a partial index whose owner stopped re-stamping', async () => {
    const stale = new Date(Date.now() - PARTIAL_STAMP_MAX_AGE_MS - 60_000).toISOString();
    await flush(stampOf({ updatedAt: stale }));
    expect(await readPartialIndexStamp(analysisDir)).toBeNull();
  });

  it('rejects a malformed stamp rather than serving from it', async () => {
    await flush();
    await writeFile(partialStampPathOf(analysisDir), '{"partial":true,"phase":"nonsense"}', 'utf8');
    expect(await readPartialIndexStamp(analysisDir)).toBeNull();
  });

  it('re-stamps the phase without invalidating the published commit', async () => {
    await flush();
    const before = await readPartialArtifact(analysisDir, 'llm-context.json');

    await refreshPartialIndexStamp(analysisDir, { phase: 'artifacts' });

    const after = await readPartialIndexStamp(analysisDir);
    expect(after?.phase).toBe('artifacts');
    expect(partialCompletenessPercent(after!)).toBe(75);
    // The stamp is not part of the generation, so the artifacts stay committed.
    expect(await readPartialArtifact(analysisDir, 'llm-context.json')).toBe(before);
  });

  it('does not resurrect a stamp for an index that was never flushed', async () => {
    await refreshPartialIndexStamp(analysisDir, { phase: 'artifacts' });
    expect(existsSync(partialStampPathOf(analysisDir))).toBe(false);
  });

  it('clears the whole partial index once a real analysis supersedes it', async () => {
    await flush();
    expect(existsSync(partialIndexDirOf(analysisDir))).toBe(true);

    await clearPartialIndex(analysisDir);

    expect(existsSync(partialIndexDirOf(analysisDir))).toBe(false);
    expect(await readPartialIndexStamp(analysisDir)).toBeNull();
  });

  it('discloses completeness, the ordering, and invisible-not-absent', async () => {
    const text = describePartialIndex(stampOf({ phase: 'extractors', filesMapped: 90, filesTotal: 100 }));
    expect(text).toContain('50% complete');
    expect(text).toContain('90 of 100 files mapped');
    expect(text).toContain('significance-ordered');
    expect(text).toContain('INVISIBLE to this answer, not absent from the repository');
    expect(text).toContain('not authoritative');
  });

  it('is fail-soft: an unwritable location produces no index and no throw', async () => {
    // A file where the partial directory must go. mkdir cannot create through it.
    const runtimeDir = join(root, '.openlore', 'runtime');
    await writeFile(runtimeDir, 'not a directory', 'utf8');

    await expect(flush()).resolves.toBe(false);
    await expect(readPartialIndexStamp(analysisDir)).resolves.toBeNull();
    expect(await readFile(runtimeDir, 'utf8')).toBe('not a directory');
  });
});
