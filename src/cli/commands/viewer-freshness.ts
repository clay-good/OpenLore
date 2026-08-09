import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ARTIFACT_FINGERPRINT } from '../../constants.js';
import { assessStalenessForAnalysis } from '../../core/services/mcp-handlers/confidence-boundary.js';

const execFileAsync = promisify(execFile);

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
}): ViewerFreshness {
  const assessable = input.analyzedCommit !== null
    && input.currentCommit !== null
    && input.filesChangedSince !== null;
  return {
    ...input,
    status: !assessable
      ? 'unassessable'
      : input.filesChangedSince !== null && input.filesChangedSince > 0
        ? 'stale'
        : 'current',
  };
}

export async function readViewerFreshness(
  rootPath: string,
  analysisDir: string,
  artifactPath: string,
): Promise<ViewerFreshness> {
  const [artifactStats, fingerprint, staleness, currentCommit] = await Promise.all([
    stat(artifactPath),
    readFile(join(analysisDir, ARTIFACT_FINGERPRINT), 'utf8')
      .then((raw) => JSON.parse(raw) as { commit?: unknown })
      .catch((): { commit?: unknown } => ({})),
    assessStalenessForAnalysis(rootPath, analysisDir),
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootPath })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null),
  ]);

  const analyzedCommit = typeof fingerprint.commit === 'string' && fingerprint.commit.length > 0
    ? fingerprint.commit
    : null;
  return buildViewerFreshness({
    generatedAt: artifactStats.mtime.toISOString(),
    analyzedCommit,
    currentCommit,
    filesChangedSince: staleness.changedSourceFiles,
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
