/**
 * Shared request guard for OpenLore's local HTTP surfaces (the `serve` daemon and
 * the `view` graph server).
 *
 * OpenLore binds more than one local HTTP listener; both must present the same
 * door to a browser. This module is the single, dependency-light home for the
 * security-critical primitives so the two surfaces cannot drift:
 *
 *   - a Host-header allowlist restricted to loopback forms (DNS-rebinding guard),
 *   - an Origin check rejecting foreign browser origins,
 *   - a constant-time token comparison,
 *
 * plus {@link checkLocalHttpRequest}, the composed policy a surface applies per
 * request: reject a cross-origin/rebinding request (403), then require the
 * `x-openlore-token` header when the binding is non-loopback OR the route is a
 * money/agent endpoint (401). See the `mcp-security` spec requirement
 * `AllLocalHttpSurfacesShareTheGuard`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LOOPBACK_HOSTNAMES, isLoopbackHost } from '../../utils/loopback.js';

/** Header a client presents to authenticate to a local OpenLore HTTP surface. */
export const OPENLORE_TOKEN_HEADER = 'x-openlore-token';

/**
 * Cookie a BROWSER presents instead of the header.
 *
 * A browser cannot attach a custom header to the navigation that loads a page, so a
 * surface a human opens has to authenticate that first request some other way. The
 * viewer does it by handing the token over once in the URL and exchanging it for this
 * cookie (see `view.ts`) — which is why the guard accepts either credential.
 */
export const OPENLORE_SESSION_COOKIE = 'openlore_session';

/** Read one cookie value from a `Cookie:` header. Returns undefined when absent. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

// Loopback recognition lives in `src/utils/loopback.ts` so the non-HTTP consumer
// (the repo-config trust boundary) can share it without importing the CLI layer.
// Imported (not re-exported blind) because this module's own guards call it.
export { LOOPBACK_HOSTNAMES, isLoopbackHost };

/**
 * Split a `Host` or `Origin` authority into its hostname and port, using a real URL
 * parser rather than string surgery.
 *
 * Hand-rolled splitting failed OPEN on authorities whose real host is not the prefix:
 * `http://127.0.0.1:5302@evil.com` (the `127.0.0.1:5302` is USERINFO — the host is
 * `evil.com`) and `http://127.0.0.1:5302.evil.com` (the "port" is a domain) both
 * read as loopback. Returns null when the value cannot be parsed or carries
 * credentials, and null is treated as "reject".
 */
export function parseAuthority(value: string): { hostname: string; port: number | null } | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    // Userinfo means the authority is not what a naive read of it suggests.
    if (u.username !== '' || u.password !== '') return null;
    const defaultPort = u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null;
    return {
      hostname: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      port: u.port === '' ? defaultPort : Number(u.port),
    };
  } catch {
    return null;
  }
}

/** Extract the hostname (sans port, sans brackets) from a Host/Origin authority. */
export function hostnameOf(authority: string): string {
  return parseAuthority(authority)?.hostname ?? '';
}

/**
 * Constant-time string equality. Returns false for length mismatch, but still
 * runs a same-length compare first so timing does not leak the secret's length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    // Compare ab to itself to burn comparable time, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Write an instance descriptor (`serve.json` / `view.json`) so only its owner can
 * read it.
 *
 * The descriptor carries the surface's `token`, and that token IS the mitigation
 * against the other-local-process attacker: `checkLocalHttpRequest` demands it even
 * on a loopback bind for money/agent routes, precisely because a loopback port is
 * reachable by every process on the machine. Written at the default 0644 the secret
 * sits in the repo where that same attacker can simply read it, so the gate guards a
 * door whose key is on the mat. 0600 on the file keeps the token to the user who
 * started the surface. (The 0700 on `.openlore/` only applies when this call is what
 * CREATES the directory — `mkdir` does not re-mode an existing one, and by the time a
 * surface starts the directory usually exists. The file mode is what carries the
 * guarantee.)
 *
 * The explicit `chmod` is not redundant with the `mode` option: `mode` applies only
 * when `open` CREATES the file, so a descriptor left behind by an older OpenLore (or
 * pre-created by another local user) would otherwise keep its permissive mode.
 */
export async function writeInstanceDescriptor(
  descriptorPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(descriptorPath), { recursive: true, mode: 0o700 });
  await writeFile(descriptorPath, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await chmod(descriptorPath, 0o600);
}

