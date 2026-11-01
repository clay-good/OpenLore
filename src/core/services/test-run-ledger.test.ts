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
const stop = async (root: string) => {
  const out = (await runHook('before-stop', JSON.stringify({ session_id: 's1', cwd: root }), { timeoutMs: 45_000 })).stdout;
  return out ? (JSON.parse(out) as { systemMessage?: string }).systemMessage ?? '' : '';
};

describe('isTestCommand', () => {
  it('recognizes runners, package-manager test scripts, declared scripts, and make targets', () => {
    const root = repo();
    for (const c of ['npm test', 'pnpm test -- --run', 'yarn test', 'npx vitest run src', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test', 'cd app && npm run test', 'make test', 'make check-unit', 'pnpm test:unit', 'npm run test:unit', './gradlew test'])
      expect(isTestCommand(root, c), c).toBe(true);
    for (const c of ['npm install', 'npm run lint', 'git status', 'ls tests/', 'cat test.txt', 'echo testing', 'npm run build'])
      expect(isTestCommand(root, c), c).toBe(false);
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
    expect(msg).toContain('No test run was observed this session after editing src/config.ts');
    expect(readRunState(root, 's1').shellSeen).toBe(1);
  });

  it('no shell command ever observed: the fact is withheld with the reason', async () => {
    const root = repo();
    await edit(root, 'src/config.ts', CONFIG.replace('a: 1', 'a: 7'));
    const msg = await stop(root);
    expect(msg).toContain('Test runs are not observed in this session');
    expect(msg).not.toContain('No test run was observed');
  });

  it('a non-test shell command prints nothing and records no run', async () => {
    const root = repo();
    expect((await shell(root, 'npm run build')).stdout).toBe('');
    expect(readRunState(root, 's1').runs).toEqual([]);
  });
});
