import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => {
  const state = { exitCode: 0, versionOnPath: '99.0.0' };
  const execFileAsync = vi.fn(async (command: string) => ({
    stdout: command === 'openlore' ? `${state.versionOnPath}\n` : '/usr/local/lib/node_modules\n',
    stderr: '',
  }));
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: execFileAsync,
  });
  return { execFile, execFileAsync, state };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: childProcess.execFile,
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', childProcess.state.exitCode));
      return child;
    }),
  };
});

vi.mock('node:url', async () => {
  const actual = await vi.importActual<typeof import('node:url')>('node:url');
  return {
    ...actual,
    fileURLToPath: vi.fn(() => '/usr/local/lib/node_modules/openlore/dist/cli/commands/update.js'),
  };
});

vi.mock('../../core/services/update-notifier.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/services/update-notifier.js')>(
    '../../core/services/update-notifier.js',
  );
  return { ...actual, fetchLatestVersion: vi.fn(async () => '99.0.0') };
});

import { logger } from '../../utils/logger.js';
import { runUpdate } from './update.js';

describe('openlore update verifies its own result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childProcess.state.exitCode = 0;
    childProcess.state.versionOnPath = '99.0.0';
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'discovery').mockImplementation(() => undefined);
  });

  it('reports success when PATH resolves to the new version', async () => {
    const success = vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    expect(await runUpdate({}, 'linux')).toBe(0);
    expect(success).toHaveBeenCalledWith('Upgraded openlore to 99.0.0.');
  });

  it('fails when the upgrade exits 0 but an older install is still first on PATH', async () => {
    childProcess.state.versionOnPath = '2.1.5';
    const success = vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(await runUpdate({}, 'linux')).toBe(1);
    expect(success).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(' ')).toMatch(/still reports 2\.1\.5[\s\S]*which -a openlore/);
  });

  it('names both upgrade commands when the chosen one fails', async () => {
    childProcess.state.exitCode = 1;
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(await runUpdate({}, 'linux')).toBe(1);
    const shown = error.mock.calls.flat().join(' ');
    expect(shown).toContain('npm install -g openlore@latest');
    expect(shown).toContain('brew upgrade openlore');
  });
});
