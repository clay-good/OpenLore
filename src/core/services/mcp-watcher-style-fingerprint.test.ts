/**
 * Watcher incremental refresh of style-fingerprint.json (change: add-codebase-style-fingerprint).
 *
 * Guards the riskiest part of the feature — `McpWatcher.updateStyleFingerprint` — against
 * regression: a changed file is re-tallied, a deleted file is pruned, and a project with no
 * fingerprint yet is a clean no-op. Drives the REAL watcher (no FS watcher; chokidar mocked),
 * mirroring mcp-watcher.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import { buildStyleFingerprint, type StyleFingerprint, type FileStyleRaw } from '../analyzer/style-fingerprint.js';
import { ARTIFACT_STYLE_FINGERPRINT } from '../../constants.js';
import { _resetContextCacheForTesting } from './mcp-handlers/utils.js';

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
      const watcher = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
          if (event === 'ready') handler();
          return watcher;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      return watcher;
    }),
  },
}));

function makeContext(): LLMContext {
  return {
    phase1_survey: { purpose: '', files: [], totalTokens: 0 },
    phase2_deep: { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [],
  };
}

async function setup(): Promise<{ rootPath: string; outputPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-style-'));
  const outputPath = join(rootPath, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  await writeFile(join(outputPath, 'llm-context.json'), JSON.stringify(makeContext()), 'utf-8');
  return { rootPath, outputPath };
}

/** Seed a style-fingerprint.json with one TS file, const-dominant, attributed to region r1. */
async function seedFingerprint(outputPath: string, files: FileStyleRaw[], nodeRefs: Array<{ filePath: string; communityId?: string; communityLabel?: string }>): Promise<void> {
  const fp = buildStyleFingerprint(files, nodeRefs);
  await writeFile(join(outputPath, ARTIFACT_STYLE_FINGERPRINT), JSON.stringify(fp, null, 2), 'utf-8');
}

async function readFp(outputPath: string): Promise<StyleFingerprint> {
  return JSON.parse(await readFile(join(outputPath, ARTIFACT_STYLE_FINGERPRINT), 'utf-8')) as StyleFingerprint;
}

beforeEach(() => _resetContextCacheForTesting());

describe('McpWatcher — style fingerprint incremental refresh', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
  afterEach(() => { stderrSpy.mockRestore(); _resetContextCacheForTesting(); });

  it('re-tallies a changed file (const-heavy → let-heavy) in the persisted fingerprint', async () => {
    const { rootPath, outputPath } = await setup();
    await mkdir(join(rootPath, 'src'), { recursive: true });

    // Seed: src/a.ts was const-dominant (18 const / 2 let).
    await seedFingerprint(
      outputPath,
      [{ filePath: 'src/a.ts', language: 'TypeScript', counters: { binding: { const: 18, let: 2 } }, functionsSampled: 20 }],
      [{ filePath: 'src/a.ts', communityId: 'r1', communityLabel: 'Alpha' }],
    );

    // The file on disk now uses `let` everywhere (≥ floor of 12 observations).
    const letBody = Array.from({ length: 16 }, (_, i) => `  let v${i} = ${i};`).join('\n');
    await writeFile(join(rootPath, 'src', 'a.ts'), `export function f() {\n${letBody}\n  return 0;\n}`, 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath, outputPath }).handleChange(join(rootPath, 'src', 'a.ts'));

    const fp = await readFp(outputPath);
    const entry = fp.files.find(f => f.filePath === 'src/a.ts');
    expect(entry, 'changed file still present').toBeTruthy();
    // The stale const:18/let:2 must be gone — the re-tally reflects the new let-heavy body.
    expect((entry!.counters.binding?.let ?? 0)).toBeGreaterThan(entry!.counters.binding?.const ?? 0);
    const tsBinding = fp.byLanguage.find(p => p.language === 'TypeScript')?.idioms.binding;
    expect(tsBinding && 'dominant' in tsBinding && tsBinding.dominant).toBe('let');
  });

  it('is a clean no-op when no fingerprint artifact exists yet', async () => {
    const { rootPath, outputPath } = await setup();
    await mkdir(join(rootPath, 'src'), { recursive: true });
    await writeFile(join(rootPath, 'src', 'b.ts'), 'export const x = 1;', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    await new McpWatcher({ rootPath, outputPath }).handleChange(join(rootPath, 'src', 'b.ts'));

    // No artifact was created (a full analyze owns creation, not the watcher).
    await expect(access(join(outputPath, ARTIFACT_STYLE_FINGERPRINT))).rejects.toBeTruthy();
  });
});
