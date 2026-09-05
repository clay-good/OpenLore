import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PlatformCommand {
  command: string;
  args: string[];
}

export interface PlatformCommandRuntime {
  nodeExecutable?: string;
  npmExecPath?: string;
  pathValue?: string;
  cwd?: string;
  fileExists?: (path: string) => boolean;
  /**
   * Override the resolved OpenLore CLI entry. `null` forces the portable npx form.
   * Distinct from `fileExists`, which exists only to locate the npm CLI on Windows.
   */
  openloreCliEntry?: string | null;
}

const WINDOWS_COMMAND_SHIMS = new Set(['npm', 'npx']);

function isWithinDirectory(path: string, directory: string): boolean {
  const relative = win32.relative(
    win32.resolve(directory).toLowerCase(),
    win32.resolve(path).toLowerCase(),
  );
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative));
}

function resolveNpmCli(
  command: string,
  nodeExecutable: string,
  runtime: PlatformCommandRuntime,
): string {
  const cli = command.toLowerCase() === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  const candidates: string[] = [];
  const cwd = runtime.cwd ?? process.cwd();
  if (runtime.npmExecPath && win32.isAbsolute(runtime.npmExecPath)) {
    const npmExecCandidate = win32.join(win32.dirname(runtime.npmExecPath), cli);
    if (!isWithinDirectory(npmExecCandidate, cwd)) candidates.push(npmExecCandidate);
  }

  const pathValue = runtime.pathValue ?? (process.platform === 'win32' ? process.env.PATH : '');
  for (const dir of (pathValue ?? '').split(';')) {
    if (!win32.isAbsolute(dir) || isWithinDirectory(dir, cwd)) continue;
    candidates.push(win32.join(dir, 'node_modules', 'npm', 'bin', cli));
  }
  const adjacentCandidate = win32.join(
    win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', cli,
  );
  if (!isWithinDirectory(adjacentCandidate, cwd)) candidates.push(adjacentCandidate);

  const fileExists = runtime.fileExists ?? existsSync;
  const resolved = [...new Set(candidates)].find((candidate) => fileExists(candidate));
  if (!resolved) {
    throw new Error(`Could not locate ${cli} in the Windows npm installation`);
  }
  return resolved;
}

/**
 * Return a child-process invocation that can launch Node package-manager shims
 * on the selected platform. Windows `.cmd` files require a shell, so avoid that
 * boundary entirely: run the npm CLI entry point through the already-running,
 * absolute Node executable. Other commands and platforms pass through unchanged.
 */
export function resolvePlatformCommand(
  command: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): PlatformCommand {
  if (platform === 'win32' && WINDOWS_COMMAND_SHIMS.has(command.toLowerCase())) {
    const nodeExecutable = runtime.nodeExecutable ?? process.execPath;
    if (!win32.isAbsolute(nodeExecutable)) {
      throw new Error(`Windows command resolution requires an absolute Node executable: ${command}`);
    }
    return {
      command: nodeExecutable,
      args: [resolveNpmCli(command, nodeExecutable, runtime), ...args],
    };
  }
  return { command, args: [...args] };
}

/** Format a resolved fixed-argv invocation for dry-run output and config command fields. */
export function formatPlatformCommand(invocation: PlatformCommand): string {
  return [invocation.command, ...invocation.args]
    .map((part) => /[\s&|<>^%!()]/.test(part) ? `"${part}"` : part)
    .join(' ');
}

/**
 * npm unpacks `npx` downloads under a `_npx` cache directory it is free to evict.
 * Such a path must never be written into a host config file: it would resolve today
 * and be gone tomorrow. Mirrors the detection `openlore update` already uses.
 */
function isTransientInstall(entryPath: string): boolean {
  const parts = entryPath.split('\\').join('/').split('/');
  return parts.includes('_npx');
}

/**
 * OpenLore's own CLI entry point, or `null` when it must not be wired into a config.
 *
 * `null` covers two cases, both of which fall back to the portable `npx` form:
 * running from TypeScript source (no built sibling), and running out of an npx cache
 * (a path that is deleted behind us).
 */
export function openloreCliEntry(runtime: PlatformCommandRuntime = {}): string | null {
  const override = runtime.openloreCliEntry;
  if (override === null) return null;
  let entry: string;
  if (override !== undefined) {
    // An injected entry is the caller's assertion that the file is there, so it skips the
    // existence probe - but NOT the transience guard, which is about whether the path may
    // be written into a config at all.
    entry = override;
  } else {
    try {
      entry = fileURLToPath(new URL('../cli/index.js', import.meta.url));
    } catch {
      return null;
    }
    if (!existsSync(entry)) return null;
  }
  return isTransientInstall(entry) ? null : entry;
}

/**
 * Resolve an invocation of OpenLore's OWN CLI for a host config file (MCP server
 * entry, agent hook, …).
 *
 * `npx --yes openlore <args>` is portable but wrong on Windows.
 * `resolvePlatformCommand` above removes the shim for `npx` ITSELF, yet npx then
 * launches the TARGET package's bin through its own shim:
 *
 *     cmd.exe /d /s /c openlore orient --inject
 *
 * — a real, visible console window (plus a `conhost.exe`) every time the command
 * runs. For a `UserPromptSubmit` hook that is one window per agent turn, which is
 * what made the app unusable on Windows.
 *
 * `openlore install` IS openlore, so the CLI entry beside this module is the very
 * build the user just invoked. Wire that directly with the absolute Node executable:
 * no shim, no `cmd.exe`, and one process hop fewer on every invocation.
 *
 * TRADE-OFF: this writes an absolute path, so it binds the config to this install
 * location. A global npm install keeps that path across upgrades; a moved or removed
 * install needs `openlore install` re-run, where the `npx` form would have re-fetched.
 * That is the deliberate price of not opening a window on every turn.
 */
export function resolveOpenloreCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtime: PlatformCommandRuntime = {},
): PlatformCommand {
  const entry = openloreCliEntry(runtime);
  const nodeExecutable = runtime.nodeExecutable ?? process.execPath;
  // On Windows the Node path is spliced into a config the host spawns without a
  // shell, so it must be absolute — the same precondition resolvePlatformCommand
  // enforces. Anything else falls back rather than emitting an unusable command.
  if (entry && (platform !== 'win32' || win32.isAbsolute(nodeExecutable))) {
    return { command: nodeExecutable, args: [entry, ...args] };
  }
  return resolvePlatformCommand('npx', ['--yes', 'openlore', ...args], platform, runtime);
}
