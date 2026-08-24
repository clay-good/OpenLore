/**
 * Property-based fuzzing for the serve-descriptor trust boundary.
 *
 * `.openlore/serve.json` is an untrusted, repo-writable artifact whose host/port
 * later become an outbound `fetch` target during daemon liveness probing. The
 * whole SSRF/egress defense rests on one invariant: a descriptor that survives
 * `validateServeDescriptor` ALWAYS has a loopback host. These properties assert
 * that over arbitrary input, including DNS-rebinding look-alikes that CodeQL's
 * js/file-access-to-http alert (dismissed as a false positive) cannot see through.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { SERVE_PROTOCOL_VERSION, validateServeDescriptor } from '../cli/commands/serve-descriptor.js';
import { isLoopbackHost } from '../utils/loopback.js';

// Hosts that must NEVER be treated as loopback: public IPs, the cloud metadata
// endpoint, and loopback prefixes/look-alikes that anchoring must reject.
// (No trailing-whitespace variants — isLoopbackHost trims, so "127.0.0.1 " is
//  legitimately loopback and would be a wrong negative here.)
const nonLoopbackHosts = [
  '0.0.0.0',
  '10.0.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '8.8.8.8',
  'example.com',
  'evil.com',
  '127.0.0.1.evil.com',
  'localhost.evil.com',
  '127.0.0.1:8080',
  '::ffff:127.0.0.1',
  'foo127.0.0.1',
  '1270.0.0.1',
  '',
];

const loopbackHosts = ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST'];

describe('fuzz: serve descriptor validation (SSRF containment)', () => {
  it('isLoopbackHost rejects every public / rebinding host', () => {
    for (const h of nonLoopbackHosts) {
      if (isLoopbackHost(h)) throw new Error(`accepted non-loopback host: ${JSON.stringify(h)}`);
    }
  });

  it('isLoopbackHost accepts genuine loopback forms', () => {
    for (const h of loopbackHosts) {
      if (!isLoopbackHost(h)) throw new Error(`rejected loopback host: ${JSON.stringify(h)}`);
    }
  });

  it('a validated descriptor ALWAYS has a loopback host and in-range port/pid', () => {
    // Weighted toward *valid* fields so the accept path is exercised often (a
    // descriptorLike where every field is randomly typed is accepted <1/1000 of
    // the time — the invariant would be tested almost only on rejections).
    // host/port/pid are required so acceptance is not lost to a missing key.
    const descriptorLike = fc.record(
      {
        host: fc.oneof(
          { weight: 3, arbitrary: fc.constantFrom(...loopbackHosts) },
          { weight: 2, arbitrary: fc.constantFrom(...nonLoopbackHosts) },
          { weight: 1, arbitrary: fc.string() },
        ),
        port: fc.oneof(
          { weight: 3, arbitrary: fc.integer({ min: 1, max: 65535 }) },
          { weight: 1, arbitrary: fc.integer() }, // out of range / negative / 0
          { weight: 1, arbitrary: fc.double() }, // non-integer / NaN / Infinity
          { weight: 1, arbitrary: fc.string() },
        ),
        pid: fc.oneof(
          { weight: 3, arbitrary: fc.integer({ min: 1, max: 2 ** 31 }) },
          { weight: 1, arbitrary: fc.integer() },
          { weight: 1, arbitrary: fc.string() },
        ),
        token: fc.oneof(fc.string(), fc.constant(undefined)),
        startedAt: fc.oneof(fc.string(), fc.constant(undefined)),
        version: fc.oneof(fc.string(), fc.constant(undefined)),
        protocolVersion: fc.oneof(
          { weight: 4, arbitrary: fc.constant(SERVE_PROTOCOL_VERSION) },
          { weight: 1, arbitrary: fc.anything() },
        ),
      },
      { requiredKeys: ['host', 'port', 'pid'] },
    );

    let accepted = 0;
    fc.assert(
      fc.property(fc.oneof(fc.anything(), descriptorLike), (input) => {
        const result = validateServeDescriptor(input);
        if (result === null) return true; // rejection is always safe
        accepted++;
        return (
          isLoopbackHost(result.host) &&
          Number.isInteger(result.port) &&
          result.port >= 1 &&
          result.port <= 65535 &&
          Number.isInteger(result.pid) &&
          result.pid > 0 &&
          (result.token === undefined || typeof result.token === 'string')
        );
      }),
      { numRuns: 2000 },
    );
    // Guard against a silently vacuous run: the accept-path invariant is only
    // meaningful if descriptors are actually accepted during fuzzing.
    expect(accepted).toBeGreaterThan(50);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        validateServeDescriptor(input);
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('accepts a well-formed loopback descriptor and preserves its host', () => {
    const result = validateServeDescriptor({ host: '127.0.0.1', port: 8080, pid: 1234, token: 'abc', protocolVersion: SERVE_PROTOCOL_VERSION });
    expect(result).not.toBeNull();
    expect(result?.host).toBe('127.0.0.1');
    expect(result?.port).toBe(8080);
  });
});
