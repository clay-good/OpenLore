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

import { relative } from 'node:path';
import { colorForStderr } from './colors.js';
import { logger } from './logger.js';
import { sanitizeForTerminal } from './misc.js';
import { safeOpenspecDir } from './path-confinement.js';

const disclosed = new Set<string>();

/** Resolve `config.openspecPath`, confined to the root, disclosing any fallback. */
export function resolveOpenspecDir(absRoot: string, configuredPath: string | undefined): string {
  return safeOpenspecDir(absRoot, configuredPath, (message) => {
    const key = `${absRoot} ${configuredPath ?? ''}`;
    if (disclosed.has(key)) return;
    disclosed.add(key);
    // Stderr, like every other config diagnostic: on stdout it broke `--json` output of the
    // commands that resolve the spec root (`change-status --json`, `test --json`).
    if (logger.getOptions().quiet) return;
    const prefix = colorForStderr().yellow('[warn]');
    process.stderr.write(`${prefix} ${sanitizeForTerminal(message)}\n`);
  });
}

/**
 * {@link resolveOpenspecDir}, as a repository-relative POSIX path (`.` for the root itself),
 * for callers that pass the spec root on as a relative path. Passing the raw config value
 * instead read outside the project (`../x/specs`) or threw on it.
 */
export function confinedOpenspecRel(absRoot: string, configuredPath: string | undefined): string {
  return relative(absRoot, resolveOpenspecDir(absRoot, configuredPath)).replaceAll('\\', '/') || '.';
}
