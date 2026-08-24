/**
 * Fail-fast Node-version guard for the OpenLore CLI.
 *
 * Why this exists: OpenLore requires Node >=22.19, but OpenSpec requires only
 * >=20.19. When OpenLore runs as an OpenSpec plugin, a user on Node 20/21 can run
 * `openspec lore generate`, which spawns `openlore` under a Node OpenLore does not
 * support. `engines` in package.json is advisory at install time and does NOT
 * protect that spawn. So we check at runtime and, below the floor, write ONE
 * legible line to stderr (required + actual versions) and exit with a stable,
 * dedicated code — never a stack trace or a partial run — so the host propagates a
 * legible failure through its exit-code plumbing.
 *
 * This module is imported FIRST in src/cli/index.ts so it evaluates before
 * commander and the heavy command modules. Keep it dependency-free.
 */

/** Minimum supported Node. Runtime dependencies require Node 22.19 or newer;
 * `node:sqlite` — imported at module load by EdgeStore, the epistemic lease, and
 * preflight scoring — is also available without `--experimental-sqlite` at this
 * floor (unflagged in Node 22.13.0 / 23.4.0, nodejs/node#55854). MUST stay in sync
 * with the FLOOR in package.json `engines.node` (`^22.19.0 || >=23.5.0`) and
 * constants.ts's `MIN_NODE_*` (a test
 * asserts all three).
 *
 * This is a major.minor floor, so it admits 23.0-23.4 even though `node:sqlite` was
 * still flagged there. That gap is deliberate and covered: the capability probe
 * below has the final word, so such a runtime fails naming the missing builtin
 * rather than passing the arithmetic and crashing later. */
export const MIN_NODE = { major: 22, minor: 19 } as const;

/** Stable, dedicated exit code for "unsupported Node" (documented contract). */
export const EXIT_UNSUPPORTED_NODE = 78;

/** The builtin whose availability the runtime actually depends on. Version
 * arithmetic is a proxy for this; the probe below asserts the real thing. */
const REQUIRED_BUILTIN = 'node:sqlite';

export interface NodeVersionCheck {
  ok: boolean;
  message?: string;
}

/**
 * Probe whether `node:sqlite` is actually loadable in THIS runtime, rather than
 * inferring it from the version number. `process.getBuiltinModule` exists since
 * Node 22.3 (below our floor), returns the builtin when available and `undefined`
 * when it is not (e.g. still behind a flag on 23.0–23.3, or stripped from a distro
 * build). Injectable so the capability path is unit-testable without a second Node. */
export function isSqliteAvailable(
  getBuiltinModule: (id: string) => unknown =
    (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.bind(process) ??
    (() => undefined),
): boolean {
  try {
    return getBuiltinModule(REQUIRED_BUILTIN) != null;
  } catch {
    return false;
  }
}

/**
 * Version + capability check — no exit side effect, so it is unit-testable.
 * Version arithmetic gates first (a clear "upgrade Node" message), then the
 * capability probe has the final word: a version number that satisfies the floor
 * but on which `node:sqlite` is not loadable still fails, naming the missing
 * builtin. `probe` is injectable so both branches are testable on a capable host. */
export function checkNodeVersion(
  versionString: string = process.versions.node,
  probe: () => boolean = () => isSqliteAvailable(),
): NodeVersionCheck {
  const [major = 0, minor = 0] = versionString.split('.').map((p) => parseInt(p, 10));
  const versionOk = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  if (!versionOk) {
    return {
      ok: false,
      message:
        `openlore requires Node >=${MIN_NODE.major}.${MIN_NODE.minor} but is running on Node ${versionString}. ` +
        `Upgrade Node (e.g. via nvm or your package manager) and retry. ` +
        `See https://github.com/clay-good/openlore#requirements`,
    };
  }
  if (!probe()) {
    return {
      ok: false,
      message:
        `openlore requires the built-in ${REQUIRED_BUILTIN} module, which is unavailable on this Node ` +
        `(${versionString}). Upgrade to Node >=${MIN_NODE.major}.${MIN_NODE.minor} where ${REQUIRED_BUILTIN} ` +
        `is available without runtime flags, and retry. ` +
        `See https://github.com/clay-good/openlore#requirements`,
    };
  }
  return { ok: true };
}

/** Side-effecting guard: writes one stderr line and exits when Node is too old. */
export function assertSupportedNode(): void {
  const result = checkNodeVersion();
  if (!result.ok) {
    process.stderr.write(`openlore: ${result.message}\n`);
    process.exit(EXIT_UNSUPPORTED_NODE);
  }
}
