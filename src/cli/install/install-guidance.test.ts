import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadProveEligibility = vi.fn();

vi.mock('../commands/prove.js', () => ({ loadProveEligibility }));

import { logger } from '../../utils/logger.js';
import { printProveGuidance } from './index.js';

describe('install prove guidance wiring', () => {
  beforeEach(() => {
    loadProveEligibility.mockReset();
  });

  it('prints a measured explanation instead of a failing CTA for a sparse graph', async () => {
    loadProveEligibility.mockResolvedValue({
      eligibleFunctions: 0,
      requiredEligibleFunctions: 1,
      minCallers: 2,
      eligible: false,
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await printProveGuidance('/repo');
      expect(info).toHaveBeenCalledWith(
        'Measured projection unavailable',
        expect.stringContaining('0 functions have ≥2 callers'),
      );
      expect(info.mock.calls.flat().join(' ')).not.toContain('openlore prove --estimate');
    } finally {
      info.mockRestore();
    }
  });

  it('prints the prove CTA when the cached graph meets the threshold', async () => {
    loadProveEligibility.mockResolvedValue({
      eligibleFunctions: 1,
      requiredEligibleFunctions: 1,
      minCallers: 2,
      eligible: true,
    });
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await printProveGuidance('/repo');
      expect(info).toHaveBeenCalledWith('Does it pay off?', expect.stringContaining('openlore prove --estimate'));
    } finally {
      info.mockRestore();
    }
  });
});
