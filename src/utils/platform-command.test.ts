import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatPlatformCommand, isOpenloreCliEntryPath, resolvePlatformCommand, resolveOpenloreCommand } from './platform-command.js';

describe('resolvePlatformCommand', () => {
  const windowsRuntime = {
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    pathValue: '',
    fileExists: () => true,
  };

  it.each([
    ['npm', 'npm-cli.js'],
    ['npx', 'npx-cli.js'],
  ])('launches the %s Windows CLI through the running Node executable', (command, cli) => {
    expect(resolvePlatformCommand(command, ['--yes', 'openlore'], 'win32', windowsRuntime)).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [`C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\${cli}`, '--yes', 'openlore'],
    });
  });

  it.each(['darwin', 'linux'] as const)('passes commands through unchanged on %s', (platform) => {
    expect(resolvePlatformCommand('npx', ['--yes', 'openlore'], platform)).toEqual({
      command: 'npx',
      args: ['--yes', 'openlore'],
    });
  });

  it('does not wrap unrelated Windows executables or mutate the caller argv', () => {
    const args = ['upgrade', 'openlore'];
    expect(resolvePlatformCommand('brew', args, 'win32')).toEqual({
      command: 'brew',
      args,
    });
    expect(args).toEqual(['upgrade', 'openlore']);
  });

  it('formats the exact argv that will be executed', () => {
    expect(formatPlatformCommand(resolvePlatformCommand(
      'npm', ['install', '-g', 'openlore@latest'], 'win32', windowsRuntime,
    ), 'win32')).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" install -g openlore@latest');
  });

  it('requires an absolute Windows Node executable', () => {
    expect(() => resolvePlatformCommand('npx', ['openlore'], 'win32', {
      nodeExecutable: 'node.exe',
    })).toThrow('requires an absolute Node executable');
  });

  it('supports the standard 32-bit Node installation path', () => {
    expect(resolvePlatformCommand('npx', ['--version'], 'win32', {
      nodeExecutable: 'C:\\Program Files (x86)\\nodejs\\node.exe',
      pathValue: '',
      fileExists: () => true,
    }).args[0]).toBe('C:\\Program Files (x86)\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
  });

  it('discovers npm from a separate absolute Windows prefix', () => {
    const prefixCli = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npx-cli.js';
    expect(resolvePlatformCommand('npx', ['--version'], 'win32', {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      pathValue: 'C:\\repo;C:\\Users\\me\\AppData\\Roaming\\npm',
      cwd: 'C:\\repo',
      fileExists: (path) => path === prefixCli,
    }).args[0]).toBe(prefixCli);
  });

  it('ignores npm candidates owned by the current repository', () => {
    const hostileCli = 'C:\\repo\\node_modules\\.bin\\node_modules\\npm\\bin\\npx-cli.js';
    const prefixCli = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npx-cli.js';
    expect(resolvePlatformCommand('npx', ['--version'], 'win32', {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: hostileCli.replace('npx-cli.js', 'npm-cli.js'),
      pathValue: 'C:\\repo\\node_modules\\.bin;C:\\Users\\me\\AppData\\Roaming\\npm',
      cwd: 'C:\\repo',
      fileExists: (path) => path === hostileCli || path === prefixCli,
    }).args[0]).toBe(prefixCli);
  });

  it('fails instead of emitting a dead launcher when npm cannot be found', () => {
    expect(() => resolvePlatformCommand('npx', ['--version'], 'win32', {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      pathValue: '',
      fileExists: () => false,
    })).toThrow('Could not locate npx-cli.js');
  });
});

/**
 * fix-windows-console-flash-from-npx-shim.
 *
 * resolvePlatformCommand removes the shim for `npx` ITSELF, but npx then launches the
 * TARGET package's bin through `cmd.exe /d /s /c openlore ...` - a visible console
 * window on every run, i.e. every agent turn for a UserPromptSubmit hook.
 * resolveOpenloreCommand wires OpenLore's own entry, so no cmd.exe is ever in the chain.
 *
 * Paths are built with win32.join so this file carries no literal backslashes.
 */
