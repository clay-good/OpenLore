/**
 * Guards for the sanitizing helpers in misc.ts.
 *
 * Each test below encodes the concrete failure the helper exists to prevent, not
 * just its happy path — an escape function that is only tested with safe input
 * passes just as well when it stops escaping.
 */
import { describe, it, expect } from 'vitest';
import { escapeRegExp, escapeDotString, isProtoPollutingKey } from './misc.js';

describe('escapeRegExp', () => {
  it('stops a crafted identifier from matching a different symbol', () => {
    // The reported defect: `functionName` is a caller-supplied MCP argument spliced
    // into `\b<name>\s*[(<]`. Unescaped, alternation makes the pattern match a
    // function the caller never named, so the wrong body is returned.
    const attacker = 'foo(.*)|bar';

    expect(new RegExp(`\\b${attacker}\\s*[(<]`).test('bar(')).toBe(true);
    expect(new RegExp(`\\b${escapeRegExp(attacker)}\\s*[(<]`).test('bar(')).toBe(false);
  });

  it('still matches the literal identifier it was given', () => {
    expect(new RegExp(`\\b${escapeRegExp('handleOrient')}\\s*[(<]`).test('function handleOrient(')).toBe(
      true
    );
  });

  it('escapes every regex metacharacter', () => {
    const escaped = escapeRegExp('.*+?^${}()|[]\\');
    // Round-trips as a literal: the escaped form matches the raw string exactly.
    expect(new RegExp(`^${escaped}$`).test('.*+?^${}()|[]\\')).toBe(true);
  });
});

describe('escapeDotString', () => {
  it('escapes the backslash before the quote', () => {
    // Escaping only quotes leaves a trailing backslash escaping the closing quote
    // that follows it, so the rest of the DOT document is swallowed by the string.
    const quoteOnly = (s: string) => s.replace(/"/g, '\\"');

    expect(`"${quoteOnly('a\\')}" [label="x"]`).toBe('"a\\" [label="x"]'); // broken
    expect(`"${escapeDotString('a\\')}" [label="x"]`).toBe('"a\\\\" [label="x"]'); // closed
  });

  it('escapes embedded quotes', () => {
    expect(escapeDotString('say "hi"')).toBe('say \\"hi\\"');
  });

  it('leaves ordinary identifiers untouched', () => {
    expect(escapeDotString('src/core/analyzer/file-walker.ts')).toBe(
      'src/core/analyzer/file-walker.ts'
    );
  });
});

describe('isProtoPollutingKey', () => {
  it('flags the keys that escape an object into its prototype', () => {
    expect(isProtoPollutingKey('__proto__')).toBe(true);
    expect(isProtoPollutingKey('constructor')).toBe(true);
    expect(isProtoPollutingKey('prototype')).toBe(true);
  });

  it('does not flag ordinary config keys', () => {
    for (const k of ['mcpServers', 'openlore', 'hooks', 'proto', 'protoype']) {
      expect(isProtoPollutingKey(k), k).toBe(false);
    }
  });
});
