import { describe, expect, it } from 'vitest';
import { buildDomainEvidence, partitionEvidenceFiles } from './domain-evidence.js';
import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';

describe('buildDomainEvidence', () => {
  it('keeps deterministic roles within domains and adds unassigned signature files', () => {
    const repo = {
      domains: [{ name: 'billing', files: ['src/invoice.ts', 'src/routes.ts'], entities: [], keyFile: null, suggestedSpecPath: '' }],
      schemas: [{ name: 'Invoice', file: 'src/invoice.ts', line: 1, orm: 'prisma', fields: [] }],
      routeInventory: { total: 1, byMethod: {}, byFramework: {}, routes: [{ method: 'GET', path: '/invoices', file: 'src/routes.ts', framework: 'express', handler: 'list', contractSource: 'none' }] },
      undomained: [],
    } as unknown as RepoStructure;
    const context = { signatures: [
      { path: 'src/invoice.ts', language: 'TypeScript', entries: [] },
      { path: 'src/helper.ts', language: 'TypeScript', entries: [] },
    ] } as unknown as LLMContext;

    expect(buildDomainEvidence(repo, context)).toMatchObject([
      { name: 'billing', schemaFiles: ['src/invoice.ts'], apiFiles: ['src/routes.ts'], serviceFiles: [] },
      { name: 'undomained', files: ['src/helper.ts'], serviceFiles: ['src/helper.ts'] },
    ]);
  });
});

describe('partitionEvidenceFiles', () => {
  it('partitions oversized evidence at stable file boundaries', () => {
    const partitions = partitionEvidenceFiles([
      { path: 'b.ts', content: 'bbbb' },
      { path: 'a.ts', content: 'aaaa' },
      { path: 'c.ts', content: 'cccc' },
    ], 33);
    expect(partitions.map(files => files.map(file => file.path))).toEqual([
      ['a.ts', 'b.ts'], ['c.ts'],
    ]);
  });

  it('bounds an individually oversized file deterministically', () => {
    const [partition] = partitionEvidenceFiles([{ path: 'large.ts', content: 'x'.repeat(500) }], 80);
    expect(partition[0].content.length + partition[0].path.length + 8).toBeLessThanOrEqual(80);
    expect(partition[0].content).toContain('truncated deterministic evidence');
  });
});
