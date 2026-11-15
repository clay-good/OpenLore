import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDigest } from './digest-generator.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };

const SPEC = (name: string) => `# ${name}\n\n### Requirement: ${name}Works\n\nThe system SHALL work.\n\n#### Scenario: It works\n\n- **WHEN** used\n- **THEN** it works\n`;

describe('generateDigest', () => {
  it('reads each domain in name order and skips a spec that links out of the repository', async () => {
    const root = temp('oldigest-');
    const outside = temp('oldigest-out-');
    writeFileSync(join(outside, 'secret.md'), SPEC('Secret'));
    for (const domain of ['zeta', 'alpha']) {
      mkdirSync(join(root, 'openspec/specs', domain), { recursive: true });
      writeFileSync(join(root, 'openspec/specs', domain, 'spec.md'), SPEC(domain));
    }
    mkdirSync(join(root, 'openspec/specs/leak'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(root, 'openspec/specs/leak/spec.md'));
    writeFileSync(join(root, 'openspec/specs/README.md'), 'not a domain');

    const r = await generateDigest({ rootPath: root });
    expect(r.domains.map(d => d.name)).toEqual(['alpha', 'zeta']);
    expect(r.totalRequirements).toBe(2);
    expect(r.totalScenarios).toBe(2);
  });

  it('a missing specs folder is an error that names it', async () => {
    const root = temp('oldigest-none-');
    await expect(generateDigest({ rootPath: root })).rejects.toThrow(/No specs directory found/);
  });
});
