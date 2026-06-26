import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGetStyleFingerprint } from './style-fingerprint.js';
import { buildStyleFingerprint, type FileStyleRaw, type LanguageProfile, type IdiomSignal } from '../../analyzer/style-fingerprint.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_STYLE_FINGERPRINT } from '../../../constants.js';

// A synthetic fingerprint: one TS region above the floor, one Go region (binding measured,
// naming enforced → null), plus a thin file below the floor.
const rawFiles: FileStyleRaw[] = [
  { filePath: 'src/a.ts', language: 'TypeScript', counters: { binding: { const: 30, let: 2 }, conditionalForm: { if: 14, ternary: 6 }, functionForm: { arrow: 18, declaration: 2 } }, functionsSampled: 20 },
  { filePath: 'src/b.ts', language: 'TypeScript', counters: { binding: { const: 20, let: 10 } }, functionsSampled: 18 },
  { filePath: 'src/main.go', language: 'Go', counters: { binding: { short: 25, var: 3 }, functionNaming: { PascalCase: 40 } }, functionsSampled: 40 },
  { filePath: 'src/tiny.ts', language: 'TypeScript', counters: { binding: { const: 2 } }, functionsSampled: 1 },
];
const nodes = [
  { filePath: 'src/a.ts', communityId: 'reg1', communityLabel: 'Alpha' },
  { filePath: 'src/b.ts', communityId: 'reg1' },
  { filePath: 'src/main.go', communityId: 'reg2', communityLabel: 'Beta' },
  { filePath: 'src/tiny.ts', communityId: 'reg3' },
];

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openlore-style-'));
  const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(analysisDir, { recursive: true });
  const fp = buildStyleFingerprint(rawFiles, nodes);
  await writeFile(join(analysisDir, ARTIFACT_STYLE_FINGERPRINT), JSON.stringify(fp, null, 2));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tsBinding(byLanguage: LanguageProfile[]): IdiomSignal | undefined {
  return byLanguage.find(p => p.language === 'TypeScript')?.idioms.binding;
}

describe('handleGetStyleFingerprint', () => {
  it('repository scope returns a labeled per-language conclusion, not a graph', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir })) as Record<string, unknown>;
    expect(res.scope).toBe('repository');
    expect(res.languagesAnalyzed).toEqual(['Go', 'TypeScript']);
    // no node-and-edge structure leaked
    expect(res).not.toHaveProperty('nodes');
    expect(res).not.toHaveProperty('edges');
    const b = tsBinding(res.byLanguage as LanguageProfile[]);
    expect(b && 'dominant' in b && b.dominant).toBe('const');
    expect(b && 'samples' in b && b.samples).toBe(64); // a.ts 32 + b.ts 30 + tiny.ts 2 (repo aggregates all TS)
  });

  it('language filter narrows the returned languages', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir, language: 'go' })) as Record<string, unknown>;
    const langs = (res.byLanguage as LanguageProfile[]).map(p => p.language);
    expect(langs).toEqual(['Go']);
    // Go binding measured, naming enforced → null
    const go = (res.byLanguage as LanguageProfile[])[0];
    expect('dominant' in go.idioms.binding! && go.idioms.binding!.dominant).toBe('short');
    expect(go.idioms.functionNaming).toEqual({ signal: null, reason: 'enforced' });
  });

  it('region scope returns one community profile', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir, communityId: 'reg2' })) as Record<string, unknown>;
    expect(res.scope).toBe('region');
    expect(res.communityId).toBe('reg2');
    expect(res.label).toBe('Beta');
    expect((res.byLanguage as LanguageProfile[])[0].language).toBe('Go');
  });

  it('an unknown region is reported with available ids, not a crash', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir, communityId: 'nope' })) as Record<string, unknown>;
    expect(typeof res.error).toBe('string');
    expect(Array.isArray(res.availableRegions)).toBe(true);
  });

  it('file scope rolls a single file up (floor still applies)', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir, filePath: 'src/a.ts' })) as Record<string, unknown>;
    expect(res.scope).toBe('file');
    const profile = res.profile as LanguageProfile;
    expect('dominant' in profile.idioms.binding! && profile.idioms.binding!.dominant).toBe('const');
  });

  it('a unique path suffix resolves a file', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir, filePath: 'main.go' })) as Record<string, unknown>;
    expect(res.scope).toBe('file');
    expect(res.filePath).toBe('src/main.go');
  });

  it('a thin file reports null below the floor (honest, not a fake ratio)', async () => {
    const res = (await handleGetStyleFingerprint({ directory: dir, filePath: 'src/tiny.ts' })) as Record<string, unknown>;
    const profile = res.profile as LanguageProfile;
    expect(profile.idioms.binding).toEqual({ signal: null, reason: 'below_floor' });
  });

  it('missing artifact → guidance error, not a throw', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'openlore-empty-'));
    try {
      const res = (await handleGetStyleFingerprint({ directory: empty })) as Record<string, unknown>;
      expect(typeof res.error).toBe('string');
      expect(res.error).toMatch(/analyze/i);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('a partial/stale artifact (byLanguage present, files/regions/fileRegions missing) fails soft', async () => {
    // Regression: the guard must validate EVERY field the handler dereferences, so a half-written
    // or schema-v0 artifact degrades to the analyze-guidance error rather than a raw TypeError.
    const partialDir = await mkdtemp(join(tmpdir(), 'openlore-partial-'));
    const ad = join(partialDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(ad, { recursive: true });
    await writeFile(join(ad, ARTIFACT_STYLE_FINGERPRINT), JSON.stringify({ evidenceFloor: 12, byLanguage: [] }));
    try {
      for (const args of [{}, { filePath: 'x.ts' }, { communityId: 'c1' }]) {
        const res = (await handleGetStyleFingerprint({ directory: partialDir, ...args })) as Record<string, unknown>;
        expect(typeof res.error, `scope ${JSON.stringify(args)} should error, not throw`).toBe('string');
        expect(res.error).toMatch(/analyze/i);
      }
    } finally {
      await rm(partialDir, { recursive: true, force: true });
    }
  });

  it('an artifact from a future incompatible schema is rejected (not mis-read)', async () => {
    const futureDir = await mkdtemp(join(tmpdir(), 'openlore-future-'));
    const ad = join(futureDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(ad, { recursive: true });
    // Same top-level shape but a newer schemaVersion → must fail soft, not silently mis-read.
    await writeFile(join(ad, ARTIFACT_STYLE_FINGERPRINT), JSON.stringify({
      schemaVersion: 999, evidenceFloor: 12, byLanguage: [], regions: [], files: [], fileRegions: {},
    }));
    try {
      const res = (await handleGetStyleFingerprint({ directory: futureDir })) as Record<string, unknown>;
      expect(typeof res.error).toBe('string');
      expect(res.error).toMatch(/analyze/i);
    } finally {
      await rm(futureDir, { recursive: true, force: true });
    }
  });

  it('truncated/garbage JSON fails soft to the guidance error', async () => {
    const garbageDir = await mkdtemp(join(tmpdir(), 'openlore-garbage-'));
    const ad = join(garbageDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(ad, { recursive: true });
    await writeFile(join(ad, ARTIFACT_STYLE_FINGERPRINT), '{ this is not json');
    try {
      const res = (await handleGetStyleFingerprint({ directory: garbageDir })) as Record<string, unknown>;
      expect(typeof res.error).toBe('string');
    } finally {
      await rm(garbageDir, { recursive: true, force: true });
    }
  });
});
