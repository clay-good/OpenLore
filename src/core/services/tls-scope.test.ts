/**
 * Guards for scoped TLS relaxation.
 *
 * These assert the two runtime behaviours the design depends on, rather than
 * assuming them:
 *   - deleting NODE_TLS_REJECT_UNAUTHORIZED genuinely re-enables verification
 *     (Node does not cache the previous value), and
 *   - restoring it after `fetch()` resolves does not break an in-flight response
 *     body, because verification happens during the handshake.
 *
 * If either stopped holding, `withRelaxedTls` would silently be either useless or
 * harmful, and nothing else in the suite would notice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allowInsecureTls,
  isInsecureTlsAllowed,
  withRelaxedTls,
  resetTlsScopeForTests,
} from './tls-scope.js';

const ENV_KEY = 'NODE_TLS_REJECT_UNAUTHORIZED';

describe('tls-scope: state machine', () => {
  beforeEach(() => resetTlsScopeForTests());
  afterEach(() => resetTlsScopeForTests());

  it('is a no-op until the user opts in', async () => {
    expect(isInsecureTlsAllowed()).toBe(false);
    let seen: string | undefined = 'unset';
    await withRelaxedTls(async () => {
      seen = process.env[ENV_KEY];
    });
    // Never touched the variable, because nothing opted in.
    expect(seen).toBeUndefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('relaxes only inside the scope and restores afterwards', async () => {
    allowInsecureTls('test');
    expect(process.env[ENV_KEY]).toBeUndefined(); // opting in alone changes nothing

    let inside: string | undefined;
    await withRelaxedTls(async () => {
      inside = process.env[ENV_KEY];
    });

    expect(inside).toBe('0');
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('restores even when the wrapped call throws', async () => {
    allowInsecureTls('test');
    await expect(withRelaxedTls(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('keeps the scope open until the LAST concurrent request finishes', async () => {
    allowInsecureTls('test');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const slow = withRelaxedTls(async () => { await gate; return process.env[ENV_KEY]; });
    // A second, fast request opens and closes while `slow` is still in flight.
    const fast = await withRelaxedTls(async () => process.env[ENV_KEY]);

    expect(fast).toBe('0');
    // The inner scope closing must NOT have restored verification under `slow`.
    expect(process.env[ENV_KEY]).toBe('0');

    release();
    expect(await slow).toBe('0');
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('announces once, and not at all when the caller owns the message', () => {
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = ((c: string) => { written.push(String(c)); return true; }) as never;
    try {
      // The CLI prints its own quiet-aware notice, so the helper must stay silent —
      // and must not let a later opt-in in the same run print a duplicate.
      allowInsecureTls('--insecure', { announce: false });
      allowInsecureTls('config skipSslVerify');
    } finally {
      (process.stderr as { write: unknown }).write = orig as never;
    }
    expect(written.join('')).toBe('');
    expect(isInsecureTlsAllowed()).toBe(true);
  });

  it('announces exactly once when it owns the message', () => {
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = ((c: string) => { written.push(String(c)); return true; }) as never;
    try {
      allowInsecureTls('reason one');
      allowInsecureTls('reason two');
    } finally {
      (process.stderr as { write: unknown }).write = orig as never;
    }
    expect(written.filter((l) => l.includes('WARNING')).length).toBe(1);
  });

  it('restores a pre-existing value verbatim rather than deleting it', async () => {
    process.env[ENV_KEY] = '1';
    allowInsecureTls('test');
    await withRelaxedTls(async () => undefined);
    expect(process.env[ENV_KEY]).toBe('1');
  });
});

/**
 * Generate a throwaway self-signed cert at run time via openssl.
 *
 * Deliberately NOT a committed fixture: a checked-in private key is exactly what
 * secret scanning exists to reject, and push protection would block it. Generating
 * per-run keeps no key material in the repository. Skips cleanly where openssl is
 * unavailable rather than failing.
 */
function makeSelfSigned(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'openlore-tls-'));
    const keyPath = join(dir, 'k.pem');
    const certPath = join(dir, 'c.pem');
    const r = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
       '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'],
      { stdio: 'ignore' }
    );
    if (r.status !== 0) return null;
    return { key: readFileSync(keyPath, 'utf-8'), cert: readFileSync(certPath, 'utf-8') };
  } catch {
    return null;
  }
}

const tlsFixture = makeSelfSigned();

describe('tls-scope: real TLS behaviour', () => {
  let server: Server | undefined;

  beforeEach(() => resetTlsScopeForTests());
  afterEach(() => {
    server?.close();
    server = undefined;
    resetTlsScopeForTests();
  });

  // The whole design rests on these two Node behaviours. Asserted against a real
  // handshake, not mocked: a mock would keep passing if either changed.
  it.skipIf(!tlsFixture)(
    'rejects a self-signed cert outside the scope, accepts inside, and re-rejects after',
    async () => {
      const { key, cert } = tlsFixture!;
      server = createServer({ key, cert }, (_req, res) => {
        res.writeHead(200);
        res.write('chunk1');
        // Finish the body AFTER the scope has closed, proving the restore does not
        // interrupt an in-flight response.
        setTimeout(() => res.end('chunk2'), 50);
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      const url = `https://127.0.0.1:${port}/`;

      // 1. Strict by default.
      await expect(fetch(url)).rejects.toThrow();

      // 2. Relaxed only inside the scope.
      allowInsecureTls('test');
      const res = await withRelaxedTls(() => fetch(url));
      expect(res.status).toBe(200);

      // 3. Verification is already restored while the body is still streaming.
      expect(process.env[ENV_KEY]).toBeUndefined();
      expect(await res.text()).toBe('chunk1chunk2');

      // 4. A NEW request is rejected again — the relaxation did not persist.
      await expect(fetch(url)).rejects.toThrow();
    },
    20_000
  );
});
