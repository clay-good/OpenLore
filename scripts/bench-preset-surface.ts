/**
 * Deterministic preset surface comparison.
 *
 * Compatibility entry point for the ADR-0023 command, now generalized to
 * arbitrary preset A and preset B by the checked-in benchmark protocol.
 *
 * change: add-benchmark-harness-protocol
 */
import { measurePresetSurface } from '../src/bench/preset-surface.js';

function value(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const presetA = value('--preset-a', 'navigation');
const presetB = value('--preset-b', 'substrate');

/** Preserve the original ADR-0023 wrapper seam while delegating measurement. */
function measure(preset: string) {
  return measurePresetSurface(preset);
}

const a = measure(presetA);
const b = measure(presetB);
const comparison = {
  presetA: a,
  presetB: b,
  delta: {
    bytes: b.bytes - a.bytes,
    estimatedTokens: b.estimatedTokens - a.estimatedTokens,
    toolCount: b.toolCount - a.toolCount,
  },
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
} else {
  const { presetA: a, presetB: b, delta } = comparison;
  process.stdout.write([
    '',
    'Preset surface comparison — deterministic, no LLM',
    '',
    '  preset      tools   payload bytes   estimated tokens   families',
    `  ${a.preset.padEnd(11)}${String(a.toolCount).padStart(5)}${String(a.bytes).padStart(16)}${String(a.estimatedTokens).padStart(19)}   ${a.families.join(', ')}`,
    `  ${b.preset.padEnd(11)}${String(b.toolCount).padStart(5)}${String(b.bytes).padStart(16)}${String(b.estimatedTokens).padStart(19)}   ${b.families.join(', ')}`,
    '',
    `  B − A: ${delta.toolCount >= 0 ? '+' : ''}${delta.toolCount} tools, ${delta.bytes >= 0 ? '+' : ''}${delta.bytes} bytes, ${delta.estimatedTokens >= 0 ? '+' : ''}${delta.estimatedTokens} estimated tokens.`,
    `  Tokenizer: ${a.tokenizer}`,
    '',
  ].join('\n'));
}
