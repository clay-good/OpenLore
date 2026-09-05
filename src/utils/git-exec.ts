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
 * a direct `execFileSync('git', ...)` call; `spawnGit` / `spawnGitSync` in place
 * of a direct `spawn`/`spawnSync` of `git` — the streaming shapes (`git cat-file
 * --batch`, a fd-redirected `spawnSync`) that the execFile helpers cannot express.
 *
 * Typed like the `node:child_process` functions they wrap. The ONE deliberate
 * difference is `execFileGitSync`'s default encoding: `execFileSync` returns a
 * `Buffer` unless an encoding is given, which makes the ergonomic
 * `execFileGitSync('git', args, { cwd }).trim()` a runtime `TypeError`. This
 * module defaults that call to `'utf-8'` so a plain-options call really does
 * return the `string` its signature promises; pass `{ encoding: 'buffer' }` for
 * bytes.
 *
 * Structural guards fail CI on a regression: `git-exec.test.ts` on a new `git`
 * spawn that skips this file, and `windows-hidden-spawn-guard.test.ts` on ANY
 * subprocess spawned without `windowsHide` and without an inherited console.
 */

import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ExecFileOptions,
  type ExecFileSyncOptions,
} from 'node:child_process';
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

/**
 * `execFileSync`, `windowsHide: true` always applied.
 *
 * Also defaults `encoding` to `'utf-8'`. Node's own `execFileSync` returns a `Buffer` when no
 * encoding is given, so the `string` overload below would otherwise be a lie that only fails at
 * runtime (`.trim()` on a Buffer). Callers that want bytes ask for them: `{ encoding: 'buffer' }`.
 */
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
  return execFileSync(file, args, { encoding: 'utf-8', ...options, windowsHide: true });
}

/**
 * `spawn`, `windowsHide: true` always applied — for the streaming shapes `execFile` cannot
 * express (a long-lived `git cat-file --batch` fed over stdin).
 *
 * Typed as `typeof spawn` rather than re-declared, so every one of Node's overloads survives the
 * wrapper — including the stdio-tuple narrowing that makes `child.stdin`/`stdout` non-nullable for
 * a `{ stdio: ['pipe', 'pipe', 'pipe'] }` call. Re-declaring a single signature here would widen
 * those back to `| null` at every call site.
 */
export const spawnGit: typeof spawn = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transparent pass-through to the overloads above
  file: any, args?: any, options?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ditto
): any => spawn(file, args, { ...(options ?? {}), windowsHide: true });

/**
 * `spawnSync`, `windowsHide: true` always applied — for the synchronous shapes `execFileSync`
 * cannot express (redirecting the child's stdout/stderr straight onto file descriptors).
 *
 * Typed as `typeof spawnSync` for the same reason as {@link spawnGit}: it preserves the
 * encoding-dependent `SpawnSyncReturns<string>` / `SpawnSyncReturns<Buffer>` split.
 */
export const spawnGitSync: typeof spawnSync = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transparent pass-through to the overloads above
  file: any, args?: any, options?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ditto
): any => spawnSync(file, args, { ...(options ?? {}), windowsHide: true });
