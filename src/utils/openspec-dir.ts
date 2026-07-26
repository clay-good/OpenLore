/**
 * The disclosing wrapper around {@link safeOpenspecDir}.
 *
 * `path-confinement.ts` is a dependency-free leaf on purpose, so it reports a clamp
 * through a callback rather than logging. This is the one place that callback is wired
 * to the logger, because a SILENT clamp is its own defect: a monorepo pointing
 * `openspecPath` at `../shared-specs` gets its specs quietly ignored, and a hostile
 * repo's escaping value gets neutralized without the operator ever learning that the
 * config they are reading does not describe what the tool actually did.
 *
 * Warned once per (root, value) per process — the resolution runs on nearly every
 * command and several times within one, and repeating the line would bury it.
 */

import { logger } from './logger.js';
import { safeOpenspecDir } from './path-confinement.js';

const disclosed = new Set<string>();

/** Resolve `config.openspecPath`, confined to the root, disclosing any fallback. */
export function resolveOpenspecDir(absRoot: string, configuredPath: string | undefined): string {
  return safeOpenspecDir(absRoot, configuredPath, (message) => {
    const key = `${absRoot} ${configuredPath ?? ''}`;
    if (disclosed.has(key)) return;
    disclosed.add(key);
    logger.warning(message);
  });
}
