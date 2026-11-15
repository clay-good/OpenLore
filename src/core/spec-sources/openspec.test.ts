import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectOpenSpecRoot, openspecSource, parseOpenSpecItems, readSpecDomainEntries } from './openspec.js';
import { detectExistingSpecDir } from '../services/config-manager.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'olsrc-openspec-'));
  dirs.push(root);
  for (const [rel, c] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); }
  return root;
}
const OPENSPEC = '# Billing\n\n## Requirements\n\n### Requirement: Charge\nThe system SHALL charge.\n\n#### Scenario: Card\n- **WHEN** a card is charged\n';
const SPEC_KIT = '# Feature 001\n\n## Requirements\n\n- **FR-001**: System MUST let users log in.\n';

describe('OpenSpec source', () => {
  it('parses requirements and scenarios with 1-based lines, ignoring fenced examples', () => {
    const text = OPENSPEC + '\n```md\n### Requirement: Not real\n```\n';
    expect(parseOpenSpecItems(text, 'openspec/specs/billing/spec.md', 'billing')).toEqual([
      { id: 'openspec:billing/Charge', text: 'Charge', file: 'openspec/specs/billing/spec.md', line: 5, kind: 'requirement' },
      { id: 'openspec:billing/Card', text: 'Card', file: 'openspec/specs/billing/spec.md', line: 8, kind: 'scenario' },
    ]);
  });

  it('a bare specs/001-x/spec.md with no requirement heading is not OpenSpec (it is the Spec Kit layout)', async () => {
    const kit = repo({ 'specs/001-login/spec.md': SPEC_KIT });
    expect(await detectOpenSpecRoot(kit)).toBeNull();
    expect(await detectExistingSpecDir(kit)).toBeNull();
    expect(await openspecSource.detect(kit, null)).toEqual([]);

    const bare = repo({ 'specs/billing/spec.md': OPENSPEC });
    expect(await detectExistingSpecDir(bare)).toEqual({ root: '.', specsRel: 'specs', count: 1 });
    const docs = repo({ 'docs/specs/billing/spec.md': OPENSPEC });
    expect(await detectExistingSpecDir(docs)).toEqual({ root: 'docs', specsRel: 'docs/specs', count: 1 });
    const docsKit = repo({ 'docs/specs/001-login/spec.md': SPEC_KIT });
    expect(await detectExistingSpecDir(docsKit)).toBeNull();
  });

  it('openspec/specs counts with any markdown, as before', async () => {
    const root = repo({ 'openspec/specs/billing/spec.md': '# Billing\n' });
    expect(await detectExistingSpecDir(root)).toEqual({ root: 'openspec', specsRel: 'openspec/specs', count: 1 });
  });

  it('detects and lists the configured folder, and nothing when absent', async () => {
    const root = repo({ 'design/specs/billing/spec.md': OPENSPEC, 'design/specs/notes.txt': 'x' });
    const config = { openspecPath: './design' } as never;
    expect(await openspecSource.detect(root, config)).toEqual(['design/specs']);
    expect((await openspecSource.list(root, config)).map(i => `${i.kind}:${i.id}@${i.file}:${i.line}`)).toEqual([
      'requirement:openspec:billing/Charge@design/specs/billing/spec.md:5',
      'scenario:openspec:billing/Card@design/specs/billing/spec.md:8',
    ]);
    expect(await openspecSource.detect(repo({}), config)).toEqual([]);
    expect(await openspecSource.list(repo({}), null)).toEqual([]);
  });

  it('the shared listing keeps directories only, in listing order, and throws when the folder is absent', async () => {
    const root = repo({ 'openspec/specs/a/spec.md': 'x', 'openspec/specs/b/other.md': 'x', 'openspec/specs/README.md': 'x' });
    expect((await readSpecDomainEntries(join(root, 'openspec', 'specs'))).map(e => e.domain).sort()).toEqual(['a', 'b']);
    await expect(readSpecDomainEntries(join(root, 'missing'))).rejects.toThrow();
  });
});
