import { describe, expect, it } from 'vitest';
import { comparePresetSurfaces, measurePresetSurface } from './preset-surface.js';
import { TOOL_DEFINITIONS, selectActiveTools } from '../cli/commands/mcp.js';
import { STANDING_CONTEXT_TOKENIZER } from '../core/services/mcp-standing-cost.js';

describe('generalized preset surface measurement', () => {
  it('reads arbitrary presets from the live registry and uses the versioned standing-cost unit', () => {
    for (const preset of ['navigation', 'substrate', 'full']) {
      const measured = measurePresetSurface(preset);
      expect(measured.toolIds).toEqual(
        selectActiveTools(TOOL_DEFINITIONS, { preset }).map((tool) => tool.name),
      );
      expect(measured.tokenizer).toBe(STANDING_CONTEXT_TOKENIZER);
      expect(measured.estimatedTokens).toBe(Math.ceil(measured.bytes / 4));
    }
  });

  it('computes B-minus-A deltas instead of hard-coding navigation and substrate', () => {
    const comparison = comparePresetSurfaces('minimal', 'navigation');
    expect(comparison.delta).toEqual({
      bytes: comparison.presetB.bytes - comparison.presetA.bytes,
      estimatedTokens: comparison.presetB.estimatedTokens - comparison.presetA.estimatedTokens,
      toolCount: comparison.presetB.toolCount - comparison.presetA.toolCount,
    });
  });
});
