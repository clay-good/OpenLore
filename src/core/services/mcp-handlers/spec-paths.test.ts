import { describe, expect, it } from 'vitest';
import { indexedSpecProvenanceAt, isUnderSpecRoot, specFileRel, specRootRelOrNull } from './spec-paths.js';

describe('spec paths', () => {
  it('builds a spec file path under the configured root', () => {
    expect(specFileRel('openspec', 'api')).toBe('openspec/specs/api/spec.md');
    expect(specFileRel('docs', 'api')).toBe('docs/specs/api/spec.md');
    expect(specFileRel('.', 'api')).toBe('specs/api/spec.md');
  });

  it('tells a path inside the configured spec root from one outside it', () => {
    expect(isUnderSpecRoot('docs/specs/api/spec.md', 'docs')).toBe(true);
    expect(isUnderSpecRoot('openspec/specs/api/spec.md', 'docs')).toBe(false);
    expect(isUnderSpecRoot('docsx/specs/api/spec.md', 'docs')).toBe(false);
    expect(isUnderSpecRoot('changes/x/proposal.md', '.')).toBe(true);
    expect(isUnderSpecRoot('src/index.ts', '.')).toBe(false);
  });

  it('a spec root that cannot be resolved is null, and its text is never labeled reviewed', async () => {
    expect(await specRootRelOrNull('/no/such\0root')).toBeNull();
    expect(await indexedSpecProvenanceAt('/tmp', null, 'api', ['x'])).toBe('local-unreviewed');
  });
});
