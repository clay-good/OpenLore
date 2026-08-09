import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStaleServingDisclosure,
  checkCitedFileFreshness,
  collectCitedSourceFiles,
  resolveFileFreshness,
} from './freshness.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-freshness-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'openlore-freshness-outside-')));
  mkdirSync(join(root, '.openlore', 'analysis'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.openlore', 'analysis', 'llm-context.json'), '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('resolveFileFreshness', () => {
  it('treats a matching recorded hash as authoritative despite a newer mtime', () => {
    expect(resolveFileFreshness({
      baselineFileHash: 'same', currentFileHash: 'same', sourceMtimeMs: 300, artifactMtimeMs: 100,
    })).toBe('fresh');
  });

  it('treats a mismatched recorded hash as stale despite an older mtime', () => {
    expect(resolveFileFreshness({
      baselineFileHash: 'before', currentFileHash: 'after', sourceMtimeMs: 100, artifactMtimeMs: 300,
    })).toBe('stale');
  });

  it('falls back to source-vs-artifact mtime when no hash was recorded', () => {
    expect(resolveFileFreshness({
      baselineFileHash: null, currentFileHash: '', sourceMtimeMs: 100, artifactMtimeMs: 200,
    })).toBe('fresh');
    expect(resolveFileFreshness({
      baselineFileHash: null, currentFileHash: '', sourceMtimeMs: 300, artifactMtimeMs: 200,
    })).toBe('stale');
  });
});

describe('checkCitedFileFreshness', () => {
  it('checks only deduplicated cited files and uses their recorded hashes', async () => {
    writeFileSync(join(root, 'src', 'fresh.ts'), 'fresh');
    writeFileSync(join(root, 'src', 'stale.ts'), 'changed');
    writeFileSync(join(root, 'src', 'uncited.ts'), 'changed but irrelevant');
    const getFileHash = vi.fn((filePath: string) => ({
      'src/fresh.ts': sha256('fresh'),
      'src/stale.ts': sha256('before'),
      'src/uncited.ts': sha256('before'),
    }[filePath] ?? null));

    const result = await checkCitedFileFreshness(
      root,
      ['src/fresh.ts', 'src/./fresh.ts', 'src/stale.ts'],
      { edgeStore: { getFileHash }, artifactMtimeMs: 0 },
    );

    expect(result).toEqual({ staleFiles: ['src/stale.ts'] });
    expect(getFileHash.mock.calls.map(([p]) => p)).toEqual(['src/fresh.ts', 'src/stale.ts']);
    expect(getFileHash).not.toHaveBeenCalledWith('src/uncited.ts');
  });

  it('uses the supplied artifact generation mtime for the no-hash fallback', async () => {
    writeFileSync(join(root, 'src', 'old.ts'), 'old');
    writeFileSync(join(root, 'src', 'new.ts'), 'new');
    utimesSync(join(root, 'src', 'old.ts'), 100, 100);
    utimesSync(join(root, 'src', 'new.ts'), 300, 300);

    const result = await checkCitedFileFreshness(
      root,
      ['src/old.ts', 'src/new.ts'],
      { artifactMtimeMs: 200_000 },
    );

    expect(result.staleFiles).toEqual(['src/new.ts']);
  });

  it('marks missing and non-file citations stale', async () => {
    mkdirSync(join(root, 'src', 'directory.ts'));
    const result = await checkCitedFileFreshness(
      root,
      ['src/missing.ts', 'src/directory.ts'],
      { artifactMtimeMs: Number.MAX_SAFE_INTEGER },
    );
    expect(result.staleFiles).toEqual(['src/missing.ts', 'src/directory.ts']);
  });

  it('fails safe when the hash store cannot read a cited baseline', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'a');
    const result = await checkCitedFileFreshness(root, ['src/a.ts'], {
      edgeStore: { getFileHash: () => { throw new Error('store unavailable'); } },
      artifactMtimeMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result.staleFiles).toEqual(['src/a.ts']);
  });

  it('checks every citation across bounded worker batches without omission', async () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    for (const file of files) writeFileSync(join(root, file), 'changed');
    const result = await checkCitedFileFreshness(root, files, {
      edgeStore: { getFileHash: () => sha256('before') },
      artifactMtimeMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result.staleFiles).toEqual(files);
  });

  it('never reads absolute, traversal, or symlink-escape citations', async () => {
    writeFileSync(join(outside, 'secret.ts'), 'outside');
    symlinkSync(outside, join(root, 'src', 'escape'));
    const getFileHash = vi.fn(() => sha256('outside'));

    const result = await checkCitedFileFreshness(
      root,
      ['/tmp/outside.ts', '../../outside.ts', 'src/escape/secret.ts'],
      { edgeStore: { getFileHash }, artifactMtimeMs: Number.MAX_SAFE_INTEGER },
    );

    expect(result.staleFiles).toEqual(['[unsafe cited path]', 'src/escape/secret.ts']);
    expect(getFileHash).not.toHaveBeenCalled();
  });

  it('falls safe to stale when the artifact mtime cannot be read', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'a');
    const result = await checkCitedFileFreshness(root, ['src/a.ts'], {
      artifactPath: join(root, '.openlore', 'analysis', 'missing.json'),
    });
    expect(result.staleFiles).toEqual(['src/a.ts']);
  });
});