/**
 * DNS-rebinding / cross-origin defense for a loopback listener. A browser tricked
 * into resolving an attacker domain to 127.0.0.1 still sends the attacker's name in
 * the `Host` header (and an attacker page sends a cross-site `Origin`). We accept a
 * request only when both the Host and any Origin name the loopback interface or the
 * exact bound host. Returns an error string to reject with, or null to allow.
 *
 * The opaque origin (`Origin: null`) is rejected along with the rest. It used to be
 * allowed for hypothetical `file://` clients — there are none in-tree — but a
 * sandboxed cross-site iframe sends exactly that header, which made it a way for a
 * web page to drive the tokenless loopback daemon (`approve_decision`, `remember`)
 * with a simple, preflight-free `text/plain` POST. The spec's requirement is to
 * reject a cross-site Origin, and an opaque one is cross-site.
 */
export function originDefenseError(
  req: IncomingMessage,
  boundHost: string,
  boundPort?: number,
): string | null {
  const boundName = hostnameOf(boundHost);
  const allowedHost = (name: string): boolean => isLoopbackHost(name) || name === boundName;

  const host = parseAuthority(req.headers.host ?? '');
  if (!host || !allowedHost(host.hostname)) {
    return `Host header "${req.headers.host ?? ''}" is not an allowed loopback name (DNS-rebinding guard)`;
  }
  if (boundPort !== undefined && host.port !== boundPort) {
    return `Host header "${req.headers.host ?? ''}" does not name this listener's port ${boundPort}`;
  }

  const origin = req.headers.origin;
  if (origin !== undefined) {
    const o = parseAuthority(origin);
    if (!o || !allowedHost(o.hostname)) {
      return `cross-site Origin "${origin}" is not permitted`;
    }
    // The PORT is the load-bearing half here. A "site" for cookie purposes is
    // scheme + registrable domain — the port is NOT part of it — so a page served
    // from ANY other port on localhost is same-site, and the browser attaches this
    // surface's SameSite=Strict session cookie to its requests. Matching on hostname
    // alone therefore let any other local dev server (or any localhost page the user
    // happened to visit) read the viewer's API and drive its LLM-backed chat route.
    if (boundPort !== undefined && o.port !== boundPort) {
      return `cross-site Origin "${origin}" is not permitted (different port from this listener)`;
    }
  }
  return null;
}

/** Per-request guard configuration. */
export interface LocalHttpGuardConfig {
  /** The host the server is bound to (from the surface's --host). */
  boundHost: string;
  /** The port it listens on. Required to reject a same-host, different-port origin. */
  boundPort?: number;
  /** The instance token, if one is configured. */
  token?: string;
  /**
   * Force the token even on a loopback binding — for money/agent endpoints
   * (e.g. the viewer's chat route) that must not be driven by another local
   * process or a header-less rebinding page. On a non-loopback binding the token
   * is always required regardless of this flag.
   */
  requireToken?: boolean;
  /** Header carrying the token. Defaults to {@link OPENLORE_TOKEN_HEADER}. */
  tokenHeader?: string;
}

/** A rejection to send. `null` from {@link checkLocalHttpRequest} means "allow". */
export interface LocalHttpGuardRejection {
  status: number;
  error: string;
}

/**
 * Apply the shared local-HTTP guard to a request. Returns a rejection to send
 * (403 for a rebinding/cross-origin request, 401 for a missing/invalid token) or
 * `null` to allow the request through.
 *
 * Token policy: a token is required when a token is configured AND either the
 * binding is non-loopback (anyone on the network can reach the port) or the
 * caller marked the route `requireToken` (a money/agent endpoint).
 *
 * The credential may arrive as the `x-openlore-token` header (programmatic clients)
 * or as the session cookie (a browser, which cannot set headers on a navigation).
 * Both are compared in constant time.
 */
export function checkLocalHttpRequest(
  req: IncomingMessage,
  cfg: LocalHttpGuardConfig,
): LocalHttpGuardRejection | null {
  const originErr = originDefenseError(req, cfg.boundHost, cfg.boundPort);
  if (originErr) return { status: 403, error: originErr };

  const tokenRequired =
    cfg.token !== undefined && (cfg.requireToken === true || !isLoopbackHost(cfg.boundHost));
  if (tokenRequired) {
    const headerName = cfg.tokenHeader ?? OPENLORE_TOKEN_HEADER;
    const fromHeader = req.headers[headerName];
    const fromCookie = readCookie(req.headers.cookie, OPENLORE_SESSION_COOKIE);
    const expected = cfg.token as string;
    const ok =
      (typeof fromHeader === 'string' && constantTimeEqual(fromHeader, expected)) ||
      (typeof fromCookie === 'string' && constantTimeEqual(fromCookie, expected));
    if (!ok) {
      return { status: 401, error: `invalid or missing ${headerName}` };
    }
  }
  return null;
}

