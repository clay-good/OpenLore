import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('spec workflow host skills', () => {
  it('keep deterministic composition on the MCP server', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');
    expect(generate).toContain('prepare_spec_generation');
    expect(repair).toContain('prepare_spec_repair');
    for (const skill of [generate, repair]) {
      expect(skill).toContain('receipt');
      expect(skill).toMatch(/Do not reconstruct/);
      expect(skill).not.toContain('get_architecture_overview');
      expect(skill).not.toContain('audit_spec_coverage');
    }
  });
});