describe('resolveOpenloreCommand', () => {
  const NODE = win32.join('C:', 'Program Files', 'nodejs', 'node.exe');
  const NPM_PREFIX = win32.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'npm');
  const ENTRY = win32.join(NPM_PREFIX, 'node_modules', 'openlore', 'dist', 'cli', 'index.js');
  const NPX_CLI = win32.join(NPM_PREFIX, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const CACHED = win32.join('C:', 'Users', 'me', 'AppData', 'Local', 'npm-cache', '_npx', 'a1b2', 'openlore', 'dist', 'cli', 'index.js');

  it('wires our own CLI entry, so no cmd.exe shim is in the chain', () => {
    const cmd = resolveOpenloreCommand(['orient', '--inject'], 'win32', {
      nodeExecutable: NODE,
      openloreCliEntry: ENTRY,
    });
    expect(cmd.command).toBe(NODE);
    expect(cmd.args).toEqual([ENTRY, 'orient', '--inject']);
    // The regression itself: nothing may route through npx, whose Windows bin shim is a
    // .cmd and therefore needs cmd.exe.
    const line = [cmd.command, ...cmd.args].join(' ');
    expect(line).not.toContain('npx');
    expect(line).not.toContain('.cmd');
  });

  it('falls back to the portable npx form when we have no usable entry', () => {
    const cmd = resolveOpenloreCommand(['mcp', '--preset', 'substrate'], 'win32', {
      nodeExecutable: NODE,
      openloreCliEntry: null,
      pathValue: NPM_PREFIX,
      fileExists: (p) => p === NPX_CLI,
    });
    expect(cmd.command).toBe(NODE);
    expect(cmd.args).toEqual([NPX_CLI, '--yes', 'openlore', 'mcp', '--preset', 'substrate']);
  });

  it('never bakes in an npx cache path, which npm is free to evict', () => {
    const cmd = resolveOpenloreCommand(['orient', '--json'], 'win32', {
      nodeExecutable: NODE,
      openloreCliEntry: CACHED,
      pathValue: NPM_PREFIX,
      fileExists: (p) => p === NPX_CLI,
    });
    expect(cmd.args).not.toContain(CACHED);
    expect(cmd.args).toContain('--yes');
  });

  it('passes the entry through unchanged off Windows', () => {
    const cmd = resolveOpenloreCommand(['orient', '--json'], 'linux', {
      nodeExecutable: '/usr/bin/node',
      openloreCliEntry: '/usr/lib/node_modules/openlore/dist/cli/index.js',
    });
    expect(cmd.command).toBe('/usr/bin/node');
    expect(cmd.args[0]).toBe('/usr/lib/node_modules/openlore/dist/cli/index.js');
  });

  it('keeps the existing refusal to emit a Windows command with a relative node path', () => {
    // Same contract resolvePlatformCommand already enforces: a dead launcher is worse
    // than a loud failure.
    expect(() => resolveOpenloreCommand(['orient', '--json'], 'win32', {
      nodeExecutable: 'node',
      openloreCliEntry: ENTRY,
      pathValue: NPM_PREFIX,
      fileExists: (p) => p === NPX_CLI,
    })).toThrow('absolute Node executable');
  });
});

describe('formatPlatformCommand quotes for the shell that will run it', () => {
  // Since the wired command carries absolute filesystem paths on EVERY platform, the
  // user's home directory is now part of the string a host hook runs through a shell.
  it('suppresses POSIX expansion in a path that contains shell metacharacters', () => {
    const line = formatPlatformCommand({
      command: '/usr/bin/node',
      args: ['/Users/a$b/`whoami`/openlore/dist/cli/index.js', 'orient', '--inject'],
    }, 'linux');
    expect(line).toBe(
      "/usr/bin/node '/Users/a$b/`whoami`/openlore/dist/cli/index.js' orient --inject",
    );
  });

  it("escapes an embedded single quote rather than ending the quoted run", () => {
    const line = formatPlatformCommand({ command: '/usr/bin/node', args: ["/Users/o'brien/x.js"] }, 'darwin');
    expect(line).toBe(`/usr/bin/node '/Users/o'\\''brien/x.js'`);
  });

  it('leaves an ordinary POSIX path unquoted', () => {
    expect(formatPlatformCommand({
      command: '/usr/local/bin/node',
      args: ['/usr/local/lib/node_modules/openlore/dist/cli/index.js', 'orient', '--json'],
    }, 'linux')).toBe(
      '/usr/local/bin/node /usr/local/lib/node_modules/openlore/dist/cli/index.js orient --json',
    );
  });

  it('keeps the cmd.exe double-quote form on Windows', () => {
    expect(formatPlatformCommand({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\npm\\openlore\\dist\\cli\\index.js', 'orient'],
    }, 'win32')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\openlore\\dist\\cli\\index.js orient',
    );
  });
});

describe('isOpenloreCliEntryPath', () => {
  it.each([
    '/usr/local/lib/node_modules/openlore/dist/cli/index.js',
    'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\openlore\\dist\\cli\\index.js',
    '/home/a/project/node_modules/openlore/dist/cli/index.js',
    // A development checkout or worktree, where the directory names OpenLore without
    // being exactly `openlore`.
    '/Users/a/dev/OpenLore/.claude/worktrees/openlore-fix-123/dist/cli/index.js',
  ])('recognises the entry this version wires: %s', (path) => {
    expect(isOpenloreCliEntryPath(path)).toBe(true);
  });

  it.each([
    '/usr/local/lib/node_modules/some-other-tool/dist/cli/index.js',
    '/home/a/my-own-server.js',
    'openlore',
    '/home/a/openlore/dist/cli/other.js',
    '/home/a/openlore-notes/README.md',
  ])('does not claim an unrelated path: %s', (path) => {
    expect(isOpenloreCliEntryPath(path)).toBe(false);
  });
});
