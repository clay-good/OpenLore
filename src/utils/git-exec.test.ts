/**
 * fix-windows-git-spawn-console-flash — the shared `windowsHide` discipline.
 *
 * `execFileGit`/`execFileGitSync`/`spawnGit`/`spawnGitSync` are the one home for
 * spawning `git` with `windowsHide: true`. This file covers their BEHAVIOUR; the
 * structural invariants that keep them the only home live in
 * `windows-hidden-spawn-guard.test.ts`, which owns the import-aware source
 * scanner both of them need:
 *
 *   - every subprocess in `src/` sets `windowsHide` or inherits a console, and
 *   - no raw `node:child_process` spawn of `git` survives outside this module.
 *
 * They live there rather than being duplicated here: the earlier file-local
 * version of the git guard exempted any file that imported `git-exec.js`, which
 * silently excused all 30 migrated files — the ones most likely to grow the next
 * `git` spawn.
 *
 * The assertions below check the option actually reaches the spawn. A test that
 * only proved `git --version` still runs would pass just as happily with
 * `windowsHide` deleted, which is the one regression that matters here and is
 * invisible on the Linux and macOS runners this suite normally runs on.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as childProcess from 'node:child_process';
import { execFileGit, execFileGitSync, spawnGit, spawnGitSync } from './git-exec.js';

/** The `util.promisify.custom` implementation Node attaches to `execFile`. */
type CustomExecFile = (file: unknown, args: unknown, options: unknown) => Promise<{ stdout: string; stderr: string }>;

/** Options recorded off the promisified `execFile` path — see the mock factory below. */
const recorded = vi.hoisted(() => ({ promisifiedExecFile: [] as unknown[][] }));

/**
 * An ESM module namespace is not configurable, so `vi.spyOn(childProcess, 'spawn')` throws. Mock
 * the module instead, delegating to the real implementations so these stay behavioural tests that
 * actually run `git`.
 *
 * TWO subtleties, both of which silently produce a green vacuous test if missed:
 *
 *  1. `execFile` carries a `util.promisify.custom` implementation. A plain `vi.fn(actual.execFile)`
 *     drops that symbol, `promisify` falls back to callback convention and resolves with stdout
 *     ALONE — so `const { stdout } = await execFileGit(...)` quietly becomes `undefined`.
 *  2. `git-exec.ts` promisifies `execFile` at import time, and the custom implementation calls the
 *     real binding directly. So the async path never touches the `vi.fn` on the namespace, and
 *     asserting on `childProcess.execFile.mock` would report zero calls forever. The custom
 *     implementation is therefore wrapped, recording into `recorded` before delegating.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const custom = (actual.execFile as unknown as Record<symbol, CustomExecFile>)[promisify.custom];
  const execFile = vi.fn(actual.execFile);
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: unknown, args: unknown, options: unknown) => {
      recorded.promisifiedExecFile.push([file, args, options]);
      return custom(file, args, options);
    },
  });
  return {
    ...actual,
    execFile,
    execFileSync: vi.fn(actual.execFileSync),
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

/** The options argument the wrapper handed to the real child_process function. */
function optionsOfFirstCall(fn: unknown): unknown {
  return (fn as Mock).mock.calls[0][2];
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.promisifiedExecFile.length = 0;
});

describe('execFileGit / execFileGitSync', () => {
  it('really runs git', async () => {
    // `git --version` is cheap, side-effect-free, and available in any dev/CI env
    // that can run this suite at all (the repo itself is a git checkout).
    const { stdout } = await execFileGit('git', ['--version']);
    expect(stdout).toMatch(/git version/i);
  });

  it('passes windowsHide: true to the underlying execFile', async () => {
    const { stdout } = await execFileGit('git', ['--version']);
    expect(stdout).toMatch(/git version/i);
    expect(recorded.promisifiedExecFile).toHaveLength(1);
    expect(recorded.promisifiedExecFile[0][2]).toMatchObject({ windowsHide: true });
  });

  it('passes windowsHide: true to execFileSync, and a caller cannot turn it off', () => {
    // A caller passing `windowsHide: false` must not be able to reintroduce the bug.
    execFileGitSync('git', ['--version'], { windowsHide: false });
    expect(optionsOfFirstCall(childProcess.execFileSync)).toMatchObject({ windowsHide: true });
  });

  it('defaults execFileGitSync to utf-8 so a plain call returns the string its type promises', () => {
    // Node's execFileSync returns a Buffer when no encoding is given, so this
    // ergonomic shape used to be a runtime TypeError against a `string` signature.
    const out = execFileGitSync('git', ['--version']);
    expect(typeof out).toBe('string');
    expect(out.trim()).toMatch(/git version/i);
  });

  it('still returns bytes when the caller asks for them', () => {
    const out = execFileGitSync('git', ['--version'], { encoding: 'buffer' });
    expect(Buffer.isBuffer(out)).toBe(true);
  });
});

describe('spawnGit / spawnGitSync', () => {
  it('spawnGitSync passes windowsHide and returns git output', () => {
    const result = spawnGitSync('git', ['--version'], { encoding: 'utf-8' });
    expect(optionsOfFirstCall(childProcess.spawnSync)).toMatchObject({ windowsHide: true });
    expect(String(result.stdout)).toMatch(/git version/i);
  });

  it('spawnGit passes windowsHide and streams git output', async () => {
    const child = spawnGit('git', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    expect(optionsOfFirstCall(childProcess.spawn)).toMatchObject({ windowsHide: true });

    const out = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout?.on('data', (c: Buffer) => { text += c.toString(); });
      child.on('close', () => resolve(text));
      child.on('error', reject);
    });
    expect(out).toMatch(/git version/i);
  });

  it('keeps the stdio-tuple typing that makes piped streams non-nullable', () => {
    // A re-declared single signature would widen `child.stdin` back to `| null` at
    // every call site; git-diff's `git cat-file --batch` reader depends on it.
    const child = spawnGit('git', ['cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child.stdin).toBeTruthy();
    expect(child.stdout).toBeTruthy();
    child.stdin.end();
    child.kill();
  });
});
