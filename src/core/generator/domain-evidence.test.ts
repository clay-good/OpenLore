import { describe, expect, it } from 'vitest';
import { buildDomainEvidence, partitionEvidenceFiles, resolveDomainSelection } from './domain-evidence.js';
import type { LLMContext, RepoStructure } from '../analyzer/artifact-generator.js';

describe('buildDomainEvidence', () => {
  it('keeps deterministic roles within domains and adds unassigned signature files', () => {
    const repo = {
      domains: [{ name: 'billing', files: ['src/invoice.ts', 'src/routes.ts'], entities: [], keyFile: null, suggestedSpecPath: '' }],
      schemas: [{ name: 'Invoice', file: 'src/invoice.ts', line: 1, orm: 'prisma', fields: [] }],
      routeInventory: { total: 1, byMethod: {}, byFramework: {}, routes: [{ method: 'GET', path: '/invoices', file: 'src/routes.ts', framework: 'express', handler: 'list', contractSource: 'none' }] },
      undomained: [],
    } as unknown as RepoStructure;
    const context = {
      phase2_deep: { files: [{ path: 'src/no-signature.ts', content: '', tokens: 0 }] },
      signatures: [
        { path: 'src/invoice.ts', language: 'TypeScript', entries: [] },
        { path: 'src/helper.ts', language: 'TypeScript', entries: [] },
      ],
    } as unknown as LLMContext;

    expect(buildDomainEvidence(repo, context)).toMatchObject([
      { name: 'billing', schemaFiles: ['src/invoice.ts'], apiFiles: ['src/routes.ts'], serviceFiles: [] },
      { name: 'undomained', files: ['src/helper.ts', 'src/no-signature.ts'], serviceFiles: ['src/helper.ts', 'src/no-signature.ts'] },
    ]);
  });

  it('retains attached tests but never reintroduces excluded evidence as undomained', () => {
    const repo = {
      domains: [{
        name: 'generator',
        files: ['src/generator/run.ts', 'src/generator/run.test.ts'],
        definingFiles: ['src/generator/run.ts'],
        supportingFiles: ['src/generator/run.test.ts'],
        entities: [], keyFile: null, suggestedSpecPath: '',
      }],
      undomained: ['src/fixtures/sample.ts', 'test/unattached.test.ts'],
      undomainedEvidence: [
        { path: 'src/fixtures/sample.ts', role: 'excluded', reason: 'fixture-tree' },
        { path: 'test/unattached.test.ts', role: 'supporting', reason: 'test-file' },
      ],
      domainDecisions: [{ candidate: 'stages', path: 'src/generator/stages', sources: ['dependency-cluster'], disposition: 'merged', reason: 'technical-child', owner: 'generator', files: [] }],
      domainDecisionSummary: { total: 1, emitted: 1, omitted: 0, limit: 500, filesPerDecisionLimit: 50 },
    } as unknown as RepoStructure;
    const context = {
      phase2_deep: { files: [
        { path: 'src/fixtures/sample.ts', content: '', tokens: 0 },
        { path: 'test/unattached.test.ts', content: '', tokens: 0 },
      ] },
      signatures: [
        { path: 'src/generator/run.ts', language: 'TypeScript', entries: [] },
        { path: 'src/generator/run.test.ts', language: 'TypeScript', entries: [] },
        { path: 'src/fixtures/sample.ts', language: 'TypeScript', entries: [] },
      ],
    } as unknown as LLMContext;

    expect(buildDomainEvidence(repo, context)).toMatchObject([
      {
        name: 'generator',
        definingFiles: ['src/generator/run.ts'],
        supportingFiles: ['src/generator/run.test.ts'],
        serviceFiles: ['src/generator/run.ts'],
        signatures: [expect.objectContaining({ path: 'src/generator/run.ts' })],
        supportingSignatures: [expect.objectContaining({ path: 'src/generator/run.test.ts' })],
        candidateDecisions: [expect.objectContaining({ candidate: 'stages', owner: 'generator' })],
        candidateDecisionSummary: expect.objectContaining({ omitted: 0, limit: 500 }),
      },
    ]);
  });

  it('does not promote supporting-only evidence into a selectable undomained domain', () => {
    const repo = {
      domains: [], undomained: ['test/helper.test.ts'],
      undomainedEvidence: [{ path: 'test/helper.test.ts', role: 'supporting', reason: 'test-file' }],
    } as unknown as RepoStructure;
    const context = { phase2_deep: { files: [] }, signatures: [] } as unknown as LLMContext;
    expect(buildDomainEvidence(repo, context)).toEqual([]);
  });

  it('resolves punctuation and case canonically and rejects ambiguous identities', () => {
    expect(resolveDomainSelection(['User Accounts', 'Billing'], ['user-accounts'])).toEqual(['user-accounts']);
    expect(() => resolveDomainSelection(['Foo Bar', 'foo-bar'], [])).toThrow(/collide after normalization/);
    expect(() => resolveDomainSelection(['Billing'], ['missing'])).toThrow(/not found/);
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
