/**
 * Resolve the hook path Git actually executes (change: fix-commit-gate-delivery).
 *
 * `git rev-parse --git-path hooks` accounts for core.hooksPath, linked worktrees,
 * and GIT_DIR.  The fallback preserves the old behavior when Git itself is not
 * available, but callers can distinguish that from a Git-verified repository.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isAbsolute, basename, dirname, join, resolve, sep } from 'node:path';
import { access, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileExists } from '../utils/command-helpers.js';
import { sanitizeForTerminal } from '../utils/misc.js';

const execFileAsync = promisify(execFile);

export interface GitHookTarget {
  effectiveHooksDir: string;
  hookPath: string;
  executionPath: string;
  resolvedByGit: boolean;
  manager?: 'husky' | 'lefthook' | 'disabled' | 'unavailable';
  canInstall: boolean;
}

async function effectiveHooksDirectory(rootPath: string): Promise<{
  path: string;
  resolvedByGit: boolean;
}> {
  const reported = await resolveGitPath(rootPath, 'hooks');
  if (reported) return { path: reported, resolvedByGit: true };
  return { path: join(rootPath, '.git', 'hooks'), resolvedByGit: false };
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
