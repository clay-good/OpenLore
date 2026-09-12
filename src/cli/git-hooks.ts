/**
 * Resolve the hook path Git actually executes (change: fix-commit-gate-delivery).
 *
 * The effective hooks directory accounts for core.hooksPath, linked worktrees, and
 * GIT_DIR.  The fallback preserves the old behavior when Git itself is not available,
 * but callers can distinguish that from a Git-verified repository.
 *
 * Both inputs are read from a repository OpenLore does not trust, so both are checked
 * here rather than assumed: the write target is confined to the repository, and a
 * pre-existing hook OpenLore did not write is never republished as executable.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileExists } from '../utils/command-helpers.js';
import { sanitizeForTerminal } from '../utils/misc.js';
import { isConfinedPath } from '../utils/path-confinement.js';
import { execFileGit as execFileAsync } from '../utils/git-exec.js';


export interface TrustedHookLauncher { node: string; cli: string }

/** Resolve the exact external Node + OpenLore entry used by an installed hook. */
export async function resolveTrustedHookLauncher(rootPath: string): Promise<TrustedHookLauncher | null> {
  try {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    let cli: string;
    try { cli = await realpath(join(moduleDir, 'index.js')); }
    catch { cli = await realpath(resolve(moduleDir, '../../dist/cli/index.js')); }
    const node = await realpath(process.execPath);
    if (isConfinedPath(rootPath, node) || isConfinedPath(rootPath, cli)) return null;
    return { node, cli };
  } catch {
    return null;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function renderTrustedHookCommand(
  launcher: TrustedHookLauncher,
  args: string[],
): string {
  return [launcher.node, launcher.cli, ...args].map(shellQuote).join(' ');
}

export interface GitHookTarget {
  effectiveHooksDir: string;
  hookPath: string;
  executionPath: string;
  resolvedByGit: boolean;
  manager?: 'husky' | 'lefthook' | 'disabled' | 'unavailable' | 'unconfined';
  canInstall: boolean;
}

/**
 * The effective `core.hooksPath`, ignoring the one OpenLore's own git wrapper sets.
 *
 * `git rev-parse --git-path hooks` can no longer answer this: every git spawn routed
 * through `execFileGit` carries `-c core.hooksPath=` (it must — a repository's config
 * keys are command strings git executes), and with that override git reports the hooks
 * path as `./`, i.e. the working tree root, where git never looks for a hook. So read
 * the VALUE instead: `--show-scope --get-all` lists every configured value with its
 * scope, and the last one whose scope is not `command` is what git would use if
 * OpenLore were not overriding it. Empty output means no scope configures one.
 */
async function configuredHooksPath(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--show-scope', '--get-all', 'core.hooksPath'],
      { cwd: rootPath },
    );
    let configured: string | null = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.indexOf('\t');
      if (separator < 0) continue;
      const scope = line.slice(0, separator);
      if (scope === 'command') continue; // ours, not the repository's or the operator's
      const value = line.slice(separator + 1);
      if (value) configured = value;
    }
    return configured;
  } catch {
    return null; // unset (exit 1) or git unavailable
  }
}

async function effectiveHooksDirectory(rootPath: string): Promise<{
  path: string;
  resolvedByGit: boolean;
}> {
  const configured = await configuredHooksPath(rootPath);
  // Relative values resolve against the working tree, which is how git reported them
  // before (`--git-path` printed `.githooks` for `core.hooksPath=.githooks`).
  if (configured) {
    return {
      path: isAbsolute(configured) ? configured : resolve(rootPath, configured),
      resolvedByGit: true,
    };
  }
  // No configured path: git uses the repository proper's `hooks/` — the COMMON dir, so
  // a linked worktree and an explicit GIT_DIR both land where git actually looks.
  const commonDir = await gitCommonDirectory(rootPath);
  if (commonDir) return { path: join(commonDir, 'hooks'), resolvedByGit: true };
  return { path: join(rootPath, '.git', 'hooks'), resolvedByGit: false };
}

/**
 * The repository proper (`--git-common-dir`), or null when Git cannot say.
 *
 * Needed as a SECOND confinement base beside the checkout: for a linked worktree
 * and for an explicit `GIT_DIR`, the hooks Git runs live under the common dir,
 * which is outside the checkout. Unlike `core.hooksPath`, this value is not
 * something a cloned repository's own config can redirect.
 */
async function gitCommonDirectory(rootPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: rootPath,
    });
    const reported = stdout.replace(/\r?\n$/, '');
    if (!reported) return null;
    return isAbsolute(reported) ? reported : resolve(rootPath, reported);
  } catch {
    return null;
  }
}

