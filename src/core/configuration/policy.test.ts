import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWalker } from '../analyzer/file-walker.js';
import { FilePolicyResolver } from './policy.js';
import { ConfigurationWatchPolicy } from './watch-policy.js';
import { analysisConfigFingerprintInput } from '../analyzer/analysis-core.js';
const rules = [
  {
    id: 'output',
    pattern: 'generated/',
    lanes: { index: 'exclude' as const, watch: 'exclude' as const, embed: 'exclude' as const },
    reason: 'Generated output',
  },
  {
    id: 'exception',
    pattern: 'generated/keep/**',
    lanes: { index: 'include' as const, embed: 'include' as const },
    reason: 'Deliberate source exception',
  },
];
describe('shared configuration lane policies', () => {
  it('keeps index exceptions independent from watches and enforces protected/legacy boundaries', () => {
    const resolver = new FilePolicyResolver({ rules }, ['secret/']);
    expect(resolver.admitted('generated/keep/main.ts', 'index', true)).toBe(true);
    expect(resolver.admitted('generated/keep/main.ts', 'watch', true)).toBe(false);
    expect(resolver.admitted('generated/other.ts', 'embed', true)).toBe(false);
    expect(resolver.admitted('generated/keep/main.ts', 'embed', false)).toBe(false);
    expect(resolver.admitted('secret/token.ts', 'index', true)).toBe(false);
  });
  it('retains legacy fingerprints and separates lane revisions', () => {
    const legacy = analysisConfigFingerprintInput(undefined, [], [], 100);
    expect(analysisConfigFingerprintInput(undefined, [], [], 100, [], { rules: [] })).toEqual(
      legacy
    );
    const watch = {
      rules: [
        {
          id: 'watch',
          pattern: 'output/',
          lanes: { watch: 'exclude' as const },
          reason: 'Watch choice',
        },
      ],
    };
    expect(analysisConfigFingerprintInput(undefined, [], [], 100, [], watch)).toEqual(legacy);
    expect(new FilePolicyResolver(watch).revisionFor('index')).toBe(
      new FilePolicyResolver().revisionFor('index')
    );
  });
  it('prunes output watches while retaining only the deliberate index exception', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ol-policy-'));
    try {
      await mkdir(join(root, 'generated/keep'), { recursive: true });
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'generated/keep/main.ts'), 'export const kept = 1;');
      await writeFile(join(root, 'generated/other.ts'), 'export const excluded = 1;');
      await writeFile(join(root, 'src/main.ts'), 'export const main = 1;');
      const files = (await new FileWalker(root, { filePolicies: { rules } }).walk()).files.map(
        (f) => f.path
      );
      expect(files).toContain('generated/keep/main.ts');
      expect(files).not.toContain('generated/other.ts');
      const watcher = new ConfigurationWatchPolicy(root, new FilePolicyResolver({ rules }));
      expect(watcher.admitted('generated', true)).toBe(false);
      expect(watcher.admitted('src', true)).toBe(true);
      await writeFile(join(root, '.gitignore'), 'ignored/\n');
      watcher.invalidate();
      expect(watcher.admitted('ignored', true)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('non-watched input freshness', () => {
  it('detects changed indexed content even when its watch lane is excluded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ol-unwatched-freshness-'));
    try {
      const { getDefaultConfig } = await import('../services/config-manager.js');
      const { computeProjectFingerprint } = await import('../services/mcp-handlers/utils.js');
      const { openloreIndexState } = await import('../../api/index-state.js');
      const output = join(root, '.openlore/analysis');
      await mkdir(output, { recursive: true });
      await mkdir(join(root, 'quiet'));
      const policies = {
        rules: [
          {
            id: 'quiet',
            pattern: 'quiet/',
            lanes: { watch: 'exclude' as const },
            reason: 'Operator watch choice',
          },
        ],
      };
      const config = { ...getDefaultConfig('nodejs', 'openspec'), filePolicies: policies };
      await writeFile(join(root, '.openlore/config.json'), JSON.stringify(config));
      await writeFile(join(root, 'quiet/main.ts'), 'export const value=1;');
      const fingerprintConfig = analysisConfigFingerprintInput(
        config.analysis,
        [],
        [],
        100,
        [],
        policies
      );
      const hash = await computeProjectFingerprint(root, { configuration: fingerprintConfig });
      await writeFile(
        join(output, 'fingerprint.json'),
        JSON.stringify({ hash, fingerprintConfig })
      );
      expect((await openloreIndexState({ rootPath: root })).matchesWorkingTree).toBe(true);
      await writeFile(join(root, 'quiet/main.ts'), 'export const value=2;');
      expect(await openloreIndexState({ rootPath: root })).toMatchObject({
        matchesWorkingTree: false,
        reason: 'fingerprint-mismatch',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
