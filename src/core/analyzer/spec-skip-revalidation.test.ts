/**
 * A cached spec-index skip is only reusable while its cause still holds
 * (change: fix-governance-face-dark).
 *
 * The FIRST analyze of a repository with no `spec.md` files recorded `specIndex: 'skipped'`, and
 * `indexExists` counted a skip as "exists" while the configuration hash covered no spec state. So
 * the skip was reused forever: adding specs and re-running `analyze` replayed the stored "contains
 * no spec.md files" message — by then false — `search_specs` stayed permanently dead advising a
 * command that could not help, and because the spec-index build is what triggers the spec→code
 * link index, `orient` reported that no spec governed any code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAnalysisIndexes } from './analysis-indexes.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

function fixture(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'ol-spec-skip-'));
  dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export function a() { return 1; }\n');
  mkdirSync(join(root, 'openspec/specs'), { recursive: true });
  const out = join(root, '.openlore/analysis');
  mkdirSync(out, { recursive: true });
  return { root, out };
}

const SPEC = `# Alpha

## Requirements

### Requirement: AlphaReturnsOne

The system SHALL return one.

- **Implementation**: \`a::src/a.ts\`

#### Scenario: Returns one

- **WHEN** a is called
- **THEN** it returns 1
`;

const build = (root: string, out: string) => buildAnalysisIndexes({
  rootPath: root, outputPath: out, keywordOnly: true, generationId: 'gen-1', config: null,
});

describe('spec-index skip revalidation', () => {
  it('rebuilds the spec index once spec files appear, instead of replaying the skip', async () => {
    const { root, out } = fixture();

    const first = await build(root, out);
    expect(first.specIndex, 'an empty specs directory is a skip').toBe('skipped');

    mkdirSync(join(root, 'openspec/specs/alpha'), { recursive: true });
    writeFileSync(join(root, 'openspec/specs/alpha/spec.md'), SPEC);

    // Same generationId and the same configuration: only the corpus changed.
    const second = await build(root, out);
    expect(second.specIndex, 'the skip no longer holds, so the index must be built').toBe('built');
  });

  it('still reuses a skip while the specs directory remains empty', async () => {
    const { root, out } = fixture();
    await build(root, out);
    const second = await build(root, out);
    expect(second.specIndex).toBe('skipped');
    expect(existsSync(join(out, 'mapping.json')), 'nothing to map with no specs').toBe(false);
  });
});