/** The platform's bit bucket, the conventional `core.hooksPath` value for "no hooks". */
function isNullDevice(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === '/dev/null' || /^(?:[A-Za-z]:\/)?NUL$/i.test(normalized);
}

/**
 * Is `hooksDir` somewhere OpenLore may publish an EXECUTABLE file?
 *
 * `core.hooksPath` is read out of the checked-out repository's own config, and a
 * repository delivered as an archive can ship `.git/config` along with it — so the
 * hooks directory is attacker-authored input, exactly like the launcher confined in
 * `resolveTrustedHookLauncher`. A committed `core.hooksPath = ~/.local/bin` would
 * otherwise make `openlore install` create (or append to, and chmod +x) a file
 * anywhere on the operator's machine. A sibling change stops OpenLore's own git
 * spawns from OBEYING `core.hooksPath`; this site READS it to choose a write
 * target, so it needs its own check.
 */
async function isHookWriteTargetConfined(rootPath: string, hooksDir: string): Promise<boolean> {
  // `core.hooksPath=/dev/null` (`NUL` on Windows) is the documented way to turn hooks
  // OFF, and it is the one out-of-repository value that can never receive an
  // executable file — `updateHookFile` refuses it as "not a regular file". Treating it
  // as an escape would report a deliberate disable as an attack.
  if (isNullDevice(hooksDir)) return true;
  if (isConfinedPath(rootPath, hooksDir)) return true;
  const commonDir = await gitCommonDirectory(rootPath);
  return commonDir !== null && isConfinedPath(commonDir, hooksDir);
}

export async function resolveGitPath(rootPath: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', name], {
      cwd: rootPath,
    });
    const reported = stdout.replace(/\r?\n$/, '');
    if (reported) return isAbsolute(reported) ? reported : resolve(rootPath, reported);
  } catch {
    return null;
  }
  return null;
}

function huskyRoot(hooksDir: string): string | null {
  const parts = resolve(hooksDir).split(sep);
  const index = parts.lastIndexOf('.husky');
  if (index < 0) return null;
  const prefix = parts.slice(0, index + 1).join(sep);
  return prefix || sep;
}

