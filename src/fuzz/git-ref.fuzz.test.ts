/**
 * Property-based fuzzing for `validateGitRef` in `src/core/drift/git-diff.ts`.
 *
 * A user-supplied git ref is always passed to `git` as a single argv element,
 * which stops shell injection but NOT flag interpretation — `--upload-pack=x`
 * would still be read by git as an OPTION, and a metacharacter-laden ref is a
 * red flag regardless. `validateGitRef` is the argument-injection guard: it
 * signals validity by RETURNING and invalidity by THROWING. These properties
 * assert that contract over arbitrary input — legitimate refs pass, flag-shaped
 * and metacharacter-shaped refs are rejected, and the linear regex never hangs.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { validateGitRef } from '../core/drift/git-diff.js';

const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf899d15f71049056';

// Convert the throw/return contract into a boolean so properties read cleanly.
const accepts = (ref: string): boolean => {
  try {
    validateGitRef(ref);
    return true;
  } catch {
    return false;
  }
};

// The exact allowlist from validateGitRef: \w (A-Za-z0-9_) plus - . / ~ ^ @ { } :
const ALLOWED_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./~^@{}:'.split('');
// A non-dash allowed char is valid as the first character of a ref.
const ALLOWED_HEAD_CHARS = ALLOWED_CHARS.filter((c) => c !== '-');

// Characters that are OUTSIDE /^[\w\-./~^@{}:]+$/ — splicing any one into an
// otherwise-valid ref must flip acceptance to rejection.
const DANGEROUS_CHARS = [
  ' ',
  ';',
  '|',
  '&',
  '$',
  '`',
  '\n',
  '\r',
  '\0',
  "'",
  '"',
  '(',
  ')',
  '<',
  '>',
  '!',
  '*',
  '?',
  '\\',
];

const ALLOWED_PATTERN = /^[\w\-./~^@{}:]+$/;

describe('fuzz: validateGitRef (argument-injection guard)', () => {
  it('accepts legitimate refs built from the allowed alphabet', () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_HEAD_CHARS),
        fc.array(fc.constantFrom(...ALLOWED_CHARS), { maxLength: 64 }),
        (head, tail) => {
          const ref = head + tail.join('');
          const ok = accepts(ref);
          if (ok) accepted++;
          return ok;
        },
      ),
      { numRuns: 2000 },
    );
    // Non-vacuity: the accept path must actually be exercised.
    expect(accepted).toBeGreaterThan(50);
  });

  it('rejects every flag-shaped ref (leading dash)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ALLOWED_CHARS), { maxLength: 64 }), (tail) => {
        return !accepts('-' + tail.join(''));
      }),
      { numRuns: 1000 },
    );
    // Real-looking flag-injection refs.
    expect(accepts('--upload-pack=x')).toBe(false);
    expect(accepts('--output=x')).toBe(false);
    expect(accepts('-h')).toBe(false);
  });

  it('rejects any ref containing a metacharacter outside the allowlist', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALLOWED_HEAD_CHARS),
        fc.array(fc.constantFrom(...ALLOWED_CHARS), { maxLength: 32 }),
        fc.constantFrom(...DANGEROUS_CHARS),
        fc.array(fc.constantFrom(...ALLOWED_CHARS), { maxLength: 32 }),
        (head, before, bad, after) => {
          // Sanity: the injected char is genuinely outside the allowed set.
          if (ALLOWED_PATTERN.test(bad)) return true;
          const ref = head + before.join('') + bad + after.join('');
          return !accepts(ref);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('always completes (no hang / ReDoS) on arbitrary and adversarial input', () => {
    const longAllowed = fc
      .integer({ min: 1, max: 4000 })
      .map((n) => 'a'.repeat(n) + '/'.repeat(Math.min(n, 100)));
    fc.assert(
      fc.property(fc.oneof(fc.string(), longAllowed), (ref) => {
        // Reaching this return means the call terminated (returned or threw).
        accepts(ref);
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('handles the documented special cases', () => {
    expect(() => validateGitRef('auto')).not.toThrow();
    expect(() => validateGitRef(GIT_EMPTY_TREE_SHA)).not.toThrow();
    expect(() => validateGitRef('')).toThrow();
  });

  it('accepts real-world refs (non-vacuity anchors)', () => {
    expect(accepts('main')).toBe(true);
    expect(accepts('feature/x_1.2')).toBe(true);
    expect(accepts('HEAD~1')).toBe(true);
    expect(accepts('@{upstream}')).toBe(true);
  });
});
