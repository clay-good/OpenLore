/**
 * The prompt-submitted moment states its no-index line and its build note once per harness session
 * (change: hook-reliability, task 4.3). Real filesystem; only stdin is supplied by the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stdin = vi.hoisted(() => ({ raw: '' }));
vi.mock('../../utils/stdin.js', () => ({ readStdin: async () => stdin.raw }));

import { injectOutput } from './orient.js';
import { pointerLineFor, SILENCE_CONTRACT_LINE } from './orient-inject-render.js';

const NO_GRAPH = pointerLineFor('no-graph');
let root = '';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'olinjectonce-')));
  writeFileSync(join(root, 'f.ts'), 'export function f() { return 1; }\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.openlore'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const prompt = (session?: string) => { stdin.raw = JSON.stringify({ ...(session ? { session_id: session } : {}), prompt: 'change f to return 2' }); };

describe('no-index notices, once per session', () => {
  it('two prompts in one session with no index print the line once; a new session prints it again', async () => {
    prompt('s1');
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
    prompt('s1');
    expect(await injectOutput(root, undefined)).toBe('');
    prompt('s2');
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
  });

  it('a build in flight is never stated to the agent (task 9.4)', async () => {
    prompt('s1');
    expect(await injectOutput(root, undefined, 'An index build is running.')).toBe('');
    // ... and does not use up the session's one no-index line.
    prompt('s1');
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
  });

  it('without a session id, every prompt says it (nothing is deduplicated)', async () => {
    prompt();
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
  });

  it('with no .openlore/ (auto-init off), it says it every time and writes nothing', async () => {
    rmSync(join(root, '.openlore'), { recursive: true, force: true });
    prompt('s1');
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
    expect(await injectOutput(root, undefined)).toBe(NO_GRAPH);
    expect(existsSync(join(root, '.openlore'))).toBe(false);
  });
});

describe('the silence contract, once per session (change: anchor-gated-prompt-briefing)', () => {
  it('the first prose prompt of a session explains silence; later ones say nothing; a new session explains it again', async () => {
    mkdirSync(join(root, '.openlore', 'analysis'), { recursive: true });
    writeFileSync(join(root, '.openlore', 'analysis', 'llm-context.json'), '{}');
    const say = (session: string, text: string) => { stdin.raw = JSON.stringify({ session_id: session, prompt: text }); };
    say('s1', 'please start group 2 and drive it to merge');
    expect(await injectOutput(root, undefined)).toBe(SILENCE_CONTRACT_LINE);
    say('s1', 'push and open the PR');
    expect(await injectOutput(root, undefined)).toBe('');
    say('s1', 'please fix ci on 708');
    expect(await injectOutput(root, undefined)).toBe('');
    say('s2', 'thanks, continue');
    expect(await injectOutput(root, undefined)).toBe(SILENCE_CONTRACT_LINE);
  });
});

