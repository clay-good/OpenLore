import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { gitPathArgs } from '../utils/git-args.js';

export interface PreregisteredRule {
  path: string;
  sha256: string;
  commit: string;
}

export function readPreregisteredRule(root: string, path: string): PreregisteredRule {
  const absolute = resolve(root, path);
  const repositoryPath = relative(root, absolute);
  execFileSync('git', gitPathArgs('ls-files', '--error-unmatch', repositoryPath), { cwd: root, stdio: 'ignore' });
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', repositoryPath], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error(`Decision rule must be committed and unchanged before the run: ${repositoryPath}`);
  }
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', repositoryPath], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!commit) throw new Error(`Decision rule has no pre-run commit: ${repositoryPath}`);
  const committedBytes = execFileSync('git', ['show', `HEAD:${repositoryPath}`], {
    cwd: root,
    encoding: 'buffer',
  });
  return {
    path: repositoryPath,
    sha256: createHash('sha256').update(committedBytes).digest('hex'),
    commit,
  };
}
