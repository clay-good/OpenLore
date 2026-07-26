/**
 * Loopback host recognition.
 *
 * Lives in a leaf module because two unrelated faces need the same answer: the local
 * HTTP guard (is this request's Host/Origin the loopback interface?) and the
 * repo-config trust boundary (is this configured endpoint incapable of reaching the
 * network?). One implementation, so the two cannot disagree about what "local" means.
 */

/** Hostnames that denote the loopback interface (no DNS resolution involved). */
export const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '0000:0000:0000:0000:0000:0000:0000:0001',
]);

/** True if `host` is a loopback literal/name (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // Any 127.x.y.z address is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
