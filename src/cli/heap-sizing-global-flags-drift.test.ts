/**
 * Drift guard: keep `GLOBAL_VALUE_FLAGS` (heap-sizing.ts) in lockstep with the value-taking
 * GLOBAL options actually declared on the top-level `program` in `src/cli/index.ts`.
 *
 * WHY THIS EXISTS — two sources of truth for the same fact.
 * Adaptive heap sizing must know the CLI subcommand from raw argv BEFORE commander parses, so it can
 * decide whether to size the heap (`commandFromArgv` in heap-sizing.ts). To do that it has to skip
 * the VALUE of any global value-taking option in the space-separated form — otherwise
 * `openlore --config prod.json analyze` reads `prod.json` as the command and silently skips heap
 * sizing for that analyze. Which global options take a value is declared in ONE place — the
 * `program.option(...)` block in index.ts — but heap-sizing.ts hardcodes a SECOND copy of that set in
 * `GLOBAL_VALUE_FLAGS`. If someone adds a new value-taking global option to index.ts and forgets to
 * update `GLOBAL_VALUE_FLAGS`, the drift is silent: heap sizing just misreads the command for that
 * one invocation. This test fails the moment the two sources diverge.
 *
 * It parses the SOURCE of index.ts rather than importing it: index.ts has import-time side effects
 * (the heap bootstrap, process.exit paths) that make in-process introspection of `program` unsafe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GLOBAL_VALUE_FLAGS } from './heap-sizing.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, 'index.ts'), 'utf-8');

/**
 * The top-level `program` options block only: from `.name('openlore')` up to the first
 * `program.addCommand(...)`. Slicing this window keeps SUBCOMMAND options (declared on their own
 * command objects, added below) out of the derived global set.
 */
function topLevelProgramBlock(source: string): string {
  const start = source.indexOf(".name('openlore')");
  expect(start, "expected `.name('openlore')` in index.ts").toBeGreaterThanOrEqual(0);
  const end = source.indexOf('program.addCommand', start);
  expect(end, 'expected a `program.addCommand(...)` after the option block').toBeGreaterThan(start);
  return source.slice(start, end);
}

interface OptionSpec {
  /** The long flag, e.g. `--config` (without any `<value>`/`[value]` placeholder). */
  longFlag: string;
  /** True when the flag spec declares a value placeholder (`<...>` or `[...]`). */
  takesValue: boolean;
}

/**
 * Extract each `.option(...)` / `.addOption(...)` flag spec from a chunk of source. Captures the
 * first string-literal argument of every call — tolerant of multi-line calls (the `\s*` spans
 * newlines) and of single/double/backtick quoting. A flag spec is `-x, --long <val>` /
 * `--long <val>` / `--long=<val>` / `--long` / `--no-thing`; we take the LONG flag (first `--…`
 * token) and mark it value-taking when the spec contains `<` or `[`.
 */
function extractOptions(block: string): OptionSpec[] {
  const specs: OptionSpec[] = [];
  // .option( / .addOption(  then optional whitespace/newlines  then a quoted string literal.
  const callRe = /\.(?:option|addOption)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(block)) !== null) {
    const flagSpec = m[2];
    // The long flag: the first whitespace/comma-separated token beginning with `--`, stripped of
    // any `=<value>` suffix (the space-form placeholder is already a separate token).
    const longToken = flagSpec
      .split(/[\s,]+/)
      .find(t => t.startsWith('--'));
    if (!longToken) continue; // short-only flag (none today) — no long form to track
    const longFlag = longToken.split('=')[0];
    const takesValue = flagSpec.includes('<') || flagSpec.includes('[');
    specs.push({ longFlag, takesValue });
  }
  return specs;
}

const globalOptions = extractOptions(topLevelProgramBlock(indexSource));
const valueTakingLongFlags = new Set(
  globalOptions.filter(o => o.takesValue).map(o => o.longFlag),
);
const booleanLongFlags = new Set(
  globalOptions.filter(o => !o.takesValue).map(o => o.longFlag),
);

describe('GLOBAL_VALUE_FLAGS drift guard', () => {
  it('parses a plausible set of global options from index.ts (self-check on the parser)', () => {
    // Sanity: if the parser found nothing, every assertion below would pass vacuously.
    expect(globalOptions.length).toBeGreaterThan(0);
    // The known value-taking global options must be discovered by the source parser itself, so a
    // regression in the parser (not the data) is caught here rather than hiding the real guard.
    expect(valueTakingLongFlags.has('--config')).toBe(true);
    expect(valueTakingLongFlags.has('--api-base')).toBe(true);
    expect(valueTakingLongFlags.has('--timeout')).toBe(true);
  });

  it('lists every value-taking GLOBAL option declared in index.ts', () => {
    // The core guard: each value-taking global long flag must be skipped by commandFromArgv.
    const missing = [...valueTakingLongFlags].filter(f => !GLOBAL_VALUE_FLAGS.has(f));
    expect(
      missing,
      `index.ts declares value-taking global option(s) not in GLOBAL_VALUE_FLAGS ` +
        `(src/cli/heap-sizing.ts): ${missing.join(', ')}. Add them, or heap sizing will misread ` +
        `the subcommand for e.g. \`openlore ${missing[0] ?? '--flag'} value analyze\`.`,
    ).toEqual([]);
  });

  it('contains only value-taking GLOBAL flags — no boolean flags, no subcommand-only flags', () => {
    // The inverse guard: nothing in GLOBAL_VALUE_FLAGS may be a boolean global flag (would wrongly
    // swallow the next token) or a flag that is not a top-level global option at all.
    for (const flag of GLOBAL_VALUE_FLAGS) {
      expect(
        booleanLongFlags.has(flag),
        `GLOBAL_VALUE_FLAGS lists ${flag}, but index.ts declares it as a boolean (no-value) ` +
          `global option — it must not consume the following argv token.`,
      ).toBe(false);
      expect(
        valueTakingLongFlags.has(flag),
        `GLOBAL_VALUE_FLAGS lists ${flag}, which is not a value-taking TOP-LEVEL global option in ` +
          `index.ts (subcommand-only or stale). Only global value options belong here.`,
      ).toBe(true);
    }
  });
});
