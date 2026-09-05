import { execFileGit as execFileAsync } from '../../utils/git-exec.js';


export type SourceTreeState = 'clean' | 'dirty' | 'unknown';

/**
 * Capture the git identity of the source state an analysis is about to publish.
 * Failure is represented as `unknown`, never guessed as clean.
 */
export async function captureSourceState(
  rootPath: string,
): Promise<{ commit: string | null; treeState: SourceTreeState }> {
  try {
    // Keep these ordered: a concurrent ref update must not pair a status result captured
    // before the update with a commit captured after it. Analysis brackets its work with two
    // of these snapshots and only calls the result clean when both endpoints agree.
    const { stdout: commitOut } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: rootPath });
    const { stdout: statusOut } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: rootPath },
    );
    const { stdout: commitAfterOut } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: rootPath });
    const commit = commitOut.trim();
    const commitAfter = commitAfterOut.trim();
    if (!commit || commit !== commitAfter) return { commit: commitAfter || null, treeState: 'unknown' };
    return {
      commit: commit.length > 0 ? commit : null,
      treeState: statusOut.length === 0 ? 'clean' : 'dirty',
    };
  } catch {
    return { commit: null, treeState: 'unknown' };
  }
}

/** Conservatively bind a published analysis to matching source-state endpoints. */
export function reconcileSourceStates(
  before: { commit: string | null; treeState: SourceTreeState },
  after: { commit: string | null; treeState: SourceTreeState },
): { commit: string | null; treeState: SourceTreeState } {
  if (!before.commit || !after.commit || before.commit !== after.commit) {
    return { commit: after.commit, treeState: 'unknown' };
  }
  return {
    commit: after.commit,
    treeState: before.treeState === 'clean' && after.treeState === 'clean' ? 'clean' : 'dirty',
  };
}
