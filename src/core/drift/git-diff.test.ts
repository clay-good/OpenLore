/**
 * Tests for git-diff module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyFile, isSkippableFile, validateGitRef,
  isGitRepository, isGitRepositoryRoot, getRepoPrefix, reframeRepoPath, getCurrentBranch, resolveBaseRef, refExists,
  resolveBaseRefDisclosed, getFileDiff, getChangedFiles } from './git-diff.js';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── git repo helpers ───────────────────────────────────────────────────────

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgSign', 'false'], { cwd: dir });
}

async function commit(dir: string, message = 'initial commit'): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', message], { cwd: dir });
}

// ============================================================================
// FILE CLASSIFICATION TESTS
// ============================================================================

describe('classifyFile', () => {
  describe('test file detection', () => {
    it('should detect .test.ts files', () => {
      const result = classifyFile('src/utils/helper.test.ts');
      expect(result.isTest).toBe(true);
    });

    it('should detect .spec.ts files', () => {
      const result = classifyFile('src/utils/helper.spec.ts');
      expect(result.isTest).toBe(true);
    });

    it('should detect files in test directories', () => {
      const result = classifyFile('tests/unit/helper.ts');
      expect(result.isTest).toBe(true);
    });

    it('should detect files in __tests__ directories', () => {
      const result = classifyFile('src/__tests__/helper.ts');
      expect(result.isTest).toBe(true);
    });

    it('should not flag regular source files as tests', () => {
      const result = classifyFile('src/core/service.ts');
      expect(result.isTest).toBe(false);
    });

    it('should detect _test suffix pattern', () => {
      const result = classifyFile('src/auth/login_test.go');
      expect(result.isTest).toBe(true);
    });
  });

  describe('config file detection', () => {
    it('should detect package.json', () => {
      const result = classifyFile('package.json');
      expect(result.isConfig).toBe(true);
    });

    it('should detect tsconfig.json', () => {
      const result = classifyFile('tsconfig.json');
      expect(result.isConfig).toBe(true);
    });

    it('should detect dotrc files', () => {
      const result = classifyFile('.eslintrc');
      expect(result.isConfig).toBe(true);
    });

    it('should detect config.ts files', () => {
      const result = classifyFile('src/config.ts');
      expect(result.isConfig).toBe(true);
    });

    it('should detect settings files', () => {
      const result = classifyFile('src/settings.json');
      expect(result.isConfig).toBe(true);
    });

    it('should not flag regular source files as config', () => {
      const result = classifyFile('src/core/service.ts');
      expect(result.isConfig).toBe(false);
    });
  });

  describe('generated file detection', () => {
    it('should detect .d.ts files', () => {
      const result = classifyFile('src/types/index.d.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should detect .generated.ts files', () => {
      const result = classifyFile('src/api/client.generated.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should detect files in /generated/ directories', () => {
      const result = classifyFile('src/generated/schema.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should detect files in /__generated__/ directories', () => {
      const result = classifyFile('src/__generated__/types.ts');
      expect(result.isGenerated).toBe(true);
    });

    it('should not flag regular source files as generated', () => {
      const result = classifyFile('src/core/service.ts');
      expect(result.isGenerated).toBe(false);
    });
  });

  describe('extension extraction', () => {
    it('should extract .ts extension', () => {
      const result = classifyFile('src/index.ts');
      expect(result.extension).toBe('.ts');
    });

    it('should extract .js extension', () => {
      const result = classifyFile('src/index.js');
      expect(result.extension).toBe('.js');
    });

    it('should extract .py extension', () => {
      const result = classifyFile('src/main.py');
      expect(result.extension).toBe('.py');
    });

    it('should handle files with multiple dots', () => {
      const result = classifyFile('src/helper.test.ts');
      expect(result.extension).toBe('.ts');
    });
  });
});

// ============================================================================
// SKIPPABLE FILE TESTS
// ============================================================================

describe('isSkippableFile', () => {
  it('should skip lock files', () => {
    expect(isSkippableFile('package-lock.json')).toBe(true);
    expect(isSkippableFile('yarn.lock')).toBe(true);
    expect(isSkippableFile('pnpm-lock.yaml')).toBe(true);
  });

  it('should skip image files', () => {
    expect(isSkippableFile('logo.png')).toBe(true);
    expect(isSkippableFile('banner.jpg')).toBe(true);
    expect(isSkippableFile('icon.svg')).toBe(true);
  });

  it('should skip font files', () => {
    expect(isSkippableFile('font.woff')).toBe(true);
    expect(isSkippableFile('font.woff2')).toBe(true);
    expect(isSkippableFile('font.ttf')).toBe(true);
  });

  it('should skip compiled files', () => {
    expect(isSkippableFile('module.pyc')).toBe(true);
    expect(isSkippableFile('lib.so')).toBe(true);
    expect(isSkippableFile('app.exe')).toBe(true);
  });

  it('should skip source maps', () => {
    expect(isSkippableFile('bundle.js.map')).toBe(true);
  });

  it('should skip .DS_Store', () => {
    expect(isSkippableFile('.DS_Store')).toBe(true);
  });

  it('should not skip source files', () => {
    expect(isSkippableFile('src/index.ts')).toBe(false);
    expect(isSkippableFile('src/main.py')).toBe(false);
    expect(isSkippableFile('README.md')).toBe(false);
  });
});

// ============================================================================
// validateGitRef
// ============================================================================

describe('validateGitRef', () => {
  it('accepts simple branch names', () => {
    expect(() => validateGitRef('main')).not.toThrow();
    expect(() => validateGitRef('feature/my-branch')).not.toThrow();
    expect(() => validateGitRef('release-1.0')).not.toThrow();
  });

  it('accepts SHA hashes', () => {
    expect(() => validateGitRef('abc1234def5678')).not.toThrow();
    expect(() => validateGitRef('4b825dc642cb6eb9a060e54bf899d15f71049056')).not.toThrow();
  });

  it('accepts relative refs', () => {
    expect(() => validateGitRef('HEAD~1')).not.toThrow();
    expect(() => validateGitRef('HEAD^')).not.toThrow();
    expect(() => validateGitRef('@{upstream}')).not.toThrow();
  });

  it('accepts "auto" without validation', () => {
    expect(() => validateGitRef('auto')).not.toThrow();
  });

  it('accepts the empty-tree SHA', () => {
    expect(() => validateGitRef('4b825dc642cb6eb9a060e54bf899d15f71049056')).not.toThrow();
  });

  it('rejects refs with semicolons', () => {
    expect(() => validateGitRef('main; rm -rf /')).toThrow('Invalid git ref');
  });

  it('rejects refs with spaces', () => {
    expect(() => validateGitRef('main branch')).toThrow('Invalid git ref');
  });

  it('rejects refs with backticks', () => {
    expect(() => validateGitRef('`whoami`')).toThrow('Invalid git ref');
  });

  it('rejects refs with dollar signs', () => {
    expect(() => validateGitRef('$HOME')).toThrow('Invalid git ref');
  });

  it('rejects refs with newlines', () => {
    expect(() => validateGitRef('main\necho')).toThrow('Invalid git ref');
  });

  it('rejects empty string', () => {
    // empty string doesn't match \w+ so it should throw
    expect(() => validateGitRef('')).toThrow('Invalid git ref');
  });
});

// ============================================================================
// isGitRepository
// ============================================================================

describe('isGitRepository', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-git-'));
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns false for a plain directory', async () => {
    expect(await isGitRepository(tmpDir)).toBe(false);
  });

  it('returns true for a git repository', async () => {
    await initRepo(tmpDir);
    expect(await isGitRepository(tmpDir)).toBe(true);
  });

  // fix-git-derived-signal-honesty: work-tree-aware detection. The old access(.git)
  // test recognized only the repo ROOT, silently emptying every git-derived signal
  // for a monorepo package directory.
  it('returns true for a subdirectory of a repository (monorepo package)', async () => {
    await initRepo(tmpDir);
    const pkg = join(tmpDir, 'packages', 'foo');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'x.ts'), 'export const x = 1;');
    await commit(tmpDir);
    expect(await isGitRepository(pkg)).toBe(true);
  });

  it('returns false inside the .git directory (not a work tree)', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'export const a = 1;');
    await commit(tmpDir);
    // .git exists after init but is not itself a work tree.
    expect(await isGitRepository(join(tmpDir, '.git'))).toBe(false);
  });

  it('returns true for a linked worktree (where .git is a file)', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'export const a = 1;');
    await commit(tmpDir);
    const wt = await mkdtemp(join(tmpdir(), 'openlore-worktree-'));
    await rm(wt, { recursive: true, force: true }); // git worktree add wants a non-existent path
    await execFileAsync('git', ['worktree', 'add', wt], { cwd: tmpDir });
    try {
      expect(await isGitRepository(wt)).toBe(true);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', wt], { cwd: tmpDir }).catch(() => {});
      await rm(wt, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// getRepoPrefix / reframeRepoPath (below-root path re-framing)
// ============================================================================

describe('getRepoPrefix', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'openlore-prefix-')); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('is empty at the repository root', async () => {
    await initRepo(tmpDir);
    expect(await getRepoPrefix(tmpDir)).toBe('');
  });

  it('is the trailing-slash path from the repo root for a subdirectory', async () => {
    await initRepo(tmpDir);
    const pkg = join(tmpDir, 'packages', 'foo');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'x.ts'), 'export const x = 1;');
    await commit(tmpDir);
    expect(await getRepoPrefix(pkg)).toBe('packages/foo/');
  });

  it('is null outside any repository', async () => {
    expect(await getRepoPrefix(tmpDir)).toBeNull();
  });
});

describe('isGitRepositoryRoot', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'openlore-reporoot-')); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  // Root-only gate for path-frame-sensitive callers (drift, decisions, staleness):
  // behaviorally identical to the old access(.git) test — true only AT the repo root.
  it('is true at the repository root', async () => {
    await initRepo(tmpDir);
    expect(await isGitRepositoryRoot(tmpDir)).toBe(true);
  });

  it('is false in a subdirectory (unlike isGitRepository, which is true there)', async () => {
    await initRepo(tmpDir);
    const pkg = join(tmpDir, 'packages', 'foo');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'x.ts'), 'export const x = 1;');
    await commit(tmpDir);
    expect(await isGitRepository(pkg)).toBe(true);      // work-tree-aware
    expect(await isGitRepositoryRoot(pkg)).toBe(false); // but not the root
  });

  it('is false outside any repository', async () => {
    expect(await isGitRepositoryRoot(tmpDir)).toBe(false);
  });

  it('is true at a linked worktree root (.git is a file)', async () => {
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'export const a = 1;');
    await commit(tmpDir);
    const wt = await mkdtemp(join(tmpdir(), 'openlore-reporoot-wt-'));
    await rm(wt, { recursive: true, force: true });
    await execFileAsync('git', ['worktree', 'add', wt], { cwd: tmpDir });
    try {
      expect(await isGitRepositoryRoot(wt)).toBe(true);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', wt], { cwd: tmpDir }).catch(() => {});
      await rm(wt, { recursive: true, force: true });
    }
  });
});

describe('reframeRepoPath', () => {
  it('is the identity at the repository root (empty prefix)', () => {
    expect(reframeRepoPath('src/x.ts', '')).toBe('src/x.ts');
  });

  it('strips the prefix for a path inside the analyzed subtree', () => {
    expect(reframeRepoPath('packages/foo/src/x.ts', 'packages/foo/')).toBe('src/x.ts');
  });

  it('returns null for a path outside the analyzed subtree', () => {
    expect(reframeRepoPath('packages/bar/src/y.ts', 'packages/foo/')).toBeNull();
  });

  it('returns null for the analyzed directory itself (no file component)', () => {
    expect(reframeRepoPath('packages/foo', 'packages/foo/')).toBeNull();
  });
});

// ============================================================================
// getCurrentBranch
// ============================================================================

describe('getCurrentBranch', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-branch-'));
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'const x = 1;', 'utf-8');
    await commit(tmpDir);
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns the current branch name', async () => {
    const branch = await getCurrentBranch(tmpDir);
    expect(branch).toBe('main');
  });

  it('returns "unknown" for a non-git path', async () => {
    const notGit = await mkdtemp(join(tmpdir(), 'not-git-'));
    const branch = await getCurrentBranch(notGit);
    expect(branch).toBe('unknown');
    await rm(notGit, { recursive: true, force: true });
  });
});

// ============================================================================
// resolveBaseRef
// ============================================================================

describe('resolveBaseRef', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-ref-'));
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'v1', 'utf-8');
    await commit(tmpDir, 'initial');
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('resolves explicit valid ref', async () => {
    // HEAD is always valid
    const ref = await resolveBaseRef(tmpDir, 'HEAD');
    expect(ref).toBe('HEAD');
  });

  it('falls back to "main" when preferredRef is "auto"', async () => {
    const ref = await resolveBaseRef(tmpDir, 'auto');
    expect(ref).toBe('main');
  });

  it('falls back to empty-tree SHA on single-commit repo with no main/master', async () => {
    // Rename default branch away from main/master so all fallbacks fail
    await execFileAsync('git', ['branch', '-m', 'main', 'feature'], { cwd: tmpDir });
    const ref = await resolveBaseRef(tmpDir, 'auto');
    // Should resolve to HEAD~1 fallback or empty-tree SHA (single commit → empty tree)
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);
  });

  it('falls back to "master" when "main" does not exist', async () => {
    await execFileAsync('git', ['branch', '-m', 'main', 'master'], { cwd: tmpDir });
    const ref = await resolveBaseRef(tmpDir, 'auto');
    expect(ref).toBe('master');
  });
});

describe('refExists', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-refexists-'));
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'v1', 'utf-8');
    await commit(tmpDir, 'initial');
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns true for a resolvable ref (HEAD)', async () => {
    expect(await refExists(tmpDir, 'HEAD')).toBe(true);
  });

  it('returns false for a ref that does not exist (no silent fallback)', async () => {
    expect(await refExists(tmpDir, 'totally-bogus-ref-xyz')).toBe(false);
  });

  it('returns false (never throws) for an injection-shaped ref', async () => {
    expect(await refExists(tmpDir, '--upload-pack=evil')).toBe(false);
  });

  it('returns false for a non-git directory rather than throwing', async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), 'openlore-norepo-'));
    try {
      expect(await refExists(nonRepo, 'HEAD')).toBe(false);
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// resolveBaseRefDisclosed — the shared resolve-or-disclose helper every --base
// command routes through (fix-cli-conclusion-honesty). This is the ONE home of
// the fallback-detection logic; the commands only surface/act on its verdict.
// ============================================================================

describe('resolveBaseRefDisclosed', () => {
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d15f71049056';
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-disclosed-'));
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'v1', 'utf-8');
    await commit(tmpDir, 'initial');
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('an explicit ref that resolves is NOT a fallback', async () => {
    const r = await resolveBaseRefDisclosed(tmpDir, 'HEAD');
    expect(r).toEqual({ requested: 'HEAD', resolved: 'HEAD', fellBack: false });
  });

  it('an explicit ref that does NOT resolve falls back and discloses both refs', async () => {
    const r = await resolveBaseRefDisclosed(tmpDir, 'totally-bogus-ref-xyz');
    expect(r.requested).toBe('totally-bogus-ref-xyz');
    expect(r.resolved).toBe('main'); // main → master → HEAD~1 fallback
    expect(r.fellBack).toBe(true);
  });

  it('the "auto" default explicitly requests the fallback chain and is never a fallback', async () => {
    const r = await resolveBaseRefDisclosed(tmpDir, 'auto');
    expect(r.resolved).toBe('main');
    expect(r.fellBack).toBe(false);
  });

  it('prefers a remote-only default branch over the local HEAD parent', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'v2', 'utf-8');
    await commit(tmpDir, 'feature work');
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD~1'], { cwd: tmpDir });
    await execFileAsync('git', ['branch', '-m', 'feature'], { cwd: tmpDir });

    const r = await resolveBaseRefDisclosed(tmpDir, 'auto');
    expect(r).toEqual({ requested: 'auto', resolved: 'origin/main', fellBack: false });
  });

  it('an empty request is treated as auto (no fallback flag)', async () => {
    const r = await resolveBaseRefDisclosed(tmpDir, '');
    expect(r.fellBack).toBe(false);
  });

  it('does NOT false-flag a usable base that resolves to itself but is not a commit (empty-tree SHA)', async () => {
    // resolveBaseRef returns the empty-tree SHA verbatim (it is a valid diff base), so the
    // helper must NOT call it a fallback even though refExists (which peels ^{commit}) is false.
    const r = await resolveBaseRefDisclosed(tmpDir, EMPTY_TREE);
    expect(r.resolved).toBe(EMPTY_TREE);
    expect(r.fellBack).toBe(false);
  });
});

// ============================================================================
// getFileDiff
// ============================================================================

describe('getFileDiff', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-diff-'));
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'service.ts'), 'export const v = 1;', 'utf-8');
    await commit(tmpDir, 'initial');
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns empty string when file has no diff vs HEAD', async () => {
    const diff = await getFileDiff(tmpDir, 'service.ts', 'HEAD');
    expect(diff).toBe('');
  });

  it('returns diff content when file changed after a commit', async () => {
    // Second commit with a change
    await writeFile(join(tmpDir, 'service.ts'), 'export const v = 2;', 'utf-8');
    await commit(tmpDir, 'update v');
    const diff = await getFileDiff(tmpDir, 'service.ts', 'HEAD~1');
    expect(diff).toContain('service.ts');
  });

  it('truncates diff when it exceeds maxChars', async () => {
    await writeFile(join(tmpDir, 'service.ts'), 'export const v = 2;', 'utf-8');
    await commit(tmpDir, 'update v');
    const diff = await getFileDiff(tmpDir, 'service.ts', 'HEAD~1', 10);
    expect(diff).toContain('(truncated)');
  });

  it('returns empty string for a non-existent file', async () => {
    const diff = await getFileDiff(tmpDir, 'nonexistent.ts', 'HEAD~1');
    expect(diff).toBe('');
  });
});

// ============================================================================
// getChangedFiles
// ============================================================================

describe('getChangedFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-changed-'));
    await initRepo(tmpDir);
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 1;', 'utf-8');
    await commit(tmpDir, 'initial');
  });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('returns empty file list when nothing changed since base', async () => {
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD', includeUnstaged: false });
    expect(result.files).toHaveLength(0);
    expect(result.currentBranch).toBe('main');
  });

  it('detects a modified file', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 2;', 'utf-8');
    await commit(tmpDir, 'modify a');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD~1', includeUnstaged: false });
    expect(result.files.some(f => f.path === 'a.ts')).toBe(true);
    expect(result.files.find(f => f.path === 'a.ts')?.status).toBe('modified');
  });

  it('detects an added file', async () => {
    await writeFile(join(tmpDir, 'b.ts'), 'const b = 1;', 'utf-8');
    await commit(tmpDir, 'add b');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD~1', includeUnstaged: false });
    expect(result.files.some(f => f.path === 'b.ts')).toBe(true);
    expect(result.files.find(f => f.path === 'b.ts')?.status).toBe('added');
  });

  it('skips binary and lock files', async () => {
    await writeFile(join(tmpDir, 'package-lock.json'), '{}', 'utf-8');
    await writeFile(join(tmpDir, 'logo.png'), 'fake', 'utf-8');
    await commit(tmpDir, 'add skippable');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD~1', includeUnstaged: false });
    expect(result.files.every(f => f.path !== 'package-lock.json')).toBe(true);
    expect(result.files.every(f => f.path !== 'logo.png')).toBe(true);
  });

  it('applies path filter', async () => {
    await writeFile(join(tmpDir, 'b.ts'), 'x', 'utf-8');
    await writeFile(join(tmpDir, 'c.ts'), 'y', 'utf-8');
    await commit(tmpDir, 'add b and c');
    const result = await getChangedFiles({
      rootPath: tmpDir, baseRef: 'HEAD~1', includeUnstaged: false, pathFilter: ['b.ts'],
    });
    expect(result.files.every(f => f.path === 'b.ts')).toBe(true);
  });

  it('populates additions and deletions counts', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 2;\nconst b = 3;', 'utf-8');
    await commit(tmpDir, 'update a');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD~1', includeUnstaged: false });
    const file = result.files.find(f => f.path === 'a.ts');
    expect(file).toBeDefined();
    expect(typeof file?.additions).toBe('number');
    expect(typeof file?.deletions).toBe('number');
  });

  it('detects unstaged changes when includeUnstaged=true', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'unstaged change', 'utf-8');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD', includeUnstaged: true });
    expect(result.hasUnstagedChanges).toBe(true);
    expect(result.files.some(f => f.path === 'a.ts')).toBe(true);
  });

  it('classifies test files correctly in changed list', async () => {
    await writeFile(join(tmpDir, 'a.test.ts'), 'test content', 'utf-8');
    await commit(tmpDir, 'add test');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD~1', includeUnstaged: false });
    const testFile = result.files.find(f => f.path === 'a.test.ts');
    expect(testFile?.isTest).toBe(true);
  });

  // Regression: uncommitted (staged/working-tree) changes must carry real line
  // counts — before the fix they always fell through to +0/-0, so gap severity
  // could never cross the pre-commit hook's threshold (drift-gate blindness).
  it('carries real line counts for a staged-only change (not +0/-0)', async () => {
    const big = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';
    await writeFile(join(tmpDir, 'a.ts'), big, 'utf-8');
    await execFileAsync('git', ['add', 'a.ts'], { cwd: tmpDir });
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD', includeUnstaged: true });
    const file = result.files.find(f => f.path === 'a.ts');
    expect(file).toBeDefined();
    expect(file!.additions).toBeGreaterThan(30);
  });

  it('carries real line counts for a working-tree-only change (not +0/-0)', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf-8');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD', includeUnstaged: true });
    const file = result.files.find(f => f.path === 'a.ts');
    expect(file).toBeDefined();
    expect(file!.additions).toBeGreaterThan(0);
  });

  it('merges (sums) counts for a file both staged and modified in the working tree', async () => {
    // Stage two added lines, then add two more unstaged lines to the same file.
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf-8');
    await execFileAsync('git', ['add', 'a.ts'], { cwd: tmpDir });
    await writeFile(join(tmpDir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n', 'utf-8');
    const result = await getChangedFiles({ rootPath: tmpDir, baseRef: 'HEAD', includeUnstaged: true });
    const file = result.files.find(f => f.path === 'a.ts');
    expect(file).toBeDefined();
    // staged diff (2 added) + working-tree diff (2 added) merged; never zero.
    expect(file!.additions).toBeGreaterThanOrEqual(4);
  });
});
