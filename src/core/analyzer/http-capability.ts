/**
 * Cross-service HTTP capability surface (change: add-cross-service-api-topology).
 *
 * The authoritative declaration of which languages participate in cross-service API
 * topology. Kept in a dependency-free LEAF module so the language-support registry
 * can derive its `crossServiceHttp` column from it WITHOUT importing the full
 * `http-route-parser` (which several tests `vi.mock`, and which sits in the
 * call-graph's import cycle). `http-route-parser` re-exports these for the public
 * extraction API; a behavioral test (language-support.test.ts) proves each member
 * actually extracts a client call or a route, so the registry cannot over-claim.
 */

/** Languages OpenLore extracts outbound HTTP CLIENT call sites from (fetch/axios/ky/got). */
export const HTTP_CLIENT_LANGUAGES: ReadonlySet<string> = new Set(['TypeScript', 'JavaScript']);

/** Languages OpenLore extracts server ROUTE registrations from (the handler half of an edge). */
export const HTTP_ROUTE_LANGUAGES: ReadonlySet<string> = new Set([
  'TypeScript', 'JavaScript', 'Python', 'Java',
]);

/**
 * Languages that contribute to a cross-service edge — as a client call site, a
 * server route handler, or both. The union of the two halves above; the registry's
 * `crossServiceHttp` capability is exactly membership in this set.
 */
export const CROSS_SERVICE_HTTP_LANGUAGES: ReadonlySet<string> = new Set([
  ...HTTP_CLIENT_LANGUAGES,
  ...HTTP_ROUTE_LANGUAGES,
]);
