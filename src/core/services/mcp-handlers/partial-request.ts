/**
 * Request-scoped record of "this answer came from a partial first-run index"
 * (change: refine-first-run-partial-serving).
 *
 * The completeness receipt has to reach the caller, and the caller is not always an MCP stdio
 * client: the same handlers are dispatched by the serve daemon over HTTP, by every CLI command
 * that wraps `dispatchTool`, and by the programmatic API. A receipt emitted at one transport is
 * a receipt the other transports silently drop — and a partial answer without its receipt is
 * the one failure this whole change exists to prevent. So the receipt is attached where all of
 * them meet, in `dispatchTool`, and this module is how the read path tells it what happened.
 *
 * `AsyncLocalStorage` rather than a directory-keyed map with a TTL: a daemon serves requests
 * concurrently, and a time window wide enough to cover a slow handler is also wide enough to
 * stamp a *complete*-index answer with a partial receipt a moment after the build published.
 * Request scope is the only scope that cannot mis-attribute.
 *
 * Its own module rather than part of `utils.ts` — which most handler tests mock wholesale — for
 * the same reason `artifact-cache.ts` is: a read path shared by many handlers should not depend
 * on every one of those mocks remembering to list it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { PartialIndexStamp } from '../../runtime/partial-index.js';

interface PartialRequestScope {
  stamp?: PartialIndexStamp;
}

const scope = new AsyncLocalStorage<PartialRequestScope>();

/** Run one tool dispatch inside a fresh receipt scope. */
export function withPartialReceiptScope<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({}, fn);
}

/**
 * Record that this request was answered, in whole or in part, from a partial index.
 *
 * A no-op outside a dispatch scope, which is what makes it safe to call from a read path that
 * also runs under `openlore analyze`, the watcher, and the test suite.
 */
export function notePartialIndexServed(stamp: PartialIndexStamp): void {
  const store = scope.getStore();
  if (store && !store.stamp) store.stamp = stamp;
}

/** The partial index this request was served from, if any. */
export function partialReceiptForThisRequest(): PartialIndexStamp | undefined {
  return scope.getStore()?.stamp;
}
