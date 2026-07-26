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

// Loopback recognition lives in `src/utils/loopback.ts` so the non-HTTP consumer
// (the repo-config trust boundary) can share it without importing the CLI layer.
// Imported (not re-exported blind) because this module's own guards call it.
export { LOOPBACK_HOSTNAMES, isLoopbackHost };

/** Extract the hostname (sans port, sans brackets) from a Host/Origin authority. */
export function hostnameOf(authority: string): string {
  let a = authority.trim();
  // Strip scheme if this came from an Origin (e.g. http://host:port).
  const scheme = a.indexOf('://');
  if (scheme !== -1) a = a.slice(scheme + 3);
  // Bracketed IPv6: [::1]:port
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    if (close !== -1) return a.slice(1, close).toLowerCase();
  }
  // host:port → host (IPv4 / name only; bare IPv6 has no port form here)
  const colon = a.indexOf(':');
  if (colon !== -1 && a.indexOf(':') === a.lastIndexOf(':')) a = a.slice(0, colon);
  return a.toLowerCase();
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
export function originDefenseError(req: IncomingMessage, boundHost: string): string | null {
  const boundName = hostnameOf(boundHost);
  const allowed = (name: string): boolean => isLoopbackHost(name) || name === boundName;

  const hostHeader = req.headers.host;
  if (hostHeader === undefined || !allowed(hostnameOf(hostHeader))) {
    return `Host header "${hostHeader ?? ''}" is not an allowed loopback name (DNS-rebinding guard)`;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !allowed(hostnameOf(origin))) {
    return `cross-site Origin "${origin}" is not permitted`;
  }
  return null;
}

/** Per-request guard configuration. */
export interface LocalHttpGuardConfig {
  /** The host the server is bound to (from the surface's --host). */
  boundHost: string;
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
 */
export function checkLocalHttpRequest(
  req: IncomingMessage,
  cfg: LocalHttpGuardConfig,
): LocalHttpGuardRejection | null {
  const originErr = originDefenseError(req, cfg.boundHost);
  if (originErr) return { status: 403, error: originErr };

  const tokenRequired =
    cfg.token !== undefined && (cfg.requireToken === true || !isLoopbackHost(cfg.boundHost));
  if (tokenRequired) {
    const presented = req.headers[cfg.tokenHeader ?? OPENLORE_TOKEN_HEADER];
    if (typeof presented !== 'string' || !constantTimeEqual(presented, cfg.token as string)) {
      return { status: 401, error: `invalid or missing ${cfg.tokenHeader ?? OPENLORE_TOKEN_HEADER}` };
    }
  }
  return null;
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
