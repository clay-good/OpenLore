import { basename, dirname, resolve } from 'node:path';
import { existsSync, lstatSync } from 'node:fs';

export function resolveBenchmarkResultPath(repositoryRoot: string, requested: string): string {
  const resultsDirectory = resolve(repositoryRoot, 'bench', 'results');
  if (existsSync(resultsDirectory) && lstatSync(resultsDirectory).isSymbolicLink()) {
    throw new Error('Live runs require a real bench/results directory, not a symbolic link.');
  }
  const resolved = resolve(repositoryRoot, requested);
  if (
    dirname(resolved) !== resultsDirectory ||
    basename(requested) !== requested.slice('bench/results/'.length) ||
    !requested.endsWith('.json')
  ) {
    throw new Error('Live runs require --out bench/results/<name>.json.');
  }
  return resolved;
}
