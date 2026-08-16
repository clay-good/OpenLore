import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_UNMARKED_CAVEAT,
  EVIDENCE_DISCLAIMER,
  auditChangeStatuses,
  renderStatusTable,
  runChangeStatusCli,
  type ValidateChange,
} from './change-status.js';

const roots: string[] = [];
const validate: ValidateChange = async () => ({ passes: true });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-change-status-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'openspec', 'changes'), { recursive: true });
  await mkdir(join(root, 'openspec', 'specs', 'cli'), { recursive: true });
  await mkdir(join(root, 'openspec', 'specs', 'other'), { recursive: true });
  await writeFile(join(root, 'openspec', 'specs', 'cli', 'spec.md'), '# CLI\n\n## Requirements\n\n### Requirement: Synced\n');
  await writeFile(join(root, 'openspec', 'specs', 'other', 'spec.md'), '# Other\n\n## Requirements\n');
  return root;
}

async function addChange(root: string, name: string, domain: string, requirementBlock: string): Promise<void> {
  const dir = join(root, 'openspec', 'changes', name);
  await mkdir(join(dir, 'specs', domain), { recursive: true });
  await writeFile(join(dir, 'proposal.md'), `# ${name}\n`);
  await writeFile(join(dir, 'tasks.md'), '- [x] first\n- [ ] second\n');
  await writeFile(
    join(dir, 'specs', domain, 'spec.md'),
    `# delta\n\n## ADDED Requirements\n\n${requirementBlock}\n`,
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('change evidence audit', () => {
  it('computes every verdict from marker and domain-scoped requirement evidence', async () => {
    const root = await fixture();
    await addChange(root, 'built', 'cli', '### Requirement: Synced');
    await addChange(root, 'built-unmarked', 'cli', '### Requirement: Synced');
    await addChange(root, 'partial', 'cli', '### Requirement: Missing');
    await addChange(root, 'unbuilt', 'cli', '### Requirement: Missing');
    await writeFile(join(root, 'src', 'markers.ts'), '// change: built\n// change: partial\n');

    const results = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(Object.fromEntries(results.map((r) => [r.name, r.verdict]))).toEqual({
      built: 'built',
      'built-unmarked': 'built-unmarked',
      partial: 'partially-built',
      unbuilt: 'unbuilt',
    });
    expect(results[0].marker.receipts).toEqual([{ file: 'src/markers.ts', line: 1 }]);
    expect(results.find((r) => r.name === 'built-unmarked')?.caveat).toBe(BUILT_UNMARKED_CAVEAT);
    expect(results.find((r) => r.name === 'built')?.archivableCandidate).toBe(true);
  });

  it('does not cross-match an identical requirement name from another domain', async () => {
    const root = await fixture();
    await addChange(root, 'domain-bound', 'other', '### Requirement: Synced');
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('unbuilt');
    expect(result.requirementsSynced.requirements).toEqual([
      expect.objectContaining({ domain: 'other', name: 'Synced', present: false }),
    ]);
  });

  it('preserves a nested OpenSpec capability path when matching its baseline', async () => {
    const root = await fixture();
    await mkdir(join(root, 'openspec', 'specs', 'identity', 'user-auth'), { recursive: true });
    await writeFile(
      join(root, 'openspec', 'specs', 'identity', 'user-auth', 'spec.md'),
      '# Auth\n\n## Requirements\n\n### Requirement: Nested\n',
    );
    await addChange(root, 'nested-capability', 'identity/user-auth', '### Requirement: Nested');
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('built-unmarked');
    expect(result.requirementsSynced.requirements).toEqual([
      expect.objectContaining({ domain: 'identity/user-auth', name: 'Nested', present: true }),
    ]);
  });

  it('deduplicates requirement identity by name within its target domain', async () => {
    const root = await fixture();
    await addChange(
      root,
      'duplicate-requirement',
      'cli',
      '### Requirement: Synced\n\n### Requirement: Synced',
    );
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.requirementsSynced).toMatchObject({ all: true, synced: 1, total: 1 });
  });

  it('uses OpenSpec heading grammar and ignores fenced requirement examples', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'openspec', 'specs', 'other', 'spec.md'),
      '# Other\n\n## Requirements\n\n###Requirement: Real\n\n```markdown\n### Requirement: FencedOnly\n```\n',
    );
    await addChange(
      root,
      'fenced-heading',
      'other',
      '###Requirement: FencedOnly\n\n```markdown\n### Requirement: IgnoredDeltaExample\n```',
    );
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('unbuilt');
    expect(result.requirementsSynced.requirements).toEqual([
      expect.objectContaining({ name: 'FencedOnly', present: false }),
    ]);
  });

  it('does not treat a fence prefix with trailing text as a closing fence', async () => {
    const root = await fixture();
    await addChange(root, 'false-fence-close', 'cli', '### Requirement: placeholder');
    await writeFile(
      join(root, 'openspec', 'changes', 'false-fence-close', 'specs', 'cli', 'spec.md'),
      '# delta\r## ADDED Requirements\r```markdown\r```not-a-close\r### Requirement: Synced\r```\r',
    );
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('not-assessed');
    expect(result.assessmentError).toContain('has no valid requirement headings');
  });

  it('accepts a BOM and lone carriage returns like OpenSpec', async () => {
    const root = await fixture();
    await addChange(root, 'normalized-lines', 'cli', '### Requirement: placeholder');
    await writeFile(
      join(root, 'openspec', 'changes', 'normalized-lines', 'specs', 'cli', 'spec.md'),
      '\uFEFF# delta\r## ADDED Requirements\r###Requirement: Synced\r',
    );
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('built-unmarked');
    expect(result.requirementsSynced).toMatchObject({ synced: 1, total: 1 });
  });

  it('reports malformed deltas as not-assessed and still delegates validation', async () => {
    const root = await fixture();
    await addChange(root, 'malformed', 'cli', '### Requirement:');
    const validator = vi.fn<ValidateChange>().mockResolvedValue({ passes: false, error: 'schema invalid' });
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validator });
    expect(result.verdict).toBe('not-assessed');
    expect(result.assessmentError).toMatch(/no name/);
    expect(result.validates).toEqual({ passes: false, error: 'schema invalid' });
    expect(validator).toHaveBeenCalledWith(root, 'malformed');
  });

  it('reports checkboxes without allowing them to affect the verdict and renders table rows only', async () => {
    const root = await fixture();
    await addChange(root, 'checkboxes', 'cli', '### Requirement: Synced');
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('built-unmarked');
    expect(result.tasks).toEqual({ checked: 1, total: 2 });
    expect(renderStatusTable([result])).toBe(
      '| `checkboxes` | built-unmarked; marker absent; requirements 1/1; validates yes; tasks 1/2 (display only); verify against code before trusting; Verdicts reflect documented evidence signals, not runtime correctness. |\n',
    );
  });

  it('does not match a baseline heading outside the canonical Requirements section', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'openspec', 'specs', 'other', 'spec.md'),
      '# Other\n\n## Purpose\n\n### Requirement: Phantom\n\n## Requirements\n',
    );
    await addChange(root, 'purpose-heading', 'other', '### Requirement: Phantom');
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('unbuilt');
    expect(result.requirementsSynced.synced).toBe(0);
  });

  it('treats an unsupported delta section and a missing delta as not-assessed', async () => {
    const root = await fixture();
    await addChange(root, 'singular-section', 'cli', '### Requirement: Synced');
    await writeFile(
      join(root, 'openspec', 'changes', 'singular-section', 'specs', 'cli', 'spec.md'),
      '# delta\n\n## ADDED Requirement\n\n### Requirement: Synced\n',
    );
    await mkdir(join(root, 'openspec', 'changes', 'missing-delta'), { recursive: true });
    await writeFile(join(root, 'src', 'markers.ts'), '// change: singular-section\n// change: missing-delta\n');
    const results = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(results.map((result) => [result.name, result.verdict])).toEqual([
      ['missing-delta', 'not-assessed'],
      ['singular-section', 'not-assessed'],
    ]);
  });

  it('recognizes RENAMED-only as a valid non-sync-bearing OpenSpec delta', async () => {
    const root = await fixture();
    await addChange(root, 'renamed-only', 'cli', '### Requirement: ignored');
    await writeFile(
      join(root, 'openspec', 'changes', 'renamed-only', 'specs', 'cli', 'spec.md'),
      '# delta\n\n## RENAMED Requirements\n\n- FROM: `Old`\n- TO: `New`\n',
    );
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('unbuilt');
    expect(result.assessmentError).toBeUndefined();
    expect(result.requirementsSynced).toMatchObject({ all: true, synced: 0, total: 0 });
  });

  it('includes the parse error in a table-mode not-assessed row', async () => {
    const root = await fixture();
    await addChange(root, 'bad-table', 'cli', '### Requirement:');
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    const row = renderStatusTable([result]);
    expect(row).toContain('not-assessed');
    expect(row).toContain('assessment error:');
    expect(row).toContain('requirement heading has no name');
  });

  it('treats requirements for a brand-new domain as absent rather than unparseable', async () => {
    const root = await fixture();
    await addChange(root, 'new-domain', 'brand-new', '### Requirement: First');
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('unbuilt');
    expect(result.assessmentError).toBeUndefined();
    expect(result.requirementsSynced.requirements[0]).toMatchObject({ present: false });
  });

  it('accepts an explicit skip_specs change with no delta files', async () => {
    const root = await fixture();
    const changeDir = join(root, 'openspec', 'changes', 'tooling-only');
    await mkdir(changeDir, { recursive: true });
    await writeFile(join(changeDir, '.openspec.yaml'), 'schema: spec-driven\nskip_specs: true\n');
    await writeFile(join(changeDir, 'tasks.md'), '- [x] tooling change\n');
    await writeFile(join(root, 'src', 'tooling.ts'), '// change: tooling-only\n');

    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.verdict).toBe('built');
    expect(result.requirementsSynced).toMatchObject({ all: true, synced: 0, total: 0 });
    expect(result.archivableCandidate).toBe(true);
  });

  it('does not honor skip_specs metadata that delegated OpenSpec validation rejects', async () => {
    const root = await fixture();
    for (const [name, metadata] of [
      ['missing-schema', 'skip_specs: true\n'],
      ['unknown-schema', 'schema: does-not-exist\nskip_specs: true\n'],
    ]) {
      const changeDir = join(root, 'openspec', 'changes', name);
      await mkdir(changeDir, { recursive: true });
      await writeFile(join(changeDir, '.openspec.yaml'), metadata);
      await writeFile(join(root, 'src', `${name}.ts`), `// change: ${name}\n`);
    }
    const rejected: ValidateChange = async () => ({ passes: false, error: 'invalid change metadata' });
    const results = await auditChangeStatuses({ rootPath: root, validateChange: rejected });
    expect(results.map((result) => [result.name, result.verdict, result.validates.passes])).toEqual([
      ['missing-schema', 'not-assessed', false],
      ['unknown-schema', 'not-assessed', false],
    ]);
  });

  it.skipIf(process.platform === 'win32')('delegates to a real openspec subprocess with the change name', async () => {
    const root = await fixture();
    const binDir = join(root, 'fake-bin');
    const bin = join(binDir, 'openspec');
    const argvLog = join(root, 'argv.json');
    await mkdir(binDir);
    await writeFile(bin, `#!/bin/sh\nprintf '%s' "$*" > "${argvLog}"\n[ "$2" = "passing" ]\n`);
    await chmod(bin, 0o755);
    const { validateWithOpenSpec } = await import('./change-status.js');

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      expect(await validateWithOpenSpec(root, 'passing')).toEqual({ passes: true });
      expect(await readFile(argvLog, 'utf8')).toBe('validate passing --type change --no-interactive');
      expect((await validateWithOpenSpec(root, 'failing')).passes).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it.skipIf(process.platform === 'win32')('does not accept an out-of-root symlink as marker evidence', async () => {
    const root = await fixture();
    await addChange(root, 'linked-marker', 'cli', '### Requirement: Missing');
    const outside = join(tmpdir(), `openlore-outside-${Date.now()}.ts`);
    roots.push(outside);
    await writeFile(outside, '// change: linked-marker\n');
    await symlink(outside, join(root, 'src', 'linked.ts'));

    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.marker).toEqual({ present: false, receipts: [] });
    expect(result.verdict).toBe('unbuilt');
  });

  it.skipIf(process.platform === 'win32')('does not read task progress through an out-of-root symlink', async () => {
    const root = await fixture();
    await addChange(root, 'linked-tasks', 'cli', '### Requirement: Synced');
    const tasks = join(root, 'openspec', 'changes', 'linked-tasks', 'tasks.md');
    const outside = join(tmpdir(), `openlore-outside-tasks-${Date.now()}.md`);
    roots.push(outside);
    await rm(tasks);
    await writeFile(outside, '- [x] forged\n');
    await symlink(outside, tasks);

    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.tasks).toEqual({ checked: 0, total: 0 });
    expect(result.verdict).toBe('built-unmarked');
  });

  it('counts indented task checkboxes as display-only progress', async () => {
    const root = await fixture();
    await addChange(root, 'indented-tasks', 'cli', '### Requirement: Synced');
    await writeFile(
      join(root, 'openspec', 'changes', 'indented-tasks', 'tasks.md'),
      '- [x] top\n  - [ ] nested\n    - [X] deeper\n',
    );
    const [result] = await auditChangeStatuses({ rootPath: root, validateChange: validate });
    expect(result.tasks).toEqual({ checked: 2, total: 3 });
    expect(result.verdict).toBe('built-unmarked');
  });

  it('keeps stdout JSON pure and includes the evidence-not-correctness statement', async () => {
    const root = await fixture();
    await addChange(root, 'json-change', 'cli', '### Requirement: Synced');
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);

    expect(await runChangeStatusCli({ rootPath: root, json: true, validateChange: validate })).toBe(0);
    const payload = JSON.parse(stdout) as { evidenceDisclaimer: string; changes: Array<{ evidenceDisclaimer: string }> };
    expect(payload.evidenceDisclaimer).toBe(EVIDENCE_DISCLAIMER);
    expect(payload.changes[0].evidenceDisclaimer).toBe(EVIDENCE_DISCLAIMER);
  });

  it('rejects traversal-like or unknown names before reading outside the open-change set', async () => {
    const root = await fixture();
    await expect(auditChangeStatuses({ rootPath: root, name: '../../outside', validateChange: validate }))
      .rejects.toThrow('Invalid change name');
  });
});
