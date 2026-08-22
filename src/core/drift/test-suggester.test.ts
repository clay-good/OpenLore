import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { suggestTestsForDrift } from './test-suggester.js';
import type { DriftResult } from '../../types/index.js';
import { SOURCE_SCAN_MAX_FILE_BYTES } from '../../constants.js';

const roots: string[] = [];

function driftFor(domain: string): DriftResult {
  return {
    timestamp: '2026-08-22T00:00:00.000Z',
    baseRef: 'main',
    totalChangedFiles: 1,
    analyzedFiles: 1,
    filesOmitted: 0,
    specRelevantFiles: 1,
    issues: [{
      id: `gap:src/example.ts:${domain}`,
      kind: 'gap',
      severity: 'warning',
      message: 'changed without a spec update',
      filePath: 'src/example.ts',
      domain,
      specPath: `openspec/specs/${domain}/spec.md`,
      suggestion: 'review the spec',
    }],
    summary: {
      gaps: 1,
      stale: 0,
      uncovered: 0,
      orphanedSpecs: 0,
      adrGaps: 0,
      adrOrphaned: 0,
      memoryDrifted: 0,
      memoryOrphaned: 0,
      memoryOutOfScope: 0,
      total: 1,
    },
    hasDrift: true,
    duration: 1,
    mode: 'static',
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'test-suggester-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('suggestTestsForDrift', () => {
  it('traverses dotted directories and uses the canonical cross-language test predicate', async () => {
    const root = await tempRoot();
    const testDir = join(root, 'spec-tests', 'v1.2');
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'AuthTests.cs'),
      '// openlore: {"domain":"auth","requirement":"Login","scenario":"success"}\n',
    );

    const suggestion = await suggestTestsForDrift(driftFor('auth'), root, ['spec-tests']);

    expect(suggestion.domains).toEqual([{
      domain: 'auth',
      testFiles: [join('spec-tests', 'v1.2', 'AuthTests.cs')],
      testFileCount: 1,
    }]);
    expect(suggestion.allFiles).toEqual([join('spec-tests', 'v1.2', 'AuthTests.cs')]);
    expect(suggestion.omittedFiles).toBe(0);
  });

  it('reports tagged test files, not scenario tags, in testFileCount', async () => {
    const root = await tempRoot();
    const testDir = join(root, 'spec-tests', 'auth');
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'login.test.ts'),
      [
        '// openlore: {"domain":"auth","requirement":"Login","scenario":"success"}',
        '// openlore: {"domain":"auth","requirement":"Login","scenario":"failure"}',
      ].join('\n'),
    );

    const suggestion = await suggestTestsForDrift(driftFor('auth'), root, ['spec-tests']);

    expect(suggestion.domains[0]).toMatchObject({ testFileCount: 1 });
    expect(suggestion.domains[0]).not.toHaveProperty('scenarioCount');
  });

  it('deduplicates files discovered through overlapping test roots', async () => {
    const root = await tempRoot();
    const testDir = join(root, 'spec-tests', 'v1.2');
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'auth.test.ts'),
      '// openlore: {"domain":"auth","requirement":"Login","scenario":"success"}\n',
    );

    const suggestion = await suggestTestsForDrift(
      driftFor('auth'), root, ['spec-tests', join('spec-tests', 'v1.2')],
    );
    expect(suggestion.domains[0]).toMatchObject({ testFileCount: 1 });
    expect(suggestion.allFiles).toHaveLength(1);
  });

  it('discloses test-looking files that exceed the scan size cap', async () => {
    const root = await tempRoot();
    const testDir = join(root, 'spec-tests');
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'oversized.test.ts'), Buffer.alloc(SOURCE_SCAN_MAX_FILE_BYTES + 1));

    const suggestion = await suggestTestsForDrift(driftFor('auth'), root, ['spec-tests']);
    expect(suggestion.domains).toEqual([]);
    expect(suggestion.allFiles).toEqual([]);
    expect(suggestion.omittedFiles).toBe(1);
  });
});
