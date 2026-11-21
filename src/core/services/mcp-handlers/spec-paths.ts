/** Where this project's spec files are, from its configured `openspecPath`. */
import { relative } from 'node:path';
import { OPENSPEC_DIR } from '../../../constants.js';
import { readerOpenspecDir, resolveOpenspecDir } from '../../../utils/openspec-dir.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { indexedSpecContentProvenance } from '../served-content.js';

/**
 * The spec root this project actually uses, normalized.
 *
 * A repo that moved `openspec/` would otherwise have every spec resolved to a
 * path that does not exist — `get_spec` reporting not-found for files plainly on
 * disk, and `list_spec_domains` answering with an empty list.
 */
export async function configuredSpecRoot(
  absDir: string,
  options: {
    /**
     * For callers that only read: a configured path that stays in the project is used as
     * written, even when it is a folder symlinked from elsewhere in a monorepo
     * (`readerOpenspecDir`). Writers leave this off, or confine the write themselves.
     */
    readOnly?: boolean;
  } = {},
): Promise<{ absolute: string; relative: string }> {
  const configured = (await readOpenLoreConfig(absDir).catch(() => null))?.openspecPath ?? OPENSPEC_DIR;
  const absolute = options.readOnly ? readerOpenspecDir(absDir, configured) : resolveOpenspecDir(absDir, configured);
  const relativePath = relative(absDir, absolute).replaceAll('\\', '/');
  return { absolute, relative: relativePath || '.' };
}

/** `<spec root>/specs/<domain>/spec.md`, repository-relative, for a spec root from `configuredSpecRoot`. */
export function specFileRel(specRootRel: string, domain: string): string {
  return specRootPath(specRootRel, `specs/${domain}/spec.md`);
}

/** `<spec root>/<sub>`, repository-relative and POSIX-separated, for a spec root from `configuredSpecRoot`. */
export function specRootPath(specRootRel: string, sub: string): string {
  return specRootRel === '.' ? sub : `${specRootRel}/${sub}`;
}

/**
 * Whether a repository-relative, POSIX-separated path is inside the spec root `specRootRel`
 * (from `configuredSpecRoot`). A root of `.` holds its corpus in `specs/`, `changes/` and
 * `decisions/` beside the code, so only those folders count — not every file in the repository.
 */
export function isUnderSpecRoot(repoPath: string, specRootRel: string): boolean {
  if (specRootRel === '.') return /^(?:specs|changes|decisions)\//.test(repoPath);
  return repoPath.startsWith(`${specRootRel}/`);
}

/** The configured spec root, repository-relative, or null when it cannot be resolved. */
export async function specRootRelOrNull(absDir: string): Promise<string | null> {
  try {
    return (await configuredSpecRoot(absDir)).relative;
  } catch {
    return null;
  }
}

/**
 * The provenance of indexed spec text for `domain`. When the spec root could not be resolved the
 * text is still served, labeled local-unreviewed: the label is never upgraded on a guess.
 */
export async function indexedSpecProvenanceAt(
  absDir: string,
  specRootRel: string | null,
  domain: string,
  servedValues: readonly string[],
): Promise<'reviewed-corpus' | 'local-unreviewed'> {
  if (specRootRel === null) return 'local-unreviewed';
  return indexedSpecContentProvenance(absDir, specFileRel(specRootRel, domain), servedValues);
}