/**
 * Build the middleware that gates EVERY route of a browser-facing surface, and
 * performs the URL-token → cookie handshake that lets a browser in.
 *
 * WHY THIS EXISTS. The viewer used to embed its token in the HTML it served and gate
 * only `/api`, which meant `/` was unauthenticated: any other process on the machine
 * could `curl http://127.0.0.1:PORT/`, read the token out of the page, and then drive
 * the token-gated, LLM-backed chat route. The token was the mitigation against exactly
 * that attacker, and the page handed it out.
 *
 * The exchange (the model Jupyter uses): the CLI opens the browser at `/?token=<t>`;
 * the first request presenting a valid token gets an HttpOnly, SameSite=Strict cookie
 * and a redirect that strips the token from the URL (so it does not linger in history
 * or leak via Referer). Every later request — the page, its assets, its `/api` calls —
 * authenticates with the cookie the browser now holds. A process that curls `/` with no
 * credential gets a 401 instead of the key.
 *
 * HttpOnly keeps the cookie out of `document.cookie`, so injected page script cannot
 * read it back out; SameSite=Strict means it is never attached to a cross-site request,
 * which (with the Origin/Host checks above) is what keeps a cookie-authenticated
 * surface from being CSRF-able.
 *
 * RESIDUAL, stated plainly: the token appears once in the URL, so it is briefly visible
 * in the argv of the browser-open process (world-readable on Linux) and in the browser's
 * own history. That is a much narrower window than a page that serves the token to
 * anyone who asks, but it is not zero — the same trade Jupyter makes.
 */
export function createBrowserSessionGuard(opts: {
  boundHost: string;
  boundPort?: number;
  token: string;
  /** Paths that skip the gate entirely (health probes). Compared after query strip. */
  publicPaths?: ReadonlySet<string>;
}): ConnectMiddleware {
  return (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const [pathname, query] = rawUrl.split('?');

    if (opts.publicPaths?.has(pathname)) {
      next();
      return;
    }

    // Origin/Host defense runs first, before any credential is read or issued.
    const originErr = originDefenseError(req, opts.boundHost, opts.boundPort);
    if (originErr) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: originErr }));
      return;
    }

    // Already authenticated (cookie from a previous handshake, or an explicit header).
    const fromCookie = readCookie(req.headers.cookie, OPENLORE_SESSION_COOKIE);
    const fromHeader = req.headers[OPENLORE_TOKEN_HEADER];
    if (
      (typeof fromCookie === 'string' && constantTimeEqual(fromCookie, opts.token)) ||
      (typeof fromHeader === 'string' && constantTimeEqual(fromHeader, opts.token))
    ) {
      next();
      return;
    }

    // Handshake: a valid ?token= is exchanged for the cookie, then redirected away.
    const params = new URLSearchParams(query ?? '');
    const presented = params.get('token');
    if (presented !== null && constantTimeEqual(presented, opts.token)) {
      params.delete('token');
      const rest = params.toString();
      res.statusCode = 302;
      res.setHeader(
        'Set-Cookie',
        `${OPENLORE_SESSION_COOKIE}=${encodeURIComponent(opts.token)}; Path=/; HttpOnly; SameSite=Strict`,
      );
      res.setHeader('Location', rest ? `${pathname}?${rest}` : pathname);
      res.end();
      return;
    }

    res.statusCode = 401;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(
      'openlore view: this page requires the entry link printed by the command that ' +
        'started it. Re-open that URL (it contains ?token=...), or restart `openlore view`.\n',
    );
  };
}

/** Minimal connect-style middleware signature (a subset of what vite/connect pass). */
export type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/**
 * Build a connect/vite middleware that enforces {@link checkLocalHttpRequest} on
 * every request that reaches it. Mount it at the `/api` prefix BEFORE any
 * `/api/*` route so no route can be reached without passing the guard.
 *
 * `requireTokenFor(pathname)` receives the request pathname RELATIVE to the mount
 * point (e.g. `/chat` for a request to `/api/chat`) and returns true for routes
 * that must present the token even on a loopback binding.
 */
export function createApiGuardMiddleware(opts: {
  boundHost: string;
  boundPort?: number;
  token?: string;
  requireTokenFor?: (relativePathname: string) => boolean;
  tokenHeader?: string;
}): ConnectMiddleware {
  return (req, res, next) => {
    // Under a connect prefix mount ('/api'), req.url is relative to the mount:
    // a request to /api/chat arrives here as '/chat'.
    const rel = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
    const rejection = checkLocalHttpRequest(req, {
      boundHost: opts.boundHost,
      boundPort: opts.boundPort,
      token: opts.token,
      requireToken: opts.requireTokenFor ? opts.requireTokenFor(rel) : false,
      tokenHeader: opts.tokenHeader,
    });
    if (rejection) {
      res.statusCode = rejection.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: rejection.error }));
      return;
    }
    next();
  };
}
