/**
 * Property-based fuzzing for the secret redactor in
 * `src/core/services/secret-redaction.ts`.
 *
 * This is a hard security boundary: a provider API key read for an LLM call must
 * NEVER survive redaction into any output channel (tool result, telemetry event,
 * log line, written artifact). `redactSecretString` scrubs credential-shaped
 * substrings from text; `redactSecrets` deep-walks a structured payload, replacing
 * both credential-shaped strings and the values of secret-named keys. These
 * properties assert the non-leak, idempotence, no-throw, no-mutation and
 * cycle-safety invariants over thousands of generated inputs, with each secret
 * built to MEET the minimum length its pattern requires so redaction is
 * guaranteed (asserting a shorter-than-minimum value gets redacted would be
 * asserting a guarantee the module does not make).
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { redactSecretString, redactSecrets } from '../core/services/secret-redaction.js';

// The url-safe alphabet the value patterns accept: [A-Za-z0-9-_].
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const urlSafeBody = (min: number, max: number) =>
  fc.array(fc.constantFrom(...[...URL_SAFE]), { minLength: min, maxLength: max }).map((cs) => cs.join(''));

// Each arbitrary yields { secret, body }: `secret` is a full occurrence guaranteed
// to match a pattern; `body` is the credential material that MUST NOT survive
// verbatim (the pattern minima: sk-ant- 10+, sk- 20+, Bearer 10+ non-space, AIza
// EXACTLY 35, api_key= 8+, ?key= 8+).
const secretWithBody = fc.oneof(
  urlSafeBody(10, 40).map((b) => ({ secret: `sk-ant-${b}`, body: b })),
  urlSafeBody(20, 40).map((b) => ({ secret: `sk-${b}`, body: b })),
  urlSafeBody(10, 40).map((b) => ({ secret: `Bearer ${b}`, body: b })),
  urlSafeBody(35, 35).map((b) => ({ secret: `AIza${b}`, body: b })),
  urlSafeBody(8, 40).map((b) => ({ secret: `api_key=${b}`, body: b })),
  urlSafeBody(8, 40).map((b) => ({ secret: `?key=${b}`, body: b })),
);

// Object KEY names that DENOTE a secret (each verified against SECRET_KEY_NAME).
const secretKeyName = fc.constantFrom(
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'credential',
  'client_secret',
  'access_key',
  'accessKey',
  'private_key',
  'session_key',
  'x-openlore-token',
);

// Control-character-heavy strings (see terminal-sanitizer.fuzz for rationale).
const codeUnit = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0x00, max: 0x9f }) },
  { weight: 2, arbitrary: fc.integer({ min: 0xa0, max: 0xffff }) },
  { weight: 1, arbitrary: fc.constantFrom(0x1b, 0x00, 0x0a, 0x0d, 0x09, 0x7f) },
);
const fuzzyString = fc
  .array(codeUnit, { maxLength: 256 })
  .map((units) => units.map((u) => String.fromCharCode(u)).join(''));

describe('fuzz: redactSecretString', () => {
  it('a guaranteed-matching secret body never survives verbatim in the output', () => {
    fc.assert(
      fc.property(fc.string(), secretWithBody, fc.string(), (prefix, { secret, body }, suffix) => {
        const out = redactSecretString(prefix + secret + suffix);
        // The credential material was replaced by a [REDACTED] form; only the
        // arbitrary surrounding text may remain, never the body itself.
        return !out.includes(body);
      }),
      { numRuns: 2000 },
    );
  });

  it('is idempotent: redact(redact(s)) === redact(s)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fuzzyString,
          fc
            .tuple(fc.string(), secretWithBody, fc.string())
            .map(([p, { secret }, s]) => p + secret + s),
        ),
        (s) => {
          const once = redactSecretString(s);
          return redactSecretString(once) === once;
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('never throws on arbitrary / control-heavy input', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fuzzyString), (s) => {
        redactSecretString(s);
        return true;
      }),
      { numRuns: 1000 },
    );
  });

  it('redacts each concrete pattern (non-vacuity of the generators)', () => {
    expect(redactSecretString('sk-ant-' + 'a'.repeat(20))).not.toContain('a'.repeat(20));
    expect(redactSecretString('sk-' + 'b'.repeat(25))).not.toContain('b'.repeat(25));
    expect(redactSecretString('Bearer ' + 'c'.repeat(15))).toContain('Bearer [REDACTED]');
    expect(redactSecretString('AIza' + 'd'.repeat(35))).toBe('[REDACTED]');
    expect(redactSecretString('api_key=' + 'e'.repeat(12))).toContain('api_key=[REDACTED]');
    expect(redactSecretString('https://x/v1?key=' + 'f'.repeat(12))).not.toContain('f'.repeat(12));
  });
});

describe('fuzz: redactSecrets', () => {
  it('replaces the value of any secret-named key with [REDACTED]', () => {
    let exercised = 0;
    fc.assert(
      fc.property(secretKeyName, fc.string(), (key, value) => {
        const out = redactSecrets({ [key]: value }) as Record<string, unknown>;
        exercised++;
        return out[key] === '[REDACTED]';
      }),
      { numRuns: 1000 },
    );
    // The property is only meaningful if the redact branch actually fired.
    expect(exercised).toBeGreaterThan(0);
    // Concrete proof the secret-key branch fires, defeating any silent vacuity.
    expect(redactSecrets({ apiKey: 'anything-at-all' })).toEqual({ apiKey: '[REDACTED]' });
    expect(redactSecrets({ x_client_secret: 'shh' })).toEqual({ x_client_secret: '[REDACTED]' });
  });

  it('a secret body nested deep in arrays/objects never survives JSON.stringify', () => {
    fc.assert(
      fc.property(secretWithBody, fc.string(), ({ secret, body }, note) => {
        // Placed under NON-secret keys so the string-value redaction path is what
        // must scrub the body (SECRET_KEY_NAME does not match these names).
        const input = {
          note,
          items: [{ deep: { nested: [secret, { more: `pre-${secret}-post` }] } }],
          sibling: 'plain',
        };
        return !JSON.stringify(redactSecrets(input)).includes(body);
      }),
      { numRuns: 1000 },
    );
  });

  it('does not mutate its input', () => {
    fc.assert(
      fc.property(secretWithBody, secretKeyName, ({ secret }, key) => {
        const input: Record<string, unknown> = {
          [key]: 'raw-secret-value',
          nested: { note: secret, list: [secret] },
        };
        const before = JSON.stringify(input);
        redactSecrets(input);
        // Original object is untouched; the secret is still present in it.
        return JSON.stringify(input) === before;
      }),
      { numRuns: 1000 },
    );
    const original = { apiKey: 'sk-ant-' + 'z'.repeat(20), note: 'sk-' + 'y'.repeat(25) };
    redactSecrets(original);
    expect(original.apiKey).toBe('sk-ant-' + 'z'.repeat(20));
    expect(original.note).toBe('sk-' + 'y'.repeat(25));
  });

  it('is cycle-safe: finishes without throwing or hanging on a cyclic graph', () => {
    const node: Record<string, unknown> = { apiKey: 'sk-ant-' + 'q'.repeat(20), note: 'Bearer ' + 'w'.repeat(15) };
    node.self = node; // direct cycle
    const child: Record<string, unknown> = { parent: node };
    node.child = child; // indirect cycle back to node
    const out = redactSecrets(node) as Record<string, unknown>;
    // The secret-named value is redacted and the cycle resolves to the redacted
    // twin (never re-embedding the original, unscrubbed node).
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.self).toBe(out);
    expect((out.child as Record<string, unknown>).parent).toBe(out);
    // And no unredacted body leaked anywhere reachable without traversing the cycle.
    const twin = out.self as Record<string, unknown>;
    expect(twin.note).toBe('Bearer [REDACTED]');
  });
});
