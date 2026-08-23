import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCorpusIntegrity } from './doctor.js';
import { collectGovernanceFindings } from './enforce.js';
import {
  CORPUS_EDGE_KINDS,
  CORPUS_EDGE_REGISTRY,
  CORPUS_DISCOVERY_EDGE_KINDS,
  CORPUS_FINDING_CODES,
} from '../../core/decisions/corpus-integrity.js';
import { isKnownFindingCode } from '../../core/services/mcp-handlers/enforcement-policy.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(spec: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-corpus-surfaces-'));
  roots.push(root);
  const dir = join(root, 'openspec', 'specs', 'example');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'spec.md'), spec, 'utf8');
  return root;
}

describe('knowledge-corpus integrity surfaces', () => {
  it('keeps the edge and finding registries closed', () => {
    expect(Object.keys(CORPUS_EDGE_REGISTRY).sort()).toEqual([...CORPUS_EDGE_KINDS].sort());
    expect([...new Set(Object.values(CORPUS_DISCOVERY_EDGE_KINDS).flat())].sort())
      .toEqual([...CORPUS_EDGE_KINDS].sort());
    expect(CORPUS_FINDING_CODES.every(isKnownFindingCode)).toBe(true);
  });

  it('doctor reports unresolved declared references as corpus errors', async () => {
    const root = await fixture([
      '# Example Specification',
      '',
      '## Requirements',
      '',
      '### Requirement: Example',
      '',
      '> Decision recorded: deadbeef',
      '',
      'The system SHALL work.',
      '',
    ].join('\n'));

    const result = await checkCorpusIntegrity(root);

    expect(result.status).toBe('fail');
    expect(result.findings?.map((finding) => finding.code)).toContain('corpus-reference-unresolved');
  });

  it('enforce collects the same corpus finding set and marks every code assessed', async () => {
    const root = await fixture([
      '# Example Specification',
      '',
      '## Requirements',
      '',
      '### Requirement: Example',
      '',
      '> Decision recorded: deadbeef',
      '',
    ].join('\n'));

    const result = await collectGovernanceFindings(root, null, {});

    expect(result.findings.map((finding) => finding.code)).toContain('corpus-reference-unresolved');
    expect(CORPUS_FINDING_CODES.every((code) => result.assessedCodes.has(code))).toBe(true);
    expect(CORPUS_FINDING_CODES.every((code) => !result.failedCodes.has(code))).toBe(true);
  });

  it('doctor stays clean for a corpus with no declared cross-artifact references', async () => {
    const root = await fixture([
      '# Example Specification',
      '',
      '## Requirements',
      '',
      '### Requirement: Example',
      '',
      'The system SHALL work.',
      '',
    ].join('\n'));

    const result = await checkCorpusIntegrity(root);

    expect(result).toMatchObject({ name: 'Corpus integrity', status: 'ok' });
    expect(result.findings).toBeUndefined();
  });
});