async function hasLefthookConfig(rootPath: string): Promise<boolean> {
  const names = ['lefthook', '.lefthook', 'lefthook-local', '.lefthook-local']
    .flatMap((base) => ['yml', 'yaml', 'toml', 'json', 'jsonc'].map((extension) => `${base}.${extension}`));
  const configs = await Promise.all([
    ...names,
    ...names.map((name) => join('.config', name)),
  ].map(async (name) => {
    try {
      await readFile(join(rootPath, name), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }));
  return configs.some(Boolean);
}

export async function resolveGitHookTarget(
  rootPath: string,
  hookName: 'pre-commit' | 'post-commit',
): Promise<GitHookTarget> {
  const resolved = await effectiveHooksDirectory(rootPath);
  const executionPath = join(resolved.path, hookName);
  try {
    const targetStat = await stat(resolved.path);
    if (typeof targetStat.isDirectory === 'function' && !targetStat.isDirectory()) {
      return {
        effectiveHooksDir: resolved.path,
        hookPath: resolved.path,
        executionPath: resolved.path,
        resolvedByGit: resolved.resolvedByGit,
        manager: 'disabled',
        canInstall: false,
      };
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      try {
        const unresolved = await lstat(resolved.path);
        if (unresolved.isSymbolicLink()) {
          return {
            effectiveHooksDir: resolved.path,
            hookPath: resolved.path,
            executionPath: resolved.path,
            resolvedByGit: resolved.resolvedByGit,
            manager: 'unavailable',
            canInstall: false,
          };
        }
      } catch { /* genuinely absent: the installer may create it */ }
    } else {
      return {
        effectiveHooksDir: resolved.path,
        hookPath: resolved.path,
        executionPath: resolved.path,
        resolvedByGit: resolved.resolvedByGit,
        manager: 'unavailable',
        canInstall: false,
      };
    }
  }
  // Refuse a hooks directory the repository pointed outside itself BEFORE deciding
  // which manager owns it: every branch below ends in a write, and none of them is
  // one OpenLore may make into the operator's home or PATH.
  if (!(await isHookWriteTargetConfined(rootPath, resolved.path))) {
    return {
      effectiveHooksDir: resolved.path,
      // The directory, not the hook file: the `unavailable`/`disabled` branches do the
      // same, and it keeps an uninstall caller that reads `hookPath` without checking
      // `canInstall` from writing to the escaped location (a directory is not a
      // regular file, so `updateHookFile` refuses it).
      hookPath: resolved.path,
      executionPath: resolved.path,
      resolvedByGit: resolved.resolvedByGit,
      manager: 'unconfined',
      canInstall: false,
    };
  }
  const husky = huskyRoot(resolved.path);
  if (husky) {
    let shimIsExecutable = false;
    try {
      await access(executionPath, fsConstants.X_OK);
      shimIsExecutable = true;
    } catch { /* missing or not executable */ }
    return {
      effectiveHooksDir: resolved.path,
      hookPath: join(husky, hookName),
      executionPath,
      resolvedByGit: resolved.resolvedByGit,
      manager: 'husky',
      canInstall: shimIsExecutable,
    };
  }
  if (await hasLefthookConfig(rootPath)) {
    return {
      effectiveHooksDir: resolved.path,
      hookPath: join(resolved.path, hookName),
      executionPath,
      resolvedByGit: resolved.resolvedByGit,
      manager: 'lefthook',
      canInstall: false,
    };
  }
  return {
    effectiveHooksDir: resolved.path,
    hookPath: join(resolved.path, hookName),
    executionPath,
    resolvedByGit: resolved.resolvedByGit,
    canInstall: true,
  };
}

export interface HookFileUpdateResult {
  status: 'updated' | 'unchanged' | 'unavailable';
  reason?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function reclaimStaleLock(
  lockPath: string,
  ownerPath: string,
  observedToken: string,
): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  try {
    await mkdir(reaperPath);
  } catch {
    return false;
  }

  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as {
      pid?: unknown;
      token?: unknown;
    };
    if (owner.token !== observedToken || typeof owner.pid !== 'number') return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (probeError) {
      if (errorCode(probeError) !== 'ESRCH') return false;
    }

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    await rename(lockPath, stalePath);
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    await rm(reaperPath, { recursive: true, force: true }).catch(() => {});
  }
}

/** One installed OpenLore block, whatever gate wrote it (`# openlore-<gate>-hook` … `# end-…`). */
const OPENLORE_HOOK_BLOCK = /^[ \t]*#[ \t]*openlore-[a-z-]+-hook\b[\s\S]*?^[ \t]*#[ \t]*end-openlore-[a-z-]+-hook[^\n]*$/gm;

/**
 * Does this hook file contain nothing but OpenLore's own blocks (plus a shebang,
 * comments and blank lines)?
 *
 * Used for ONE decision: whether republishing the file at mode 0755 is a mode
 * PROMOTION of somebody else's script. A marker alone is not enough to answer it —
 * a repository can commit `.git/hooks/pre-commit` carrying our marker AND a payload
 * line — so the question asked is "is every line here ours or inert", not "is a
 * marker present".
 */
function isOpenLoreAuthoredHook(content: string): boolean {
  return content
    .replace(OPENLORE_HOOK_BLOCK, '')
    .split('\n')
    .every((line) => {
      const trimmed = line.trim();
      return trimmed === '' || trimmed.startsWith('#');
    });
}

/** Serialize cross-process hook edits and publish each rewrite with one atomic rename. */
export async function updateHookFile(
  hookPath: string,
  update: (existing: string | null) => string | null | undefined,
): Promise<HookFileUpdateResult> {
  const parent = dirname(hookPath);
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    return { status: 'unavailable', reason: `cannot create the hook directory (${error instanceof Error ? error.message : String(error)})` };
  }

  const lockPath = `${hookPath}.openlore-lock`;
  const ownerPath = join(lockPath, 'owner.json');
  const lockToken = randomUUID();
  let locked = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    let createdLock = false;
    try {
      await mkdir(lockPath);
      createdLock = true;
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        token: lockToken,
        createdAt: new Date().toISOString(),
      }), 'utf-8');
      locked = true;
      break;
    } catch (error) {
      if (createdLock) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        return { status: 'unavailable', reason: `cannot publish hook-lock ownership (${error instanceof Error ? error.message : String(error)})` };
      }
      if (errorCode(error) !== 'EEXIST') {
        return { status: 'unavailable', reason: `cannot lock the hook (${error instanceof Error ? error.message : String(error)})` };
      }
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as { pid?: unknown; token?: unknown };
        if (typeof owner.pid === 'number' && typeof owner.token === 'string') {
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            if (errorCode(probeError) === 'ESRCH') {
              if (await reclaimStaleLock(lockPath, ownerPath, owner.token)) continue;
            }
          }
        }
      } catch { /* owner publication may still be in flight; retry */ }
      await delay(10);
    }
  }
  if (!locked) return { status: 'unavailable', reason: 'another hook installer held the lock for more than 2 seconds' };

  const tempPath = join(parent, `.${basename(hookPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    let existing: string | null = null;
    let existingIsExecutable = false;
    let hookHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      hookHandle = await open(
        hookPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      const info = await hookHandle.stat();
      if (!info.isFile()) {
        return { status: 'unavailable', reason: 'the hook target is not a regular file' };
      }
      existingIsExecutable = (info.mode & 0o111) !== 0;
      existing = await hookHandle.readFile({ encoding: 'utf-8' });
    } catch (error) {
      if (errorCode(error) === 'ELOOP') {
        return { status: 'unavailable', reason: 'the hook target is not a regular file' };
      }
      if (errorCode(error) !== 'ENOENT') {
        return { status: 'unavailable', reason: `cannot inspect the hook target (${error instanceof Error ? error.message : String(error)})` };
      }
    } finally {
      await hookHandle?.close().catch(() => {});
    }

    const next = update(existing);
    if (next === null || next === existing) return { status: 'unchanged' };
    if (next === undefined) {
      if (existing === null) return { status: 'unchanged' };
      await rm(hookPath);
      return { status: 'updated' };
    }
    // MODE PROMOTION. Every caller's update APPENDS to what it read, and this write
    // publishes the result at 0755 — so a hook that is NOT executable today, which
    // Git therefore ignores, would be handed back to Git as runnable code. A
    // repository delivered as an archive or template can carry `.git/hooks/pre-commit`
    // exactly that way: OpenLore, not Git, would be what makes it run at the next
    // commit. Refuse rather than absorb content we did not write; a hook OpenLore
    // itself published is already 0755, so a re-run is unaffected.
    if (existing !== null && !existingIsExecutable && !isOpenLoreAuthoredHook(existing)) {
      return {
        status: 'unavailable',
        reason: 'the existing hook is not executable and OpenLore did not write it, so publishing it back as executable (0755) would make Git start running code it ignores today — review that file, then remove it or make it executable yourself and re-run',
      };
    }
    await writeFile(tempPath, next, { encoding: 'utf-8', mode: 0o755, flag: 'wx' });
    await rename(tempPath, hookPath);
    return { status: 'updated' };
  } catch (error) {
    return { status: 'unavailable', reason: `cannot update the hook (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
    try {
      const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as { token?: unknown };
      if (owner.token === lockToken) await rm(lockPath, { recursive: true, force: true });
    } catch { /* never remove a lock whose ownership cannot be proven */ }
  }
}

