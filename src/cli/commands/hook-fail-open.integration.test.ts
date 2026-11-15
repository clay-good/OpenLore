/**
 * The fail-open contract through the built CLI, as a harness runs it (change: hook-reliability,
 * task 2.2). For every hook moment, in a repository whose `.openlore/` is corrupt (config, session
 * record, and index), `openlore hook <moment>` must exit 0 and write nothing to stdout or stderr.
 *
 * The environment is the user's, unchanged: no `OPENLORE_NO_AUTO_HEAP`, so the CLI's start-up path
 * (heap sizing, update checks) is covered too. Run with `npm run build && npm run test:integration`;
 * it is part of `test:integration:ci`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HOOK_MOMENTS } from './hook.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };

let root = '';

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run \`npm run build\` first`);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'olhookcli-')));
  write('.gitignore', '.openlore/\n');
  write('src/f.ts', 'export function f() { return 1; }\n');
  write('src/f.test.ts', "import { f } from './f';\nit('a', () => { expect(f()).toBe(1); });\n");
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  // The corrupt store: config, session record, and index.
  write('.openlore/config.json', '{"hooks": {');
  write(`.openlore/session-ledger/hook-delivered/${createHash('sha256').update('s1').digest('hex').slice(0, 24)}.json`, '{"keys": [');
  write('.openlore/analysis/llm-context.json', '{"callGraph": {');
  write('.openlore/analysis/call-graph.db', 'SQLite format 3\0truncated');
  // A session change, so every moment has something to look at.
  write('src/f.ts', 'export function f() { return 2; }\n');
});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

/** One payload per moment, in Claude Code's shape. */
function payload(moment: string): string {
  const base = { session_id: 's1', cwd: root };
  const file = join(root, 'src/f.ts');
  switch (moment) {
    case 'before-edit': return JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'return 2', new_string: 'return 3' } });
    case 'after-tools': return JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, tool_response: {} });
    case 'before-stop': return JSON.stringify({ ...base, hook_event_name: 'Stop', stop_hook_active: false });
    case 'after-compact': return JSON.stringify({ ...base, hook_event_name: 'SessionStart', source: 'compact' });
    case 'before-subagent': return JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'rename f', subagent_type: 'general-purpose' } });
    case 'subagent-start': return JSON.stringify({ ...base, hook_event_name: 'SubagentStart', agent_type: 'general-purpose' });
    default: throw new Error(moment);
  }
}

function run(args: string[], input: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', timeout: 60_000 });
}

describe('openlore hook on a corrupt .openlore/', () => {
  /**
   * after-compact states the git state of the change, and before-stop tells the user what it saw of
   * the session (edits, test runs). Both may speak; neither may say anything about the broken store.
   */
  const MAY_SPEAK = new Set(['after-compact', 'before-stop']);

  it.each([...HOOK_MOMENTS])('%s exits 0 with empty stdout and stderr', (moment) => {
    const r = run(['hook', moment], payload(moment));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    if (MAY_SPEAK.has(moment)) {
      const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { additionalContext: string }; systemMessage?: string };
      const text = out.hookSpecificOutput?.additionalContext ?? out.systemMessage ?? '';
      expect(text).toMatch(/^\[openlore /);
      expect(text).not.toMatch(/openlore analyze|index/i);
      expect(text).not.toContain(root);
      expect(text).not.toMatch(/\b(error|exception|ENOENT|ENOTDIR|SyntaxError|corrupt|malformed)\b/i);
    } else {
      expect(r.stdout).toBe('');
    }
  });

  it.each([...HOOK_MOMENTS])('%s exits 0 silently on an unreadable payload', (moment) => {
    const r = run(['hook', moment], 'not json {');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    if (!MAY_SPEAK.has(moment)) expect(r.stdout).toBe('');
  });

  it('an unknown moment exits 0 silently', () => {
    const r = run(['hook', 'no-such-moment'], payload('before-stop'));
    expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
  });
});

describe('openlore orient --inject (the prompt-submitted moment)', () => {
  const prompt = (cwd: string) => JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'UserPromptSubmit', prompt: 'change f to return 3 and update its test' });
  const inject = (cwd: string) => spawnSync(process.execPath, [CLI, 'orient', '--inject'], { cwd, input: prompt(cwd), encoding: 'utf8', timeout: 60_000 });

  it('on a corrupt store: exits 0, empty stderr, and says nothing about a failure', () => {
    const r = inject(root);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).not.toMatch(/orientation failed|error|exception|SyntaxError/i);
    if (r.stdout.trim()) expect(r.stdout.trim()).toMatch(/^\[OpenLore\]/);
  });

  it('with hooks.prompt-submitted false: prints nothing and starts no index build', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'olpromptoff-')));
    try {
      mkdirSync(join(dir, '.openlore'));
      writeFileSync(join(dir, '.openlore', 'config.json'), JSON.stringify({ hooks: { 'prompt-submitted': false } }));
      writeFileSync(join(dir, 'f.ts'), 'export const f = 1;\n');
      execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
      const r = inject(dir);
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
      // No build was started: nothing beyond the config was written into .openlore/.
      expect(readdirSync(join(dir, '.openlore'))).toEqual(['config.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
