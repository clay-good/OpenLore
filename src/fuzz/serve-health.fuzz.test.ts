/**
 * Property-based fuzzing for the serve /health trust boundary.
 *
 * After discovering a daemon via `.openlore/serve.json`, a reader FETCHES the
 * daemon's `/health` endpoint and only then POSTs the project directory + full
 * tool arguments to it. `validateServeHealth` is the gate that decides whether a
 * `/health` answer proves the daemon is the authenticated, root-bound one we
 * expect. A false accept leaks the directory + tool args to (and takes results
 * from) an impostor daemon; the whole check rests on the accept branch being
 * reached ONLY when every identity/compatibility field truly holds. These
 * properties assert that over arbitrary input: it never throws, and acceptance
 * (a non-null result) implies the validated INPUT satisfied every identity guard.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { validateServeHealth, canonicalServeRoot } from '../cli/commands/serve-descriptor.js';

const SHARED_ROOT = '/tmp/openlore-fuzz-root';

describe('fuzz: serve health validation (daemon identity containment)', () => {
  it('never throws on arbitrary input', () => {
    const descriptorArb = fc.option(
      fc.record({ pid: fc.integer(), token: fc.option(fc.string(), { nil: undefined }) }),
      { nil: undefined },
    );
    fc.assert(
      fc.property(fc.anything(), fc.string(), descriptorArb, (parsed, expectedRoot, descriptor) => {
        validateServeHealth(parsed, expectedRoot, descriptor);
        return true; // reaching this line is the property: it completed without throwing
      }),
      { numRuns: 2000 },
    );
  });

  it('a non-null result ALWAYS satisfies every accept condition', () => {
    // Weighted toward *valid* health objects so the accept branch fires often; a
    // fully-random record is accepted <1/1000 of the time and the invariant would
    // be tested almost only on rejections. Each field mixes its valid value with
    // decoys. `root` sometimes equals SHARED_ROOT (the expectedRoot we pass), so
    // the canonical-root check can pass.
    const healthLike = fc.record(
      {
        ok: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.anything() }),
        presetDispatchEnforced: fc.oneof(
          { weight: 4, arbitrary: fc.constant(true) },
          { weight: 1, arbitrary: fc.anything() },
        ),
        root: fc.oneof(
          { weight: 4, arbitrary: fc.constant(SHARED_ROOT) },
          { weight: 1, arbitrary: fc.constant(SHARED_ROOT + '/elsewhere') },
          { weight: 1, arbitrary: fc.string() },
          { weight: 1, arbitrary: fc.anything() },
        ),
        pid: fc.oneof(
          { weight: 4, arbitrary: fc.integer({ min: 1, max: 2 ** 31 }) },
          { weight: 1, arbitrary: fc.integer() },
          { weight: 1, arbitrary: fc.double() },
          { weight: 1, arbitrary: fc.anything() },
        ),
        preset: fc.oneof({ weight: 4, arbitrary: fc.string() }, { weight: 1, arbitrary: fc.anything() }),
        tools: fc.oneof(
          { weight: 4, arbitrary: fc.array(fc.string()) },
          { weight: 1, arbitrary: fc.array(fc.anything()) },
          { weight: 1, arbitrary: fc.anything() },
        ),
        tokenProtected: fc.oneof(
          { weight: 4, arbitrary: fc.boolean() },
          { weight: 1, arbitrary: fc.anything() },
        ),
        tokenAuthenticated: fc.oneof(
          { weight: 4, arbitrary: fc.constant(true) },
          { weight: 1, arbitrary: fc.anything() },
        ),
      },
      { requiredKeys: [] },
    );

    let accepted = 0;
    fc.assert(
      fc.property(
        fc.oneof({ weight: 1, arbitrary: fc.anything() }, { weight: 4, arbitrary: healthLike }),
        (input) => {
        const result = validateServeHealth(input, SHARED_ROOT);
        if (result === null) return true; // rejection is always safe
        accepted++;
        // Assert acceptance implies the INPUT satisfied every guard. `ok`,
        // `presetDispatchEnforced` and `tokenAuthenticated` are hardcoded to true
        // in the returned object, so asserting on `result.*` would be tautological
        // (it would still pass if the source dropped the matching input guard —
        // e.g. accepting an unauthenticated impostor). Asserting on the input is
        // what actually catches such a regression.
        const h = input as Record<string, unknown>;
        return (
          h.ok === true &&
          h.presetDispatchEnforced === true &&
          h.tokenAuthenticated === true &&
          typeof h.root === 'string' &&
          canonicalServeRoot(h.root) === canonicalServeRoot(SHARED_ROOT) &&
          typeof h.pid === 'number' &&
          Number.isInteger(h.pid) &&
          h.pid > 0 &&
          typeof h.preset === 'string' &&
          Array.isArray(h.tools) &&
          (h.tools as unknown[]).every((t) => typeof t === 'string') &&
          typeof h.tokenProtected === 'boolean' &&
          // and the returned object is well-formed: root canonicalized, pid copied.
          result.root === canonicalServeRoot(h.root) &&
          result.pid === h.pid
        );
        },
      ),
      { numRuns: 2000 },
    );
    // Guard against a silently vacuous run: the accept-path invariant is only
    // meaningful if health objects are actually accepted during fuzzing.
    expect(accepted).toBeGreaterThan(20);
  });

  it('rejects an otherwise-valid health object whose root differs', () => {
    const validExceptRoot = fc.record({
      ok: fc.constant(true),
      presetDispatchEnforced: fc.constant(true),
      pid: fc.integer({ min: 1, max: 2 ** 31 }),
      preset: fc.string(),
      tools: fc.array(fc.string()),
      tokenProtected: fc.boolean(),
      tokenAuthenticated: fc.constant(true),
    });
    fc.assert(
      fc.property(validExceptRoot, (base) => {
        // A distinct, non-existent sibling path: its canonical form differs from
        // SHARED_ROOT's, so the root identity check must fail.
        const health = { ...base, root: SHARED_ROOT + '/somewhere-else-xyz' };
        return validateServeHealth(health, SHARED_ROOT) === null;
      }),
      { numRuns: 1000 },
    );
  });

  it('rejects when a descriptor pid or token-presence disagrees', () => {
    const validHealth = {
      ok: true,
      presetDispatchEnforced: true,
      root: SHARED_ROOT,
      pid: 4321,
      preset: 'full',
      tools: ['a', 'b'],
      tokenProtected: true,
      tokenAuthenticated: true,
    } as const;

    // Sanity: it accepts with a matching descriptor.
    expect(validateServeHealth(validHealth, SHARED_ROOT, { pid: 4321, token: 't' })).not.toBeNull();

    // pid mismatch → reject.
    expect(validateServeHealth(validHealth, SHARED_ROOT, { pid: 9999, token: 't' })).toBeNull();

    // token-presence disagreement: health says tokenProtected=true but descriptor
    // has no token → reject.
    expect(validateServeHealth(validHealth, SHARED_ROOT, { pid: 4321, token: undefined })).toBeNull();

    // token-presence disagreement, other direction: health says tokenProtected=false
    // but descriptor carries a token → reject.
    const unprotected = { ...validHealth, tokenProtected: false };
    expect(validateServeHealth(unprotected, SHARED_ROOT, { pid: 4321, token: 't' })).toBeNull();
  });

  it('accepts a concrete well-formed health object', () => {
    expect(
      validateServeHealth(
        {
          ok: true,
          presetDispatchEnforced: true,
          root: '/tmp/x',
          pid: 123,
          preset: 'full',
          tools: ['a', 'b'],
          tokenProtected: true,
          tokenAuthenticated: true,
        },
        '/tmp/x',
        { pid: 123, token: 't' },
      ),
    ).not.toBeNull();
  });
});
