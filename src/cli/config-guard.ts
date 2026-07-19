/**
 * Guard for an explicitly-passed global `--config` path.
 *
 * A `--config` value the user typed on the command line that does not resolve to
 * a readable file is a fatal error naming the path — never a silent fallback to
 * the default config (which would run, e.g., without the enforcement policy the
 * user asked for). The built-in default value is exempt: a repo without an
 * `.openlore/config.json` is the normal pre-init state (OutputContractsAreUniform,
 * change: fix-cli-output-hygiene).
 */

import { accessSync, constants as fsConstants } from 'node:fs';

/** How commander reported the option's value origin. */
export type OptionValueSource = 'cli' | 'default' | 'env' | 'config' | 'implied' | undefined;

export interface ConfigGuardResult {
  ok: boolean;
  /** Populated only when ok === false — the fatal message to print. */
  message?: string;
}

/**
 * Decide whether an explicit `--config` path is acceptable. Only a value that
 * came from the CLI is checked; a `default`/unset source always passes.
 *
 * `readable` is injected so the decision is pure and unit-testable; the default
 * probes the filesystem with `R_OK`.
 */
export function checkExplicitConfig(
  source: OptionValueSource,
  configPath: string | undefined,
  readable: (p: string) => boolean = defaultReadable,
): ConfigGuardResult {
  if (source !== 'cli') return { ok: true };
  if (typeof configPath === 'string' && readable(configPath)) return { ok: true };
  return {
    ok: false,
    message: `--config: cannot read config file '${configPath}'. Check the path exists and is readable.`,
  };
}

function defaultReadable(p: string): boolean {
  try {
    accessSync(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
