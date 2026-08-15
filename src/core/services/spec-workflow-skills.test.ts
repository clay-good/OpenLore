import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest } from '../../cli/commands/setup.js';

describe('spec workflow host skills', () => {
  const legacySkillNames = [
    'openlore-analyze-codebase',
    'openlore-brainstorm',
    'openlore-debug',
    'openlore-execute-refactor',
    'openlore-generate',
    'openlore-implement-story',
    'openlore-plan-refactor',
    'openlore-review-changes',
    'openlore-write-tests',
  ];

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

  it('teaches both authoring paths the same finalization and anchor contract', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    for (const skill of [generate, repair]) {
      // Exact per-requirement anchors — the input the deterministic link index reads.
      expect(skill).toContain('**Implementation**');
      expect(skill).toContain('symbolName::path/to/file.ts');
      expect(skill).toMatch(/file-only reference[\s\S]*never establishes function coverage/);
      // Finalization through the CLI, with the skipped-cache case disclosed rather
      // than implied to be a correctness problem.
      expect(skill).toContain('openlore mapping refresh');
      expect(skill).toMatch(/re-derive the index in memory/);
      // Continuation stays inside the composite protocol.
      expect(skill).toContain('receipt.continuationCursor');
    }
  });

  it('makes Generate stop for host judgment on material existing-spec overlap', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    expect(generate).toContain('overlap');
    expect(generate).toMatch(/[Ss]top for the human/);
    expect(generate).toContain('Do not silently author a competing spec');
    // The skill must not encode a decision OpenLore deliberately does not make.
    expect(generate).toMatch(/never decides/);
  });

  it('forbids Repair from re-running the observation that came back unavailable', () => {
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');
    expect(repair).toMatch(/never read `null` as zero gaps/);
    expect(repair).toMatch(/never re-run the same audit/);
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

  it('keeps former host-specific package paths as exact compatibility copies', () => {
    for (const name of legacySkillNames) {
      const canonical = readFileSync(resolve('skills', name, 'SKILL.md'), 'utf8');
      expect(readFileSync(resolve('examples/opencode-skills', name, 'SKILL.md'), 'utf8')).toBe(canonical);
      expect(readFileSync(resolve('examples/mistral-vibe/skills', name, 'SKILL.md'), 'utf8')).toBe(canonical);
    }
  });
});
