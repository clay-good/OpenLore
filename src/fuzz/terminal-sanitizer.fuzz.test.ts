/**
 * Property-based fuzzing for the terminal-output sanitizer.
 *
 * `sanitizeForTerminal` is a security boundary: it neutralizes terminal control
 * sequences smuggled through repository-derived text (file names, symbol names)
 * before OpenLore echoes them, so a hostile repo cannot forge OpenLore's output
 * (SECURITY.md). These properties assert the invariant over ~thousands of
 * control-character-heavy inputs, not a handful of hand-picked cases.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { sanitizeForTerminal } from '../utils/misc.js';

// UTF-16-code-unit strings biased toward the ranges the sanitizer targets —
// C0 (0x00-0x1F), DEL (0x7F) and C1 (0x80-0x9F) — interleaved with ordinary text.
// `.replace` operates on code units, so generating by code unit mirrors the sink.
const codeUnit = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0x00, max: 0x9f }) }, // control-heavy
  { weight: 2, arbitrary: fc.integer({ min: 0xa0, max: 0xffff }) }, // ordinary BMP text
  { weight: 1, arbitrary: fc.constantFrom(0x1b, 0x00, 0x0a, 0x0d, 0x09, 0x08, 0x7f, 0x9f, 0x80) },
);
const fuzzyString = fc
  .array(codeUnit, { maxLength: 256 })
  .map((units) => units.map((u) => String.fromCharCode(u)).join(''));

/** The characters the default (no-newline) mode must strip: all C0, DEL, C1. */
const isForbiddenDefault = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

describe('fuzz: sanitizeForTerminal', () => {
  it('default mode strips every C0 / DEL / C1 control code unit', () => {
    fc.assert(
      fc.property(fuzzyString, (s) => {
        const out = sanitizeForTerminal(s);
        for (let i = 0; i < out.length; i++) {
          if (isForbiddenDefault(out.charCodeAt(i))) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('keepNewlines mode strips all controls except newline, and never ESC', () => {
    fc.assert(
      fc.property(fuzzyString, (s) => {
        const out = sanitizeForTerminal(s, { keepNewlines: true });
        for (let i = 0; i < out.length; i++) {
          const c = out.charCodeAt(i);
          if (c === 0x0a) continue; // newline is the one permitted control
          if (c === 0x1b) return false; // ESC (and thus every CSI/OSC) must never survive
          if (isForbiddenDefault(c)) return false;
        }
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('is idempotent in both modes', () => {
    fc.assert(
      fc.property(fuzzyString, fc.boolean(), (s, keepNewlines) => {
        const once = sanitizeForTerminal(s, { keepNewlines });
        return once === sanitizeForTerminal(once, { keepNewlines });
      }),
      { numRuns: 1000 },
    );
  });

  it('only ever removes code units — output is a subsequence of the input', () => {
    fc.assert(
      fc.property(fuzzyString, fc.boolean(), (s, keepNewlines) => {
        const out = sanitizeForTerminal(s, { keepNewlines });
        if (out.length > s.length) return false;
        let j = 0;
        for (let i = 0; i < s.length && j < out.length; i++) {
          if (s[i] === out[j]) j++;
        }
        return j === out.length;
      }),
      { numRuns: 1000 },
    );
  });
});
