import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  close: vi.fn(),
  countNodesWithMinFanIn: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: mocks.execFileSync,
}));
vi.mock('../../core/services/edge-store.js', () => ({
  EdgeStore: {
    exists: () => true,
    dbPath: () => '/repo/.openlore/analysis/call-graph.db',
    open: () => ({
      notReady: null,
      close: mocks.close,
      countNodesWithMinFanIn: mocks.countNodesWithMinFanIn,
    }),
  },
}));

import { logger } from '../../utils/logger.js';
import { proveCommand } from './prove.js';

describe('prove missing-agent preflight', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
    mocks.execFileSync.mockReset();
    mocks.close.mockReset();
    mocks.countNodesWithMinFanIn.mockReset();
  });

  it('reports sparse eligibility instead of recommending an estimate that will refuse', async () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error('claude missing'); });
    mocks.countNodesWithMinFanIn.mockReturnValue(0);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await proveCommand.parseAsync(['--directory', '/repo'], { from: 'user' });
      expect(error.mock.calls.flat().join(' ')).toContain('0 functions have ≥2 callers');
      expect(info.mock.calls.flat().join(' ')).not.toContain('openlore prove --estimate');
      expect(process.exitCode).toBe(1);
      expect(mocks.close).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });
});
