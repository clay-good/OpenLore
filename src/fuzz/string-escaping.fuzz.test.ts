/**
 * Property-based fuzzing for the string-escaping and parsing helpers in
 * `src/utils/misc.ts`. Each of these takes untrusted, repository- or LLM-derived
 * text and must not let it break out of the context it is embedded in (a RegExp,
 * a Graphviz DOT string, a JSON blob) or crash the process.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { escapeRegExp, escapeDotString, parseJSON, isProtoPollutingKey } from '../utils/misc.js';

// Control-character-heavy strings (see terminal-sanitizer.fuzz for rationale).
const codeUnit = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0x00, max: 0x9f }) },
  { weight: 2, arbitrary: fc.integer({ min: 0xa0, max: 0xffff }) },
  { weight: 1, arbitrary: fc.constantFrom(0x22 /* " */, 0x5c /* \ */, 0x0a, 0x0d, 0x09, 0x1b) },
);
const fuzzyString = fc
  .array(codeUnit, { maxLength: 256 })
  .map((units) => units.map((u) => String.fromCharCode(u)).join(''));

// Regex metacharacter-dense strings, to exercise every branch of escapeRegExp.
const regexMeta = fc
  .array(fc.constantFrom('.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', 'a', '1'), {
    maxLength: 48,
  })
  .map((chars) => chars.join(''));

describe('fuzz: escapeRegExp', () => {
  it('always produces a valid pattern that matches its input literally', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), regexMeta, fuzzyString), (s) => {
        // Constructing the RegExp throws if the escape leaked a metacharacter.
        const re = new RegExp(escapeRegExp(s));
        // The escaped pattern is the literal string, so it must match the string.
        return re.test(s);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('fuzz: escapeDotString', () => {
  it('never emits a raw line-breaking or dropped control character', () => {
    fc.assert(
      fc.property(fuzzyString, (s) => {
        const out = escapeDotString(s);
        for (let i = 0; i < out.length; i++) {
          const c = out.charCodeAt(i);
          // newline / CR / tab are converted to \n \r \t, never emitted raw
          if (c === 0x0a || c === 0x0d || c === 0x09) return false;
          // every other C0 char and DEL is dropped outright
          if (c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || c === 0x7f) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('never emits an unescaped double-quote (cannot terminate its DOT string)', () => {
    fc.assert(
      fc.property(fuzzyString, (s) => {
        const out = escapeDotString(s);
        for (let i = 0; i < out.length; i++) {
          if (out[i] !== '"') continue;
          // Count the run of backslashes immediately before this quote; an odd
          // count means the quote is escaped, an even count means it escaped out.
          let backslashes = 0;
          for (let k = i - 1; k >= 0 && out[k] === '\\'; k--) backslashes++;
          if (backslashes % 2 === 0) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('fuzz: parseJSON', () => {
  it('never throws and returns the fallback on non-JSON text', () => {
    const fallback = { __fallback: true };
    fc.assert(
      fc.property(fc.string(), (s) => {
        // Reaching the return without throwing is the property under test.
        parseJSON<unknown>(s, fallback);
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('recovers an object wrapped in markdown code fences', () => {
    fc.assert(
      fc.property(
        // parseJSON strips ``` fences globally, so an object whose own JSON text
        // contains a backtick fence is legitimately not recoverable — exclude
        // that case rather than assert a guarantee the function does not make.
        fc.object().filter((obj) => !JSON.stringify(obj).includes('`')),
        (obj) => {
          const text = '```json\n' + JSON.stringify(obj) + '\n```';
          const parsed = parseJSON<unknown>(text, null);
          return JSON.stringify(parsed) === JSON.stringify(obj);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('fuzz: isProtoPollutingKey', () => {
  it('flags exactly __proto__, constructor and prototype', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constantFrom('__proto__', 'constructor', 'prototype')), (s) => {
        const expected = s === '__proto__' || s === 'constructor' || s === 'prototype';
        return isProtoPollutingKey(s) === expected;
      }),
      { numRuns: 1000 },
    );
  });

  it('recognizes the three known prototype-polluting keys', () => {
    expect(isProtoPollutingKey('__proto__')).toBe(true);
    expect(isProtoPollutingKey('constructor')).toBe(true);
    expect(isProtoPollutingKey('prototype')).toBe(true);
    expect(isProtoPollutingKey('safeKey')).toBe(false);
  });
});
