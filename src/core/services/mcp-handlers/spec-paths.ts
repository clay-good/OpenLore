/** Where this project's spec files are, from its configured `openspecPath`. */
import { relative } from 'node:path';
import { OPENSPEC_DIR } from '../../../constants.js';
import { resolveOpenspecDir } from '../../../utils/openspec-dir.js';
import { readOpenLoreConfig } from '../config-manager.js';

/**
 * The spec root this project actually uses, normalized.
 *
 * A repo that moved `openspec/` would otherwise have every spec resolved to a
 * path that does not exist — `get_spec` reporting not-found for files plainly on
 * disk, and `list_spec_domains` answering with an empty list.
 */
export async function configuredSpecRoot(absDir: string): Promise<{ absolute: string; relative: string }> {
  const configured = (await readOpenLoreConfig(absDir).catch(() => null))?.openspecPath ?? OPENSPEC_DIR;
  const absolute = resolveOpenspecDir(absDir, configured);
  const relativePath = relative(absDir, absolute).replaceAll('\\', '/');
  return { absolute, relative: relativePath || '.' };
}

/** `<spec root>/specs/<domain>/spec.md`, repository-relative, for a spec root from `configuredSpecRoot`. */
export function specFileRel(specRootRel: string, domain: string): string {
  return `${specRootRel === '.' ? '' : `${specRootRel}/`}specs/${domain}/spec.md`;
}
