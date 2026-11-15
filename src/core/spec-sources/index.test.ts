import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_SOURCE_ADAPTERS, SPEC_SOURCE_ORDER, detectSpecSources, listSpecItems } from './index.js';
import { SPEC_SOURCES_LOOKED_FOR } from './state.js';
import type { SpecSource } from './types.js';

const fake = (id: SpecSource['id'], present: boolean): SpecSource => ({
  id,
  detect: async () => (present ? [`${id}-path`] : []),
  list: async () => (present ? [{ id: `${id}:x/y`, text: 'y', file: `${id}.md`, line: 1, kind: 'requirement' }] : []),
});

describe('spec sources', () => {
  it('with zero adapters finds nothing and claims to have looked for nothing', async () => {
    expect(await detectSpecSources('/nowhere', null, [])).toEqual({ found: [], lookedFor: [] });
    expect(await listSpecItems('/nowhere', null, [])).toEqual([]);
  });

  it('orders sources by the fixed order whatever the registration order', async () => {
    const adapters = [fake('tests', true), fake('adr', false), fake('openspec', true)];
    expect(await detectSpecSources('/r', null, adapters)).toEqual({ found: ['openspec', 'tests'], lookedFor: ['openspec', 'adr', 'tests'] });
    expect((await listSpecItems('/r', null, adapters)).map(i => i.id)).toEqual(['openspec:x/y', 'tests:x/y']);
  });

  it('an adapter that throws counts as absent, never as a failed answer', async () => {
    const broken: SpecSource = { id: 'bmad', detect: async () => { throw new Error('x'); }, list: async () => { throw new Error('x'); } };
    expect(await detectSpecSources('/r', null, [broken])).toEqual({ found: [], lookedFor: ['bmad'] });
    expect(await listSpecItems('/r', null, [broken])).toEqual([]);
  });

  it('"looked for" everywhere names exactly the registered adapters', async () => {
    expect([...SPEC_SOURCES_LOOKED_FOR]).toEqual(SPEC_SOURCE_ADAPTERS.map(a => a.id));
    expect(SPEC_SOURCE_ORDER).toHaveLength(6);
    const empty = mkdtempSync(join(tmpdir(), 'olsrc-none-'));
    try {
      expect(await detectSpecSources(empty, null)).toEqual({ found: [], lookedFor: [...SPEC_SOURCES_LOOKED_FOR] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
