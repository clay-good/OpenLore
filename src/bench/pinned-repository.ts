import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileGitSync } from '../utils/git-exec.js';

export interface RepositoryPin {
  id: string;
  sha: string;
}

export function verifyPinnedRepository(repo: RepositoryPin, directory: string): void {
  if (!existsSync(join(directory, '.git'))) throw new Error(`Pinned benchmark repository is missing: ${repo.id}`);
  const head = execFileGitSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  if (head !== repo.sha) throw new Error(`Pinned benchmark repository SHA mismatch for ${repo.id}: ${head}`);
  const status = execFileGitSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
  if (status) throw new Error(`Pinned benchmark repository has tracked modifications: ${repo.id}`);
}

export function analysisMarkerPath(directory: string): string {
  return join(directory, '.openlore', 'analysis', 'bench-source-sha');
}

export function assertPinnedAnalysis(repo: RepositoryPin, directory: string): void {
  const marker = analysisMarkerPath(directory);
  const analyzedSha = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
  if (analyzedSha !== repo.sha) {
    throw new Error(`Benchmark analysis is absent or stale for ${repo.id}; rerun without --skip-setup.`);
  }
}

export function markPinnedAnalysis(repo: RepositoryPin, directory: string): void {
  const marker = analysisMarkerPath(directory);
  mkdirSync(dirname(marker), { recursive: true });
  const candidate = `${marker}.${process.pid}.${randomUUID()}`;
  const fd = openSync(candidate, 'wx', 0o600);
  try {
    writeFileSync(fd, `${repo.sha}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  renameSync(candidate, marker);
}
