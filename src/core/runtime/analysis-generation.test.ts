import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GENERATION_MANIFEST_FILE,
  REQUIRED_ANALYSIS_ARTIFACTS,
  discardGeneration,
  publishGeneration,
  readCurrentGeneration,
  readGenerationSnapshot,
} from './analysis-generation.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const required = [...REQUIRED_ANALYSIS_ARTIFACTS];

async function analysisDir(contents: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-generation-'));
  roots.push(root);
  const dir = join(root, '.openlore', 'analysis');
  await mkdir(dir, { recursive: true });
  for (const name of required) {
    await writeFile(join(dir, name), contents[name] ?? JSON.stringify({ name, v: 1 }), 'utf8');
  }
  return dir;
}

describe('publishGeneration', () => {
  it('binds every required artifact to one identity and content digest', async () => {
    const dir = await analysisDir();
    const manifest = await publishGeneration(dir, required);

    expect(manifest).not.toBeNull();
    expect(manifest!.compatibility).toBe('manifest');
    expect(manifest!.artifacts.map(entry => entry.path).sort()).toEqual([...required].sort());
    for (const entry of manifest!.artifacts) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
    }
  });

  it('refuses to publish when a required artifact is missing', async () => {
    const dir = await analysisDir();
    await rm(join(dir, 'dependency-graph.json'));
    expect(await publishGeneration(dir, required)).toBeNull();
    // No manifest was written, so the previous state is untouched.
    await expect(readFile(join(dir, GENERATION_MANIFEST_FILE), 'utf8')).rejects.toThrow();
  });

  it('gives each publication a distinct identity even for identical content', async () => {
    const dir = await analysisDir();
    const first = await publishGeneration(dir, required);
    const second = await publishGeneration(dir, required);
    expect(second!.generationId).not.toBe(first!.generationId);
  });
});

describe('readCurrentGeneration', () => {
  it('reads a published manifest', async () => {
    const dir = await analysisDir();
    const published = await publishGeneration(dir, required);
    const current = await readCurrentGeneration(dir, required);
    expect(current?.generationId).toBe(published!.generationId);
  });

  it('synthesizes a DISCLOSED legacy identity for a pre-manifest analysis', async () => {
    const dir = await analysisDir();
    const current = await readCurrentGeneration(dir, required);
    expect(current?.compatibility).toBe('legacy');
    expect(current?.generationId).toMatch(/^legacy-/);
  });

  it('changes the legacy identity when an artifact is rewritten', async () => {
    const dir = await analysisDir();
    const before = await readCurrentGeneration(dir, required);
    await writeFile(join(dir, 'llm-context.json'), JSON.stringify({ changed: true, padding: 'x'.repeat(64) }), 'utf8');
    const after = await readCurrentGeneration(dir, required);
    expect(after?.generationId).not.toBe(before?.generationId);
  });

  it('returns null when there is no analysis at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-generation-empty-'));
    roots.push(root);
    expect(await readCurrentGeneration(root, required)).toBeNull();
  });

  it('falls back to legacy rather than trusting a corrupt manifest', async () => {
    const dir = await analysisDir();
    await publishGeneration(dir, required);
    await writeFile(join(dir, GENERATION_MANIFEST_FILE), '{not json', 'utf8');
    const current = await readCurrentGeneration(dir, required);
    expect(current?.compatibility).toBe('legacy');
  });
});

describe('readGenerationSnapshot', () => {
  it('returns the read value bound to the generation it was read under', async () => {
    const dir = await analysisDir();
    const published = await publishGeneration(dir, required);

    const snapshot = await readGenerationSnapshot(dir, required, async () => 'evidence');
    expect(snapshot).toMatchObject({
      state: 'ok', value: 'evidence', generationId: published!.generationId, compatibility: 'manifest',
    });
  });

  it('never accepts a mixture: a publication mid-read yields analysis-changed', async () => {
    const dir = await analysisDir();
    await publishGeneration(dir, required);

    // Every read is interrupted by a new publication, so no attempt can validate.
    const snapshot = await readGenerationSnapshot(dir, required, async () => {
      await publishGeneration(dir, required);
      return 'possibly-mixed';
    });
    expect(snapshot.state).toBe('analysis-changed');
  });

  it('rejects an in-place overwrite that has not published its manifest yet', async () => {
    // The gap the identity check alone cannot see: a full analyze overwrites the
    // artifacts and publishes LAST, so during that window the manifest is still the
    // old one. Both identity reads agree while the bytes underneath have already
    // changed — a mixture that used to be labelled `ok`.
    const dir = await analysisDir();
    await publishGeneration(dir, required);

    const snapshot = await readGenerationSnapshot(dir, required, async () => {
      await writeFile(join(dir, required[0]), JSON.stringify({ rewritten: true }), 'utf8');
      return 'read-across-an-overwrite';
    });
    expect(snapshot.state).toBe('analysis-changed');
  });

  it('accepts a read whose artifacts are byte-identical throughout', async () => {
    const dir = await analysisDir();
    await publishGeneration(dir, required);
    // Rewriting the SAME bytes is not a change: the digest still matches, so this
    // must not degrade into a spurious analysis-changed.
    const original = await readFile(join(dir, required[0]), 'utf8');
    const snapshot = await readGenerationSnapshot(dir, required, async () => {
      await writeFile(join(dir, required[0]), original, 'utf8');
      return 'stable';
    });
    expect(snapshot).toMatchObject({ state: 'ok', value: 'stable' });
  });

  it('retries once and succeeds when only the first attempt was interrupted', async () => {
    const dir = await analysisDir();
    await publishGeneration(dir, required);

    let attempt = 0;
    const snapshot = await readGenerationSnapshot(dir, required, async () => {
      attempt++;
      if (attempt === 1) await publishGeneration(dir, required);
      return `attempt-${attempt}`;
    });
    expect(snapshot).toMatchObject({ state: 'ok', value: 'attempt-2' });
  });

  it('reports unavailable rather than changed when there is no analysis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-generation-none-'));
    roots.push(root);
    const snapshot = await readGenerationSnapshot(root, required, async () => 'never');
    expect(snapshot.state).toBe('analysis-unavailable');
  });

  it('keeps serving the previous generation after an interrupted publication', async () => {
    const dir = await analysisDir();
    const committed = await publishGeneration(dir, required);

    // A replacement analysis writes artifacts but dies before publishing.
    await writeFile(join(dir, 'llm-context.json'), JSON.stringify({ halfWritten: true }), 'utf8');

    const current = await readCurrentGeneration(dir, required);
    expect(current?.generationId).toBe(committed!.generationId);
    expect(current?.compatibility).toBe('manifest');
  });

  it('degrades to legacy when the manifest is discarded', async () => {
    const dir = await analysisDir();
    await publishGeneration(dir, required);
    await discardGeneration(dir);
    expect((await readCurrentGeneration(dir, required))?.compatibility).toBe('legacy');
  });
});

describe('legacy identity stability', () => {
  it('is stable while nothing changes', async () => {
    const dir = await analysisDir();
    const first = await readCurrentGeneration(dir, required);
    const second = await readCurrentGeneration(dir, required);
    expect(second?.generationId).toBe(first?.generationId);
  });

  it('changes when an artifact mtime advances', async () => {
    const dir = await analysisDir();
    const before = await readCurrentGeneration(dir, required);
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, 'repo-structure.json'), later, later);
    const after = await readCurrentGeneration(dir, required);
    expect(after?.generationId).not.toBe(before?.generationId);
  });
});
