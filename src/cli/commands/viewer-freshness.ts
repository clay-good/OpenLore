import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_FINGERPRINT } from '../../constants.js';
import { assessStalenessForAnalysis } from '../../core/services/mcp-handlers/confidence-boundary.js';
import { validateGitRef } from '../../core/drift/git-diff.js';
import { execFileGit as execFileAsync } from '../../utils/git-exec.js';


export interface ViewerFreshness {
  generatedAt: string;
  analyzedCommit: string | null;
  currentCommit: string | null;
  status: 'current' | 'stale' | 'unassessable';
  filesChangedSince: number | null;
}

export function buildViewerFreshness(input: {
  generatedAt: string;
  analyzedCommit: string | null;
  currentCommit: string | null;
  filesChangedSince: number | null;
  artifactPredatesAnalyzedCommit: boolean | null;
}): ViewerFreshness {
  const assessable = input.analyzedCommit !== null
    && input.currentCommit !== null
    && input.filesChangedSince !== null
    && input.artifactPredatesAnalyzedCommit !== null;
  return {
    generatedAt: input.generatedAt,
    analyzedCommit: input.analyzedCommit,
    currentCommit: input.currentCommit,
    filesChangedSince: input.filesChangedSince,
    status: !assessable
      ? 'unassessable'
      : input.filesChangedSince! > 0 || input.artifactPredatesAnalyzedCommit
        ? 'stale'
        : 'current',
  };
}

async function readCommitTime(rootPath: string, commit: string | null): Promise<number | null> {
  if (!commit) return null;
  try {
    validateGitRef(commit);
    const { stdout } = await execFileAsync('git', ['show', '-s', '--format=%cI', commit, '--'], { cwd: rootPath });
    const timestamp = Date.parse(stdout.trim());
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

export async function readViewerFreshness(
  rootPath: string,
  analysisDir: string,
  artifactPath: string,
): Promise<ViewerFreshness> {
  const fingerprint = await readFile(join(analysisDir, ARTIFACT_FINGERPRINT), 'utf8')
    .then((raw) => JSON.parse(raw) as { commit?: unknown })
    .catch((): { commit?: unknown } => ({}));
  const analyzedCommit = typeof fingerprint.commit === 'string' && fingerprint.commit.length > 0
    ? fingerprint.commit
    : null;
  const [artifactStats, staleness, currentCommit, analyzedCommitTime] = await Promise.all([
    stat(artifactPath),
    // Viewer requests are one-shot: never reuse an MCP burst-cache result that can
    // conceal a source edit until after the page has finished loading.
    assessStalenessForAnalysis(rootPath, analysisDir, Date.now(), false),
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootPath })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null),
    readCommitTime(rootPath, analyzedCommit),
  ]);

  return buildViewerFreshness({
    generatedAt: artifactStats.mtime.toISOString(),
    analyzedCommit,
    currentCommit,
    filesChangedSince: staleness.changedSourceFiles,
    artifactPredatesAnalyzedCommit: analyzedCommitTime === null
      ? null
      : artifactStats.mtimeMs < analyzedCommitTime,
  });
}

export function setViewerFreshnessHeaders(
  setHeader: (name: string, value: string) => void,
  freshness: ViewerFreshness,
): void {
  setHeader('X-OpenLore-Generated-At', freshness.generatedAt);
  setHeader('X-OpenLore-Analysis-Freshness', freshness.status);
  if (freshness.analyzedCommit) setHeader('X-OpenLore-Analyzed-Commit', freshness.analyzedCommit);
  if (freshness.currentCommit) setHeader('X-OpenLore-Current-Commit', freshness.currentCommit);
  if (freshness.filesChangedSince !== null) {
    setHeader('X-OpenLore-Files-Changed-Since', String(freshness.filesChangedSince));
  }
}
