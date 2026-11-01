import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runHook } from '../../cli/commands/hook.js';
import { isTestCommand, readRunState } from './test-run-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };

const CONFIG = 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\n\nexport function loadDefaults() {\n  return { a: 1 };\n}\n';

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olruns-')));
  dirs.push(root);
  mkdirSync(join(root, '.openlore'));
  write(root, '.gitignore', '.openlore/\n');
  write(root, 'src/config.ts', CONFIG);
  write(root, 'src/other.ts', 'export function other() {\n  return 1;\n}\n');
  write(root, 'package.json', JSON.stringify({ name: 'x', scripts: { 'test:unit': 'vitest run', lint: 'eslint .' } }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  return root;
}

const edit = async (root: string, file: string, content?: string) => {
  const payload = JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, file) } });
  await runHook('before-edit', payload);
  if (content !== undefined) write(root, file, content);
  await runHook('after-tools', payload);
};
const shell = (root: string, command: string, exit?: number) =>
  runHook('after-tools', JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command }, tool_response: exit === undefined ? { stdout: '' } : { exit_code: exit } }));
/** Claude Code's shape for a failing shell command. */
const failedShell = (root: string, command: string) =>
  runHook('after-tools', JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, error: 'Exit code 2\nFAIL src/config.test.ts' }));
const stop = async (root: string) => {
  const out = (await runHook('before-stop', JSON.stringify({ session_id: 's1', cwd: root }), { timeoutMs: 45_000 })).stdout;
  return out ? (JSON.parse(out) as { systemMessage?: string }).systemMessage ?? '' : '';
};

describe('isTestCommand', () => {
  it('recognizes runners, package-manager test scripts, declared scripts, and make targets', () => {
    const root = repo();
    for (const c of ['npm test', 'pnpm test -- --run', 'yarn test', 'npx vitest run src', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test', 'cd app && npm run test', 'make test', 'make check-unit', 'pnpm test:unit', 'npm run test:unit', './gradlew test',
      'CI=1 npm test', 'npm.cmd test', './node_modules/.bin/vitest run', 'make -C pkg test', 'python manage.py test', 'nx test app', 'time pytest'])
      expect(isTestCommand(root, c), c).toBe(true);
    for (const c of ['npm install', 'npm run lint', 'git status', 'ls tests/', 'cat test.txt', 'echo testing', 'npm run build',
      'cat jest.config.js', 'ls vitest.config.ts', 'grep -rn pytest src', 'git commit -m "fix vitest flake"', 'pip install pytest',
      'npm i -D vitest', 'npx jest --listTests', 'vitest --version', 'echo "npm test"'])
      expect(isTestCommand(root, c), c).toBe(false);
  });
});

describe('isTestCommand on hostile input', () => {
  it('stays fast on repeated option-like words (no regular-expression backtracking)', () => {
    const root = repo();
    for (const p of ['npm -!' + ' -! -!'.repeat(4000), 'make -!' + ' -! -!'.repeat(4000), 'npm -' + '-! -'.repeat(4000), './mvnw ' + 'x '.repeat(4000), 'npx ' + '-a '.repeat(4000) + 'vitest']) {
      const t = performance.now();
      isTestCommand(root, p);
      expect(performance.now() - t).toBeLessThan(500);
    }
  });
});

describe('edits after the last test run', () => {
  it('names the symbol edited after the run, not the one before it', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('JSON.parse(s)', 'JSON.parse(s.trim())'));
    await shell(root, 'npm test', 0);
    await edit(root, 'src/config.ts', CONFIG.replace('JSON.parse(s)', 'JSON.parse(s.trim())').replace('a: 1', 'a: 2'));
    const msg = await stop(root);
    expect(msg).toContain('Edited after the last test run (`npm test`');
    expect(msg).toContain('exit 0');
    expect(msg).toContain('loadDefaults (src/config.ts)');
    expect(msg).not.toContain('parseConfig');
  });

  it('a file first edited after the run is compared with what the run saw', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 3'));
    await shell(root, 'pnpm test:unit');
    await edit(root, 'src/other.ts', 'export function other() {\n  return 2;\n}\n');
    const msg = await stop(root);
    expect(msg).toContain('other (src/other.ts)');
    expect(msg).not.toContain('loadDefaults');
  });

  it('nothing edited after a passing run: nothing said; after a failing run: the failure is said', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 4'));
    await shell(root, 'npm test', 0);
    expect(await stop(root)).not.toContain('test run');
    const failed = repo();
    await edit(failed, 'src/config.ts', CONFIG.replace('a: 1', 'a: 5'));
    await shell(failed, 'npm test', 1);
    expect(await stop(failed)).toContain('failed, and nothing was edited after it');
  });

  it('shell commands seen but no test run: the edited files are named', async () => {
    const root = repo();
    await shell(root, 'git status');
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 6'));
    const msg = await stop(root);
    expect(msg).toContain('No completed test run was observed this session after editing src/config.ts');
    expect(readRunState(root, 's1').shellSeen).toBe(1);
  });

  it('no shell command ever observed: the fact is withheld with the reason', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 7'));
    const msg = await stop(root);
    expect(msg).toContain('Test runs are not observed in this session');
    expect(msg).not.toContain('No completed test run');
  });

  it('a non-test shell command prints nothing and records no run', async () => {
    const root = repo();
    expect((await shell(root, 'npm run build')).stdout).toBe('');
    expect(readRunState(root, 's1').runs).toEqual([]);
  });

  it('a failing run (a tool failure in Claude Code) is recorded with its exit code', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 8'));
    await failedShell(root, 'npm test');
    expect(readRunState(root, 's1').runs).toEqual([expect.objectContaining({ command: 'npm test', exit: 2 })]);
    expect(await stop(root)).toContain('failed, and nothing was edited after it');
  });

  it('an interrupted run does not count as the last run', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 9'));
    await runHook('after-tools', JSON.stringify({ session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { interrupted: true } }));
    expect(await stop(root)).toContain('No completed test run was observed');
  });

  it('a deleted symbol is named removed; without a pre-edit record the file is "not determined"', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 10'));
    await shell(root, 'npm test', 0);
    await edit(root, 'src/config.ts', 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\n');
    expect(await stop(root)).toContain('loadDefaults (src/config.ts) [removed]');
    const off = repo();
    await edit(off, 'src/config.ts', CONFIG.replace('a: 1', 'a: 11'));
    await shell(off, 'npm test', 0);
    // after-tools only (the before-edit moment was off or timed out)
    write(off, 'src/other.ts', 'export function other() {\n  return 3;\n}\n');
    await runHook('after-tools', JSON.stringify({ session_id: 's1', cwd: off, tool_name: 'Edit', tool_input: { file_path: join(off, 'src/other.ts') } }));
    const msg = await stop(off);
    expect(msg).toContain('src/other.ts (which symbols is not determined)');
    expect(msg).not.toContain('other (src/other.ts)');
  });

  it('without an index, tests are "not computed", never "no test reaches them"', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 12'));
    await shell(root, 'npm test', 0);
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 13'));
    const msg = await stop(root);
    expect(msg).toContain('not computed');
    expect(msg).not.toContain('No indexed test reaches them');
    expect(msg).toContain('shell commands are not tracked');
  });

  it('secrets and assignments in the command are not stored or shown', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 14'));
    await shell(root, 'OPENAI_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz0123 npm test', 1);
    const stored = JSON.stringify(readRunState(root, 's1'));
    expect(stored).not.toContain('sk-live');
    expect(readRunState(root, 's1').runs[0].command).toBe('npm test');
  });
});
