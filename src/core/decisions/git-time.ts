/**
 * Bitemporal git access for memory validity (add-bitemporal-typed-memory-operations).
 *
 * Memory carries a deterministic valid-time marker — the `HEAD` commit SHA at record
 * time — and `asOf` / `changedSince` recall compare a memory's commit against a
 * caller-supplied commit-ish using git ancestry. Everything here is read-only and
 * deterministic: the same repository state yields the same answer, with no LLM and no
 * wall-clock dependence. Reuses the project's existing git subprocess access and the
 * argument-injection guard (`validateGitRef`); adds no new git surface.
 */

import { logger } from '../../utils/logger.js';
import { validateGitRef } from '../drift/git-diff.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';


/**
 * The current `HEAD` commit SHA, or `undefined` when not a git repo / no commits yet
 * (a fresh repo). Never throws — an unanchorable record simply omits `validFromCommit`.
 */
export async function getHeadCommit(rootPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootPath });
    const sha = stdout.trim();
    return sha.length ? sha : undefined;
  } catch (err) {
    logger.debug(`getHeadCommit: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Resolve a caller-supplied commit-ish (branch, tag, SHA, HEAD~1, …) to a full commit
 * SHA, or `undefined` when it does not resolve. Validated against the same
 * argument-injection guard used elsewhere; the ref operand is placed after `--`.
 */
export async function resolveCommitSha(rootPath: string, ref: string): Promise<string | undefined> {
  try {
    validateGitRef(ref);
  } catch (err) {
    logger.debug(`resolveCommitSha: invalid ref ${(err as Error).message}`);
    return undefined;
  }
  try {
    // `<ref>^{commit}` forces resolution to a commit object (deref tags, reject trees).
    const { stdout } = await execFileAsync(
      'git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
      { cwd: rootPath },
    );
    const sha = stdout.trim();
    return sha.length ? sha : undefined;
  } catch (err) {
    logger.debug(`resolveCommitSha: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * True when `ancestor` is an ancestor of (or equal to) `descendant`. Both MUST already
 * be resolved SHAs (callers resolve commit-ish first). Returns false on any git error
 * (e.g. an unknown commit from rewritten history) so a non-comparable memory is excluded
 * rather than silently treated as in-range.
 */
export async function isAncestor(
  rootPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  try {
    await execFileAsync(
      'git', ['merge-base', '--is-ancestor', ancestor, descendant],
      { cwd: rootPath },
    );
    return true; // exit 0 ⇒ is an ancestor
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) return false; // exit 1 ⇒ not an ancestor (expected, not an error)
    logger.debug(`isAncestor: ${(err as Error).message}`);
    return false;
  }
}
