import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

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
