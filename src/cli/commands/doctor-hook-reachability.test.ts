import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHookReachability } from './doctor.js';

const execFileAsync = promisify(execFile);
const created: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-doctor-hook-'));
  created.push(root);
  await execFileAsync('git', ['init'], { cwd: root });
  return root;
}

afterEach(async () => {
  for (const root of created.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('doctor Git hook reachability', () => {
  it('reports a legacy OpenLore gate shadowed by core.hooksPath as installed but unreachable', async () => {
    const root = await repository();
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(
      join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\n# openlore-enforcement-hook\n',
      { mode: 0o755 },
    );
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });

    const result = await checkHookReachability(root);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/installed but unreachable/);
    expect(result.detail).toContain(join(root, '.githooks'));
    expect(result.fix).toMatch(/Re-run the OpenLore hook installer/);
  });

  it('accepts an executable OpenLore gate on the effective path', async () => {
    const root = await repository();
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await mkdir(join(root, '.githooks'), { recursive: true });
    await writeFile(
      join(root, '.githooks', 'pre-commit'),
      '#!/bin/sh\n# openlore-decisions-hook\n',
      { mode: 0o755 },
    );

    const result = await checkHookReachability(root);

    expect(result.status).toBe('ok');
    expect(result.detail).toMatch(/installed and executable/);
  });

  it('fails an executable gate whose pinned launcher no longer exists', async () => {
    const root = await repository();
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await mkdir(join(root, '.githooks'), { recursive: true });
    const gone = join(root, 'Cellar', 'node', '1.0.0', 'bin', 'node');
    const cli = join(root, 'cli.js');
    await writeFile(cli, '');
    await writeFile(
      join(root, '.githooks', 'pre-commit'),
      `#!/bin/sh\n# openlore-decisions-hook\n'${gone}' '${cli}' enforce --hook\n# end-openlore-decisions-hook\n`,
      { mode: 0o755 },
    );

    const result = await checkHookReachability(root);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain(gone);
    expect(result.detail).not.toContain(cli);
  });

  it('ignores quoted paths in the user\'s own hook lines, and reads an apostrophe in the install path', async () => {
    const root = await repository();
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await mkdir(join(root, '.githooks'), { recursive: true });
    const cli = join(root, 'cli.js');
    await writeFile(cli, '');
    const odd = join(root, "o'brien", 'node');
    await mkdir(join(root, "o'brien"), { recursive: true });
    await writeFile(odd, '');
    const quotedOdd = `'${odd.replace(/'/g, `'"'"'`)}'`;
    await writeFile(
      join(root, '.githooks', 'pre-commit'),
      `#!/bin/sh\nsed -i '/^#/d' notes.txt\n# openlore-decisions-hook\n${quotedOdd} '${cli}' enforce --hook\n# end-openlore-decisions-hook\n`,
      { mode: 0o755 },
    );

    const result = await checkHookReachability(root);

    expect(result.status).toBe('ok');
  });

  it('does not bless a Husky public script when Git has no executable shim', async () => {
    const root = await repository();
    await execFileAsync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
    await mkdir(join(root, '.husky'), { recursive: true });
    await writeFile(
      join(root, '.husky', 'pre-commit'),
      '#!/bin/sh\n# openlore-enforcement-hook\n',
      { mode: 0o755 },
    );

    const result = await checkHookReachability(root);

    expect(result.status).toBe('warn');
    expect(result.detail).toMatch(/Git cannot execute/);
    expect(result.fix).toMatch(/initialize Husky/);
  });
});
