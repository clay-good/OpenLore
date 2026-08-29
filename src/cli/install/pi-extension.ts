/**
 * The Pi extension artifact OpenLore installs, and the rules for replacing it.
 *
 * Pi loads `.pi/extensions/*.js` (project) or `~/.pi/agent/extensions/*.js`
 * (global) through jiti. The compiled extension at `<package>/dist/pi/extension.js`
 * is plain `tsc` output, NOT a bundle: it still imports `../cli/commands/…` and
 * `../core/services/…` relative to its own location. Copying that file into
 * `.pi/extensions/` therefore produces an extension that throws
 * `Cannot find module '../cli/commands/orient-inject-render.js'` the moment Pi
 * loads it.
 *
 * So we install a one-line re-export shim instead: Pi loads the shim, the shim
 * pulls the real module from inside the openlore package, and every relative
 * import resolves where it was compiled to resolve. Pi's own loader aliases the
 * `@earendil-works/*` and `typebox` specifiers, so those resolve regardless of
 * where the module sits on disk.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fingerprint } from './block.js';

/** Project-relative destination, and the legacy `.ts` name older versions wrote. */
export const PI_EXTENSION_REL = join('.pi', 'extensions', 'openlore.js');
export const PI_EXTENSION_LEGACY_REL = join('.pi', 'extensions', 'openlore.ts');

const MARKER = '// openlore-managed';
const FINGERPRINT_PREFIX = '// openlore-fingerprint: ';

/** Root of the openlore package (…/install -> ../../.. from dist or src). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Absolute path of the compiled extension inside the installed package. */
export const PI_EXTENSION_SOURCE = join(PACKAGE_ROOT, 'dist', 'pi', 'extension.js');

/**
 * The shim we write. The absolute path binds this project to the openlore
 * package that installed it — re-run install after moving or reinstalling
 * openlore, or use `pi install npm:openlore` for a location-independent wiring.
 */
export function renderPiShim(sourcePath: string = PI_EXTENSION_SOURCE): string {
  const body =
    `${MARKER} — Pi extension. Regenerate with "openlore install --agent pi"; edits here are overwritten.\n` +
    `// Re-exported from the openlore package so the extension's own relative imports resolve.\n` +
    `// The path below is absolute: re-run install after moving/reinstalling openlore.\n` +
    `export { default } from ${JSON.stringify(pathToFileURL(sourcePath).href)};\n`;
  return `${FINGERPRINT_PREFIX}${fingerprint(body)}\n${body}`;
}

export type PiFileState =
  /** Nothing at the destination. */
  | { kind: 'absent' }
  /** Our shim, untouched, already pointing at `sourcePath`. */
  | { kind: 'current' }
  /** Our shim, untouched, but pointing somewhere else (openlore moved/upgraded). */
  | { kind: 'stale' }
  /** A copy of the compiled bundle (any version) — what older `openlore setup --tools pi` wrote. */
  | { kind: 'legacy-copy' }
  /** Our shim with edits inside it, or a file we did not write. */
  | { kind: 'foreign' };

/**
 * Classify what is already at the destination, so the broken artifact older
 * versions installed is replaced without demanding `--force` while a genuinely
 * hand-written `openlore.js` is not. Our own shim is recognised by its
 * fingerprint; a copied bundle by the signatures in `looksLikeCopiedPiBundle`.
 */
export function classifyPiFile(existing: string | null, expected: string): PiFileState {
  if (existing === null) return { kind: 'absent' };
  if (existing === expected) return { kind: 'current' };

  const lines = existing.split('\n');
  const fpLine = lines.find((l) => l.startsWith(FINGERPRINT_PREFIX));
  if (fpLine && lines.some((l) => l.startsWith(MARKER))) {
    const stored = fpLine.slice(FINGERPRINT_PREFIX.length).trim();
    const body = lines.filter((l) => !l.startsWith(FINGERPRINT_PREFIX)).join('\n');
    return stored === fingerprint(body) ? { kind: 'stale' } : { kind: 'foreign' };
  }

  if (looksLikeCopiedPiBundle(existing)) return { kind: 'legacy-copy' };
  return { kind: 'foreign' };
}

/**
 * Is this a copy of OpenLore's compiled Pi extension, from ANY version?
 *
 * Identified by provenance, not by behaviour: the bundle is `tsc` output that
 * still carries OpenLore's own intra-package relative imports (`../cli/…`,
 * `../core/…`). At `.pi/extensions/` those paths resolve to nothing, which is
 * exactly the breakage this migration repairs — and nothing a person would write
 * by hand in that directory. Requiring the extension's default-export name as
 * well keeps an unrelated misplaced build from matching.
 *
 * A user-authored extension that merely calls OpenLore's tools or reads
 * `.openlore/serve.json` matches neither condition and is never claimed.
 */
const COPIED_BUNDLE_IMPORT = /from ['"]\.\.\/(cli|core)\/[^'"]+\.js['"]/;

export function looksLikeCopiedPiBundle(content: string): boolean {
  return content.includes('export default function openlore(') && COPIED_BUNDLE_IMPORT.test(content);
}

/**
 * The header OpenLore shipped at the top of the pre-`.js` `openlore.ts`
 * extension (removed in eda09df4). An exact historical artifact string, so a
 * user's own `openlore.ts` is never mistaken for ours.
 */
const LEGACY_TS_HEADER = 'openlore.ts — Pi extension (pi.dev)';

/**
 * Is this file one OpenLore wrote? Older versions installed `openlore.ts`, whose
 * content no longer ships, so byte-equality is impossible — we require our own
 * shim marker, the exact header that `openlore.ts` carried, or the artifact
 * signatures in `looksLikeCopiedPiBundle`.
 *
 * Deliberately NOT "mentions OpenLore": a hand-written extension that calls
 * `openlore_orient` or reads `.openlore/serve.json` integrates with OpenLore, it
 * is not owned by it. Anything ambiguous is left in place with a warning.
 */
export function looksLikeOpenLoreExtension(content: string): boolean {
  return content.includes(MARKER) || content.includes(LEGACY_TS_HEADER) || looksLikeCopiedPiBundle(content);
}

export async function readPiSource(): Promise<string | null> {
  try {
    return await readFile(PI_EXTENSION_SOURCE, 'utf8');
  } catch {
    return null;
  }
}
