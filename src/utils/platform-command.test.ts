import { describe, expect, it } from 'vitest';
import { formatPlatformCommand, resolvePlatformCommand } from './platform-command.js';

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
    ))).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" install -g openlore@latest');
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
