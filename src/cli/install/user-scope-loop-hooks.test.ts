/** The safeguards of user-scope loop hooks (change: user-scope-loop-hooks). */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USER_SCOPE_PROJECT_GUARD } from './adapters/claude-code.js';
import { assessHookWiring, isUserScopeCommand, repoWiresStep } from './hook-wiring-health.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'oluserloop-')); dirs.push(d); return d; };
const settings = (dir: string, name: string, hooks: Record<string, string[]>) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', name), JSON.stringify({ hooks: Object.fromEntries(Object.entries(hooks).map(([event, commands]) => [event, [{ hooks: commands.map(command => ({ type: 'command', command })) }]])) }));
};
const REPO = "'/usr/bin/node' '/opt/openlore/dist/cli/index.js' hook before-edit";
const USER = `${USER_SCOPE_PROJECT_GUARD}'/usr/bin/node' '/home/u/openlore/dist/cli/index.js' hook before-edit --scope user`;

describe.skipIf(process.platform === 'win32')('the project guard, run by a real POSIX shell', () => {
  it('exits 0 before the command outside a project with .openlore/, and runs it inside one', () => {
    const run = (project: string) => spawnSync('sh', ['-c', `${USER_SCOPE_PROJECT_GUARD}echo ran`], { env: { ...process.env, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' });
    const plain = tmp();
    const outside = run(plain);
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe('');
    mkdirSync(join(plain, '.openlore'));
    expect(run(plain).stdout).toBe('ran\n');
  });

  it('falls back to the working directory when CLAUDE_PROJECT_DIR is unset', () => {
    const project = tmp();
    mkdirSync(join(project, '.openlore'));
    const env = { ...process.env }; delete env.CLAUDE_PROJECT_DIR;
    expect(spawnSync('sh', ['-c', `${USER_SCOPE_PROJECT_GUARD}echo ran`], { cwd: project, env, encoding: 'utf8' }).stdout).toBe('ran\n');
  });
});

describe('repoWiresStep', () => {
  it('is true only for a repo-scope command of that step, in settings.json or settings.local.json', () => {
    const root = tmp();
    expect(repoWiresStep([root], 'hook before-edit')).toBe(false);
    settings(root, 'settings.json', { PreToolUse: [USER] });
    expect(repoWiresStep([root], 'hook before-edit')).toBe(false);
    settings(root, 'settings.local.json', { PreToolUse: [REPO] });
    expect(repoWiresStep([root], 'hook before-edit')).toBe(true);
    expect(repoWiresStep([root], 'hook after-tools')).toBe(false);
    expect(repoWiresStep([undefined, root], 'hook before-edit')).toBe(true);
  });

  it('recognizes the user-scope form', () => {
    expect(isUserScopeCommand(USER)).toBe(true);
    expect(isUserScopeCommand(REPO)).toBe(false);
  });
});

describe('doctor duplicate rule', () => {
  it('a user-scope command beside a repo-scope one for the same step is one step; two repo commands are still a duplicate', async () => {
    const home = tmp(); const root = tmp();
    settings(home, 'settings.json', { PreToolUse: [USER] });
    settings(root, 'settings.json', { PreToolUse: [REPO] });
    const files = [join(home, '.claude', 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')];
    expect((await assessHookWiring(files)).duplicates).toEqual([]);
    settings(root, 'settings.local.json', { PreToolUse: ["'/usr/bin/node' '/other/openlore/dist/cli/index.js' hook before-edit"] });
    expect((await assessHookWiring(files)).duplicates.map(d => d.step)).toEqual(['hook before-edit']);
  });
});
