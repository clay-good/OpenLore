import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { gitPathArgs } from '../utils/git-args.js';
import { execFileGitSync } from '../utils/git-exec.js';

export interface PreregisteredRule {
  path: string;
  sha256: string;
  commit: string;
}

export function readPreregisteredRule(root: string, path: string): PreregisteredRule {
  const absolute = resolve(root, path);
  const repositoryPath = relative(root, absolute);
  execFileGitSync('git', gitPathArgs('ls-files', '--error-unmatch', repositoryPath), { cwd: root, stdio: 'ignore' });
  try {
    execFileGitSync('git', ['diff', '--quiet', 'HEAD', '--', repositoryPath], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error(`Decision rule must be committed and unchanged before the run: ${repositoryPath}`);
  }
  const commit = execFileGitSync('git', ['log', '-1', '--format=%H', '--', repositoryPath], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!commit) throw new Error(`Decision rule has no pre-run commit: ${repositoryPath}`);
  const committedBytes = execFileGitSync('git', ['show', `HEAD:${repositoryPath}`], {
    cwd: root,
    encoding: 'buffer',
  });
  return {
    path: repositoryPath,
    sha256: createHash('sha256').update(committedBytes).digest('hex'),
    commit,
  };
}