export async function isResolvedGitRepository(
  rootPath: string,
  target: GitHookTarget,
): Promise<boolean> {
  return target.resolvedByGit || fileExists(join(rootPath, '.git'));
}

export function displayHookPath(path: string): string {
  return sanitizeForTerminal(path);
}

export function hookManagerWarning(target: GitHookTarget, wiringLine: string): string {
  if (target.manager === 'unconfined') {
    return `Git's effective hooks path ${displayHookPath(target.effectiveHooksDir)} is outside this repository, so OpenLore will not write an executable file there; core.hooksPath comes from the checkout's own config. Point core.hooksPath back inside the repository, then add ${JSON.stringify(wiringLine)}.`;
  }
  if (target.manager === 'unavailable') {
    return `Git's effective hooks path ${displayHookPath(target.effectiveHooksDir)} cannot be inspected safely; fix that path, then add ${JSON.stringify(wiringLine)}.`;
  }
  if (target.manager === 'disabled') {
    return `Git hooks are disabled because the effective hooks path ${displayHookPath(target.effectiveHooksDir)} is not a directory; configure core.hooksPath to a directory, then add ${JSON.stringify(wiringLine)}.`;
  }
  if (target.manager === 'husky') {
    return `husky owns the effective hooks directory ${displayHookPath(target.effectiveHooksDir)}, but its executable shim ${displayHookPath(target.executionPath)} is unavailable; initialize Husky, then add ${JSON.stringify(wiringLine)} to ${displayHookPath(target.hookPath)}.`;
  }
  return `lefthook owns the effective hooks directory ${displayHookPath(target.effectiveHooksDir)}; add ${JSON.stringify(wiringLine)} to the lefthook ${target.hookPath.endsWith('post-commit') ? 'post-commit' : 'pre-commit'} commands.`;
}
