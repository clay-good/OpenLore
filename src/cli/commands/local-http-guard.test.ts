/**
 * Tests for the shared local-HTTP request guard (local-http-guard.ts) — the one
 * door both the `serve` daemon and the `view` graph server put in front of every
 * API route. Covers the DNS-rebinding / cross-origin defense, the constant-time
 * token gate's policy branches, and the connect middleware factory.
 *
 * Guards the `mcp-security` requirement AllLocalHttpSurfacesShareTheGuard.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isLoopbackHost,
  hostnameOf,
  constantTimeEqual,
  originDefenseError,
  checkLocalHttpRequest,
  createApiGuardMiddleware,
  OPENLORE_TOKEN_HEADER,
  createBrowserSessionGuard,
  readCookie,
} from './local-http-guard.js';

/** Minimal IncomingMessage stand-in — only headers/url are read by the guard. */
function fakeReq(headers: Record<string, string | undefined>, url = '/'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe('isLoopbackHost', () => {
  it('accepts loopback names and literals', () => {
    for (const h of ['localhost', '127.0.0.1', '127.5.6.7', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });
  it('rejects non-loopback hosts', () => {
    for (const h of ['0.0.0.0', 'attacker.example.com', '10.0.0.1', '192.168.1.5', '128.0.0.1']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('hostnameOf', () => {
  it('strips ports, schemes, and IPv6 brackets', () => {
    expect(hostnameOf('127.0.0.1:5173')).toBe('127.0.0.1');
    expect(hostnameOf('http://localhost:8080')).toBe('localhost');
    expect(hostnameOf('[::1]:5173')).toBe('::1');
    expect(hostnameOf('https://evil.example.com')).toBe('evil.example.com');
  });
});

describe('constantTimeEqual', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEqual('sekret', 'sekret')).toBe(true);
    expect(constantTimeEqual('sekret', 'sekrey')).toBe(false);
    expect(constantTimeEqual('sekret', 'sekre')).toBe(false); // length mismatch
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('originDefenseError', () => {
  const bound = '127.0.0.1';
  it('allows a loopback Host with no Origin', () => {
    expect(originDefenseError(fakeReq({ host: '127.0.0.1:5173' }), bound)).toBeNull();
  });
  it('allows a same-origin loopback Host + Origin', () => {
    expect(
      originDefenseError(fakeReq({ host: 'localhost:5173', origin: 'http://localhost:5173' }), bound),
    ).toBeNull();
  });
  it('rejects a foreign (rebinding) Host', () => {
    const err = originDefenseError(fakeReq({ host: 'attacker.example.com' }), bound);
    expect(err).toMatch(/DNS-rebinding/);
  });
  it('rejects a missing Host', () => {
    expect(originDefenseError(fakeReq({}), bound)).toMatch(/DNS-rebinding/);
  });
  it('rejects a cross-site Origin even with a loopback Host', () => {
    const err = originDefenseError(
      fakeReq({ host: '127.0.0.1:5173', origin: 'https://evil.example.com' }),
      bound,
    );
    expect(err).toMatch(/cross-site Origin/);
  });
  it('rejects the opaque "null" Origin (a sandboxed cross-site iframe sends it)', () => {
    // A sandboxed iframe on an attacker page sends `Origin: null`; allowing it let a
    // web page drive the tokenless loopback daemon with a preflight-free POST.
    expect(
      originDefenseError(fakeReq({ host: '127.0.0.1:5173', origin: 'null' }), bound),
    ).toMatch(/cross-site Origin/);
  });
});

describe('checkLocalHttpRequest — token policy', () => {
  const good = { host: '127.0.0.1:5173' };

  it('403s a rebinding request before any token check', () => {
    const r = checkLocalHttpRequest(fakeReq({ host: 'evil.example.com' }), {
      boundHost: '127.0.0.1',
      token: 'sekret',
      requireToken: true,
    });
    expect(r?.status).toBe(403);
  });

  it('allows a loopback request with no token when none is required', () => {
    const r = checkLocalHttpRequest(fakeReq(good), { boundHost: '127.0.0.1', token: 'sekret' });
    expect(r).toBeNull();
  });

  it('401s a requireToken route on loopback without the token', () => {
    const r = checkLocalHttpRequest(fakeReq(good), {
      boundHost: '127.0.0.1',
      token: 'sekret',
      requireToken: true,
    });
    expect(r?.status).toBe(401);
  });

  it('allows a requireToken route on loopback WITH the token', () => {
    const r = checkLocalHttpRequest(
      fakeReq({ ...good, [OPENLORE_TOKEN_HEADER]: 'sekret' }),
      { boundHost: '127.0.0.1', token: 'sekret', requireToken: true },
    );
    expect(r).toBeNull();
  });

  it('401s a wrong token', () => {
    const r = checkLocalHttpRequest(
      fakeReq({ ...good, [OPENLORE_TOKEN_HEADER]: 'nope' }),
      { boundHost: '127.0.0.1', token: 'sekret', requireToken: true },
    );
    expect(r?.status).toBe(401);
  });

  it('requires the token on a non-loopback binding even for a non-requireToken route', () => {
    // Host allowlist also names the bound host (0.0.0.0) so origin defense passes.
    const r = checkLocalHttpRequest(fakeReq({ host: '0.0.0.0:5173' }), {
      boundHost: '0.0.0.0',
      token: 'sekret',
      requireToken: false,
    });
    expect(r?.status).toBe(401);
  });

  it('never requires a token when none is configured', () => {
    const r = checkLocalHttpRequest(fakeReq(good), { boundHost: '127.0.0.1', requireToken: true });
    expect(r).toBeNull();
  });
});

/** Record a middleware's effect: either it wrote a status+body or it called next(). */
function runMiddleware(
  mw: ReturnType<typeof createApiGuardMiddleware>,
  req: IncomingMessage,
): { status?: number; body?: string; nexted: boolean } {
  const out: { status?: number; body?: string; nexted: boolean } = { nexted: false };
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((b?: string) => {
      out.body = b;
    }),
  } as unknown as ServerResponse;
  mw(req, res, () => {
    out.nexted = true;
  });
  if (!out.nexted) out.status = (res as unknown as { statusCode: number }).statusCode;
  return out;
}

describe('createApiGuardMiddleware', () => {
  const mw = createApiGuardMiddleware({
    boundHost: '127.0.0.1',
    token: 'sekret',
    requireTokenFor: (rel) => rel === '/chat',
  });

  it('403s a rebinding request on any route', () => {
    // req.url is relative to the /api mount: '/skeleton' => /api/skeleton.
    const r = runMiddleware(mw, fakeReq({ host: 'evil.example.com' }, '/skeleton'));
    expect(r.status).toBe(403);
    expect(r.nexted).toBe(false);
  });

  it('passes a same-origin non-chat route with no token (loopback)', () => {
    const r = runMiddleware(mw, fakeReq({ host: '127.0.0.1:5173' }, '/skeleton?file=x'));
    expect(r.nexted).toBe(true);
  });

  it('401s /chat without the token even on loopback', () => {
    const r = runMiddleware(mw, fakeReq({ host: '127.0.0.1:5173' }, '/chat'));
    expect(r.status).toBe(401);
    expect(r.nexted).toBe(false);
  });

  it('passes /chat with the token', () => {
    const r = runMiddleware(
      mw,
      fakeReq({ host: '127.0.0.1:5173', [OPENLORE_TOKEN_HEADER]: 'sekret' }, '/chat'),
    );
    expect(r.nexted).toBe(true);
  });

  it('treats /chat/models like an ordinary route (no token needed on loopback)', () => {
    const r = runMiddleware(mw, fakeReq({ host: '127.0.0.1:5173' }, '/chat/models'));
    expect(r.nexted).toBe(true);
  });
});

// ============================================================================
// Browser session handshake — the gate on `/`, not just `/api`
// ============================================================================

describe('createBrowserSessionGuard', () => {
  const TOKEN = 'a'.repeat(48);
  const bound = '127.0.0.1';

  /** Minimal ServerResponse capture. */
  function fakeRes(): {
    statusCode: number; headers: Record<string, string>; body: string; ended: boolean;
    setHeader(k: string, v: string): void; end(b?: string): void;
  } {
    return {
      statusCode: 200, headers: {}, body: '', ended: false,
      setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
      end(b?: string) { this.body = b ?? ''; this.ended = true; },
    };
  }

  function run(headers: Record<string, string | undefined>, url: string) {
    const guard = createBrowserSessionGuard({ boundHost: bound, token: TOKEN });
    const res = fakeRes();
    let passed = false;
    guard(fakeReq(headers, url), res as never, () => { passed = true; });
    return { res, passed };
  }

  it('refuses an unauthenticated request for the page itself', () => {
    // `curl http://127.0.0.1:PORT/` — the exact attack. It used to return the page
    // WITH the token in it; it must now return nothing useful.
    const { res, passed } = run({ host: '127.0.0.1:5173' }, '/');
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(TOKEN);
  });

  it('exchanges a valid ?token= for an HttpOnly SameSite cookie and redirects it away', () => {
    const { res, passed } = run({ host: '127.0.0.1:5173' }, `/?token=${TOKEN}`);
    expect(passed).toBe(false);              // the handshake answers; it does not fall through
    expect(res.statusCode).toBe(302);
    const cookie = res.headers['set-cookie'];
    expect(cookie).toContain(`openlore_session=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/);      // page script cannot read it back out
    expect(cookie).toMatch(/SameSite=Strict/); // never sent cross-site → not CSRF-able
    // The token must not survive in the URL (address bar, history, Referer).
    expect(res.headers['location']).toBe('/');
    expect(res.headers['location']).not.toContain(TOKEN);
  });

  it('preserves other query parameters across the handshake redirect', () => {
    const { res } = run({ host: '127.0.0.1:5173' }, `/x?a=1&token=${TOKEN}&b=2`);
    expect(res.headers['location']).toBe('/x?a=1&b=2');
  });

  it('admits a request carrying the session cookie', () => {
    const { passed } = run({ host: '127.0.0.1:5173', cookie: `openlore_session=${TOKEN}` }, '/assets/app.js');
    expect(passed).toBe(true);
  });

  it('rejects a wrong token and a wrong cookie', () => {
    expect(run({ host: '127.0.0.1:5173' }, `/?token=${'b'.repeat(48)}`).res.statusCode).toBe(401);
    expect(run({ host: '127.0.0.1:5173', cookie: 'openlore_session=nope' }, '/').res.statusCode).toBe(401);
  });

  it('applies the rebinding/Origin defense BEFORE issuing a credential', () => {
    // A valid token must not be exchangeable for a cookie by a page on another origin.
    const { res } = run(
      { host: '127.0.0.1:5173', origin: 'https://evil.example.com' },
      `/?token=${TOKEN}`,
    );
    expect(res.statusCode).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('lets an explicit header through, for non-browser clients', () => {
    expect(run({ host: '127.0.0.1:5173', 'x-openlore-token': TOKEN }, '/').passed).toBe(true);
  });
});

describe('readCookie', () => {
  it('reads one value out of a Cookie header, ignoring neighbours', () => {
    expect(readCookie('a=1; openlore_session=xyz; b=2', 'openlore_session')).toBe('xyz');
    expect(readCookie('openlore_session=xyz', 'openlore_session')).toBe('xyz');
    expect(readCookie('other=1', 'openlore_session')).toBeUndefined();
    expect(readCookie(undefined, 'openlore_session')).toBeUndefined();
  });

  it('does not confuse a cookie whose name merely ends with the target', () => {
    expect(readCookie('not_openlore_session=evil', 'openlore_session')).toBeUndefined();
  });
});
