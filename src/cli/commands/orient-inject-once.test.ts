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
import { pointerLineFor } from './orient-inject-render.js';

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

  it('the build note too', async () => {
    prompt('s1');
    expect(await injectOutput(root, undefined, 'An index build is running.')).toBe('[OpenLore] An index build is running.');
    prompt('s1');
    expect(await injectOutput(root, undefined, 'An index build is running.')).toBe('');
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
