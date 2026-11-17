/**
 * A CLI command must not tell a person to run an MCP tool.
 *
 * `toCliVocabulary` (src/cli/surface-vocabulary.ts) exists for exactly this and its docstring
 * states the contract: "CLI command modules pass every handler-produced hint / error / boundary
 * string through here before printing" (OutputContractsAreUniform, change:
 * fix-cli-output-hygiene). Only three of the mirror commands did, so six others told a person at
 * a terminal to run `analyze_codebase` — which is not a command.
 *
 * The tool handlers are shared by both delivery faces, so their "what to do next" sentences name
 * MCP tools — right for an agent, impossible for someone at a terminal. `openlore footprint` said
 * "No analysis found. Run analyze_codebase first.", and `analyze_codebase` is not a command.
 *
 * This is a source guard, not a snapshot: it fails when a NEW command renders a dispatched
 * handler's error without translating it, which is how the gap appeared in the first place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCliVocabulary } from './surface-vocabulary.js';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'commands');

describe('toCliVocabulary', () => {
  it('translates a tool name into the command that does the same job', () => {
    expect(toCliVocabulary('No analysis found. Run analyze_codebase first.'))
      .toBe('No analysis found. Run openlore analyze first.');
  });

  it('leaves a message with no tool name alone', () => {
    const text = 'Not a git repository, so in-flight changes cannot be listed.';
    expect(toCliVocabulary(text)).toBe(text);
  });

  it('translates every occurrence, not just the first', () => {
    const out = toCliVocabulary('Run analyze_codebase. Then analyze_codebase again.');
    expect(out).not.toMatch(/analyze_codebase/);
  });
});

describe('every CLI command that renders a handler error translates it', () => {
  const sources = readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => ({ file: f, src: readFileSync(join(COMMANDS_DIR, f), 'utf-8') }));

  it('finds the command sources to check', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(sources.filter(s => s.src.includes('dispatchTool')).map(s => [s.file, s.src]))(
    '%s renders a dispatched error through toCliVocabulary',
    (file, src) => {
      // Does this command surface the handler's own `error` string to the user at all?
      const rendersError = /status: 'unavailable', error/.test(src)
        || /\.error\}`\)/.test(src)
        || /\{ error: string \}\)\.error/.test(src);
      if (!rendersError) return;
      expect(
        src.includes('toCliVocabulary'),
        `${file} prints a shared handler's error to a CLI user. Wrap it in toCliVocabulary() so `
        + 'guidance naming an MCP tool (e.g. "Run analyze_codebase first") becomes the command they '
        + 'can actually run.',
      ).toBe(true);
    },
  );
});
