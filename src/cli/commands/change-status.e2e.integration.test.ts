/** End-to-end coverage for the built `openlore change-status` CLI. */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const haveCli = existsSync(CLI);

describe.skipIf(!haveCli || process.platform === 'win32')('change-status CLI — built binary', () => {
  let root = '';
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'openlore-change-status-e2e-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'openspec', 'changes', 'example', 'specs', 'cli'), { recursive: true });
    mkdirSync(join(root, 'openspec', 'specs', 'cli'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'src', 'example.ts'), '// change: example\n');
    writeFileSync(join(root, 'openspec', 'specs', 'cli', 'spec.md'),
      '# CLI\n\n## Requirements\n\n### Requirement: Example\n');
    writeFileSync(join(root, 'openspec', 'changes', 'example', 'specs', 'cli', 'spec.md'),
      '# delta\n\n## ADDED Requirements\n\n### Requirement: Example\n');
    writeFileSync(join(root, 'openspec', 'changes', 'example', 'tasks.md'), '- [x] implemented\n');
    const validator = join(root, 'bin', 'openspec');
    writeFileSync(
      validator,
      '#!/bin/sh\n[ "$1" = "validate" ] && [ "$2" = "example" ] && [ "$3" = "--type" ] && [ "$4" = "change" ] && [ "$5" = "--no-interactive" ]\n',
    );
    chmodSync(validator, 0o755);
    env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}` };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is registered and emits a pure, fully evidenced JSON verdict', () => {
    const stdout = execFileSync('node', [CLI, 'change-status', 'example', '--json'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    const payload = JSON.parse(stdout) as { changes: Array<{ verdict: string; archivableCandidate: boolean }> };
    expect(payload.changes).toEqual([expect.objectContaining({ verdict: 'built', archivableCandidate: true })]);
  });

  it('emits pasteable two-column table rows and rejects conflicting output modes', () => {
    const table = execFileSync('node', [CLI, 'change-status', 'example', '--table'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(table).toMatch(/^\| `example` \| built;/);
    expect(table).toContain('not runtime correctness');
    expect(table.trim().split('|')).toHaveLength(4);

    const conflict = spawnSync('node', [CLI, 'change-status', 'example', '--json', '--table'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stdout).toBe('');
    expect(conflict.stderr).toContain('--json and --table cannot be combined');
  });
});
