/**
 * What the repository is allowed to track (change: fix-untrack-node-modules).
 *
 * A `node_modules` SYMLINK — how a developer shares one install across git worktrees — was
 * committed to `main`, because `.gitignore` said `node_modules/` and a trailing slash matches
 * only a directory. The blob held an absolute path on the author's machine, and any clone that
 * ran `npm ci` had the directory that path pointed at EMPTIED first
 * ("npm warn reify Removing non-directory …"). On the author's own machine that is the live
 * repository's own `node_modules`.
 *
 * Two guards, because the single fix would not have caught the next variant:
 *   1. no tracked symlink leaves the repository, and
 *   2. the ignore rules actually cover a symlink named like a dependency directory.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** `git ls-files -s` mode for a symbolic link. */
const SYMLINK_MODE = '120000';

/** Paths whose own content is a path: `<mode> <sha> <stage>\t<path>`. */
function trackedSymlinks(): Array<{ path: string; target: string }> {
  const rows = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .filter(row => row.startsWith(`${SYMLINK_MODE} `));
  return rows.map(row => {
    const path = row.slice(row.indexOf('\t') + 1);
    const sha = row.split(/\s+/)[1];
    const target = execFileSync('git', ['cat-file', '-p', sha], { encoding: 'utf8' });
    return { path, target };
  });
}

describe('repository tracking integrity', () => {
  it('tracks no symlink that points outside the repository', () => {
    const escaping = trackedSymlinks().filter(
      link => link.target.startsWith('/') || link.target.startsWith('~') || link.target.includes('..'),
    );
    expect(
      escaping.map(l => `${l.path} -> ${l.target}`),
      'a tracked symlink to an absolute or parent path is machine-specific, and npm ci empties its target',
    ).toEqual([]);
  });

  it('tracks no dependency directory, by any file type', () => {
    const tracked = execFileSync('git', ['ls-files', 'node_modules'], { encoding: 'utf8' }).trim();
    expect(tracked, 'node_modules must never be tracked').toBe('');
  });

  it('ignores a path named node_modules whatever its file type', () => {
    // `check-ignore --no-index` answers for the PATTERN, not for what happens to be on disk,
    // so this holds in a clean checkout and in a worktree that has a symlink there.
    const ignored = execFileSync(
      'git', ['check-ignore', '--no-index', '-v', 'node_modules'],
      { encoding: 'utf8' },
    ).trim();
    expect(ignored, 'the ignore rule must match a symlink too, so a trailing slash is wrong').toMatch(/:\d+:node_modules\s/);
    expect(ignored, 'a trailing slash restricts the match to a directory').not.toMatch(/:\d+:node_modules\/\s/);
  });
});
