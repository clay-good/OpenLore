import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => {
  const execFileAsync = vi.fn(async () => ({
    stdout: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\n',
    stderr: '',
  }));
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: execFileAsync,
  });
  return { execFile, execFileAsync };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: childProcess.execFile };
});

vi.mock('node:url', async () => {
  const actual = await vi.importActual<typeof import('node:url')>('node:url');
  return {
    ...actual,
    fileURLToPath: vi.fn(() => 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openlore\\dist\\cli\\commands\\update.js'),
  };
});

vi.mock('../../core/services/update-notifier.js', () => ({
  fetchLatestVersion: vi.fn(async () => '99.0.0'),
  isNewer: vi.fn(() => true),
}));

import { logger } from '../../utils/logger.js';
import { runUpdate } from './update.js';

describe('openlore update on Windows', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the resolved shim for npm-root evidence and prints the same dry-run invocation', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    const runtime = {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      pathValue: '',
      fileExists: () => true,
    };
    expect(await runUpdate({ dryRun: true }, 'win32', runtime)).toBe(0);
    expect(childProcess.execFileAsync).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.exe',
      ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'root', '-g'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(info).toHaveBeenCalledWith(
      'Would run',
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" install -g openlore@latest',
    );
  });
});