describe('collectCitedSourceFiles', () => {
  it('collects, normalizes, and deduplicates only source file/filePath citations', () => {
    const payload = {
      file: 'src/./a.ts',
      children: [
        { filePath: 'src/a.ts' },
        { file: 'src/b.py' },
        { filePath: 'deploy/app.yaml' },
        { filePath: 'web/page.html' },
        { filePath: 'openspec/specs/auth/spec.md' },
        { file: 'external' },
        { callerFile: 'src/not-collected.ts' },
        { file: '../../outside.ts' },
      ],
    };
    expect(collectCitedSourceFiles(payload)).toEqual({
      files: ['src/a.ts', 'src/b.py', 'deploy/app.yaml', 'web/page.html'],
      truncated: false,
    });
  });

  it('caps returned citations and terminates safely on cycles', () => {
    const cyclic: { file: string; children?: unknown[] } = { file: 'src/a.ts' };
    cyclic.children = [cyclic, { filePath: 'src/b.ts' }, { file: 'src/c.ts' }];
    expect(collectCitedSourceFiles(cyclic, 2)).toEqual({
      files: ['src/a.ts', 'src/b.ts'],
      truncated: true,
    });
  });

  it('returns an empty bounded result when max is zero', () => {
    expect(collectCitedSourceFiles({ file: 'src/a.ts' }, 0)).toEqual({
      files: [],
      truncated: true,
    });
  });
});

describe('buildStaleServingDisclosure', () => {
  it('is absent for a fresh answer and factual for stale files', () => {
    expect(buildStaleServingDisclosure([])).toBeUndefined();
    expect(buildStaleServingDisclosure(['src/payments.ts', 'src/payments.ts'])).toEqual({
      staleFiles: ['src/payments.ts'],
      note: expect.stringMatching(/"src\/payments\.ts".*may omit recent edits/i),
    });
  });

  it('sorts, escapes, and bounds filenames in the human note while retaining the full list', () => {
    const files = [
      'src/z.ts',
      'src/a\nforged.ts',
      ...Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`),
    ];
    const disclosure = buildStaleServingDisclosure(files)!;
    expect(disclosure.staleFiles).toEqual(files);
    expect(disclosure.note).toContain('"src/a\\nforged.ts"');
    expect(disclosure.note).not.toContain('src/a\nforged.ts');
    expect(disclosure.note).toContain('and 2 more');
    expect(disclosure.note.indexOf('src/a\\nforged.ts')).toBeLessThan(disclosure.note.indexOf('src/f0.ts'));
    expect(disclosure.note).not.toContain('src/z.ts');
  });

  it('claims scheduling only when the caller confirms a repair path accepted it', () => {
    expect(buildStaleServingDisclosure(['src/payments.ts'], true)).toMatchObject({
      repairScheduled: true,
      note: expect.stringMatching(/repair has been scheduled/i),
    });
    expect(buildStaleServingDisclosure(['src/payments.ts'], false)).not.toHaveProperty('repairScheduled');
  });
});
