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
import { join, basename } from 'node:path';
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
      // `basename`, not `split('/')`: on Windows the walker yields `\`-joined paths, so the split
      // returns the whole path and the allow-list never matches — the guard then reports its own
      // exempted file as an offender.
      const base = basename(file);
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

describe('CLI output hygiene — untrusted terminal control sequences', () => {
  /**
   * `writeStdout` strips terminal control sequences centrally, which is only safe
   * while nothing colorizes through it. If a command starts emitting chalk/colors
   * down that path, the strip would eat its escapes and the colour would silently
   * vanish — so pin the assumption rather than leaving it as a comment.
   */
  it('keeps writeStdout a color-free path', () => {
    const commandsDir = join(import.meta.dirname, 'commands');
    const offenders: string[] = [];
    for (const file of walkTsFiles(commandsDir)) {
      const src = readFileSync(file, 'utf-8');
      if (!src.includes('writeStdout')) continue;
      if (/from 'chalk'|colorForStdout|palette\(/.test(src)) {
        offenders.push(file.split('/src/')[1] ?? file);
      }
    }
    expect(
      offenders,
      'These modules both write through writeStdout and emit colour. writeStdout strips\n' +
        'control characters (including the ESC that colour needs), so either route the\n' +
        'coloured output through the logger, or narrow the strip:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});

describe('CLI output hygiene — repository-derived values reaching the terminal', () => {
  /**
   * A file name may legally contain ESC on Linux and macOS, so any repository-derived
   * value OpenLore echoes back can carry cursor-movement or screen-clear sequences.
   * Printed raw, the repository being analyzed can overwrite OpenLore's own output.
   *
   * `writeStdout` and the logger sanitize centrally. `console.log` does not — so a
   * command that prints a path or symbol through it bypasses both. That is not
   * hypothetical: it is how `orient` and then `audit` were each found leaking, the
   * second only after widening a manual survey from 11 commands to 27.
   *
   * Hence the rule: in a command module, a bare `console.log` template may not
   * interpolate a repository-derived field unless it goes through
   * `sanitizeForTerminal` (imported as `safe`).
   */
  const REPO_DERIVED = /console\.log\(`[^`]*\$\{[^}]*\.(name|file|filePath|path|symbol|requirement|domain|reason|id)\b/;

  it('sanitizes repo-derived values printed with bare console.log', () => {
    const commandsDir = join(import.meta.dirname, 'commands');
    const offenders: string[] = [];
    for (const file of walkTsFiles(commandsDir)) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          if (!REPO_DERIVED.test(line)) return;
          if (line.includes('safe(') || line.includes('sanitizeForTerminal(')) return;
          offenders.push(`${file.split('/commands/')[1]}:${i + 1}  ${line.trim().slice(0, 80)}`);
        });
    }
    expect(
      offenders,
      'These print repository-derived values with bare console.log, which neither\n' +
        'writeStdout nor the logger sanitizes. An analyzed repository can smuggle\n' +
        'terminal control sequences through them and forge OpenLore output.\n' +
        "Wrap the value: `${safe(value)}` (import { sanitizeForTerminal as safe }).\n\n" +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
