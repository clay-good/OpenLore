/**
 * Guards for the uniform CLI output contracts (OutputContractsAreUniform,
 * change: fix-cli-output-hygiene).
 *
 * 1. Raw-ANSI guard: no command module embeds `\x1b[…m` escape literals. Color
 *    must flow through the shared color layer (src/utils/colors.ts) so it honors
 *    --no-color and non-TTY streams. The one exception is the full-screen
 *    interactive approval TUI, which needs cursor-control codes chalk cannot
 *    express and never writes to a pipe.
 * 2. Color layer: the shared helpers emit no escape bytes when color is off.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { palette } from '../utils/colors.js';

/** Files that legitimately contain raw ANSI: interactive full-screen renderers. */
const ANSI_ALLOWLIST = new Set(['tui-approval.ts']);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('CLI output hygiene — raw ANSI guard', () => {
  it('no command module embeds raw ANSI escape literals', () => {
    const cliDir = join(__dirname);
    // Match the escape as it appears in source: \x1b[ , [ , or \033[ .
    const rawAnsi = /\\x1b\[|\\u001b\[|\\033\[/;
    const offenders: string[] = [];

    for (const file of walkTsFiles(cliDir)) {
      const base = file.split('/').pop()!;
      if (ANSI_ALLOWLIST.has(base)) continue;
      if (rawAnsi.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `Route color through src/utils/colors.ts instead of raw ANSI literals:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('CLI output hygiene — shared color layer', () => {
  it('emits no escape bytes when color is disabled', () => {
    const c = palette(false);
    const painted = `${c.green('ok')} ${c.red('bad')} ${c.yellow('warn')} ${c.dim('x')}`;
    expect(painted).toBe('ok bad warn x');
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(painted)).toBe(false);
  });
});
