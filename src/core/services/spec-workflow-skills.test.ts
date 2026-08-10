import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest } from '../../cli/commands/setup.js';

describe('spec workflow host skills', () => {
  it('keeps deterministic composition on the MCP server', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    expect(generate).toContain('prepare_spec_generation');
    expect(repair).toContain('prepare_spec_repair');
    expect(repair).toContain('mapping');

    for (const skill of [generate, repair]) {
      expect(skill).toContain('receipt');
      expect(skill).toMatch(/[Dd]o not reconstruct/);
      expect(skill).not.toContain('Phase 1 — Codebase Survey');
      expect(skill).not.toContain('Identify domains by looking for');
    }
  });

  it('installs the same canonical skill catalogue for every skill-based host', () => {
    const projectRoot = '/project';
    const manifest = buildManifest(projectRoot);
    const expectedSources = manifest.vibe.map(({ src }) => src);

    for (const host of ['vibe', 'claude', 'opencode'] as const) {
      const entries = manifest[host];
      const skillEntries = entries.filter(({ dest }) => dest.includes('/skills/'));
      const generate = entries.find(({ dest }) => dest.includes('/openlore-generate/'));
      const repair = entries.find(({ dest }) => dest.includes('/openlore-repair/'));
      expect(skillEntries).toHaveLength(10);
      expect(skillEntries.map(({ src }) => src)).toEqual(expectedSources);
      expect(skillEntries.every(({ src }) => src.includes('/skills/openlore-'))).toBe(true);
      expect(generate?.src).toBe(resolve('skills/openlore-generate/SKILL.md'));
      expect(repair?.src).toBe(resolve('skills/openlore-repair/SKILL.md'));
    }
  });
});
