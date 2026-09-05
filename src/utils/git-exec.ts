/**
 * One home for spawning `git` (or any git-adjacent subprocess) from Node.
 *
 * Every call routed through here sets `windowsHide: true`. Without it, a console
 * subprocess spawned from a parent that has no attached console of its own — the
 * `openlore serve`/`mcp` daemon, a Claude Code hook invocation (`orient --inject`),
 * the Pi extension host — gets a BRAND NEW visible console window on Windows, one
 * per spawn. A hot path that shells out to `git` once per file (provenance,
 * change-coupling, decision/spec projection review status) turns that into a
 * storm of flashing windows (change: fix-windows-git-spawn-console-flash).
 * `windowsHide` is a documented no-op on macOS/Linux, so this is safe everywhere.
 *
 * Usage: `execFileGit('git', args, opts)` in place of a locally
 * `promisify(execFile)`'d call; `execFileGitSync('git', args, opts)` in place of
 * a direct `execFileSync('git', ...)` call. Typed like `execFile`/`execFileSync`
 * themselves: plain options → `string` output, `{ encoding: 'buffer' }` → `Buffer`
 * output. A structural guard (`git-exec.guard.test.ts`) fails CI on a new `git`
 * spawn that skips this file.
 */

import { execFile, execFileSync, type ExecFileOptions, type ExecFileSyncOptions } from 'node:child_process';
import { promisify } from 'node:util';

const rawExecFileAsync = promisify(execFile);

/** Promisified `execFile`, `windowsHide: true` always applied. */
export function execFileGit(
  file: string,
  args: readonly string[] | undefined,
  options: ExecFileOptions & { encoding: 'buffer' },
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export function execFileGit(
  file: string,
  args?: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }>;
export function execFileGit(
  file: string,
  args?: readonly string[],
  options?: ExecFileOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- implementation signature for the overloads above
): Promise<any> {
  return rawExecFileAsync(file, args as string[], { ...options, windowsHide: true });
}

/** `execFileSync`, `windowsHide: true` always applied. */
export function execFileGitSync(
  file: string,
  args: readonly string[] | undefined,
  options: ExecFileSyncOptions & { encoding: 'buffer' },
): Buffer;
export function execFileGitSync(
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
): string;
export function execFileGitSync(
  file: string,
  args?: readonly string[],
  options?: ExecFileSyncOptions,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- implementation signature for the overloads above
): any {
  return execFileSync(file, args, { ...options, windowsHide: true });
}
