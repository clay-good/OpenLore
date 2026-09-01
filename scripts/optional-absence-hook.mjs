/**
 * Module hooks used by the outside-the-package smoke run (change:
 * extend-api-for-supervising-hosts).
 *
 * Two jobs, both of which need to observe REAL module resolution rather than a test-runner mock:
 *
 * - `OPENLORE_SMOKE_BLOCK` — a comma-separated package list to make unresolvable, reproducing an
 *   installation created with `--omit=optional`. The failure is the same `ERR_MODULE_NOT_FOUND`
 *   Node raises for a package that is genuinely absent, so a fail-soft loader is tested against the
 *   error it will actually see (cli: OptionalFeatureDependenciesDegradeAtTheirOwnCommand).
 * - `OPENLORE_SMOKE_TRACE` — a file to append every resolved specifier to, so a caller can assert
 *   what a published entry point does NOT load (api: the descriptor subpath must not reach the
 *   analyzer).
 */
import { appendFileSync } from 'node:fs';

const blocked = (process.env.OPENLORE_SMOKE_BLOCK ?? '').split(',').map(s => s.trim()).filter(Boolean);
const tracePath = process.env.OPENLORE_SMOKE_TRACE;

/** Does a specifier name a blocked package (bare, or one of its subpaths)? */
function isBlocked(specifier) {
  return blocked.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

export async function resolve(specifier, context, next) {
  if (isBlocked(specifier)) {
    const error = new Error(`Cannot find package '${specifier}' imported from ${context.parentURL ?? 'unknown'}`);
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  const resolved = await next(specifier, context);
  if (tracePath) appendFileSync(tracePath, `${specifier}\t${resolved.url}\n`);
  return resolved;
}
