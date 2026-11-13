/**
 * Regression coverage for Git ignore pruning before watcher FDs are opened.
 * The matcher and directory traversal are real; only chokidar's event source is
 * mocked here. The real watcher is covered in mcp-watcher.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chokidar from 'chokidar';
import { isGitignoredPath, loadGitignoreScopes, McpWatcher } from './mcp-watcher.js';

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const watcher = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'ready') handler();
          return watcher;
        }),
        close: vi.fn(async () => {}),
      };
      return watcher;
    }),
  },
}));

describe('watcher Git ignore pruning', () => {
  let root: string;
  let watcher: McpWatcher | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'openlore-watch-gitignore-'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps the chokidar root probe watchable when a root .gitignore exists', async () => {
    await writeFile(join(root, '.gitignore'), 'cargo-cache/\n');
    watcher = new McpWatcher({ rootPath: root, embed: false });
    await expect(watcher.start()).resolves.not.toThrow();

    const [watchRoot, options] = vi.mocked(chokidar.watch).mock.calls[0];
    if (typeof watchRoot !== 'string' || typeof options?.ignored !== 'function') {
      throw new Error('Expected the source watcher and its ignored callback');
    }
    // Chokidar calls both forms. The first reproduced "path must not be empty"
    // on Linux, Node 22, and Windows before the watcher could become ready.
    expect(options.ignored(watchRoot)).toBe(false);
    expect(options.ignored(watchRoot, await stat(watchRoot))).toBe(false);
    expect(options.ignored(join(watchRoot, 'main.rs'))).toBe(false);
  });

  it('does not pass dot or parent-relative candidates to the ignore package', async () => {
    await writeFile(join(root, '.gitignore'), '*.rs\n');
    const scopes = await loadGitignoreScopes(root);
    for (const candidate of ['', '.', '..', '../other.rs']) {
      expect(isGitignoredPath(candidate, scopes)).toBe(false);
    }
  });

  it('keeps directory-only patterns distinct from regular-file patterns', async () => {
    await writeFile(join(root, '.gitignore'), 'cargo-cache/\n');
    const scopes = await loadGitignoreScopes(root);
    expect(isGitignoredPath('cargo-cache', scopes)).toBe(false);
    expect(isGitignoredPath('cargo-cache', scopes, true)).toBe(true);
    expect(isGitignoredPath(join('cargo-cache', 'generated.rs'), scopes)).toBe(true);
  });

  it('lets a nested negation re-include a file ignored by an ancestor scope', async () => {
    await writeFile(join(root, '.gitignore'), '*.rs\n');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', '.gitignore'), '!kept.rs\n');
    const scopes = await loadGitignoreScopes(root);
    expect(isGitignoredPath(join('src', 'kept.rs'), scopes)).toBe(false);
    expect(isGitignoredPath(join('src', 'other.rs'), scopes)).toBe(true);
    expect(isGitignoredPath(join('sibling', 'kept.rs'), scopes)).toBe(true);
  });

  it('never loads rules below a pruned directory to reopen an excluded parent', async () => {
    await writeFile(join(root, '.gitignore'), 'cargo-cache/\n');
    await mkdir(join(root, 'cargo-cache'));
    await writeFile(join(root, 'cargo-cache', '.gitignore'), '!generated.rs\n');
    const scopes = await loadGitignoreScopes(root);
    expect(scopes.map((scope) => scope.baseDir)).toEqual(['']);
    expect(isGitignoredPath(join('cargo-cache', 'generated.rs'), scopes)).toBe(true);
  });

  it('loads nested ignores even when the root has no .gitignore', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', '.gitignore'), 'generated/\n');
    const scopes = await loadGitignoreScopes(root);
    expect(isGitignoredPath(join('src', 'generated'), scopes, true)).toBe(true);
    expect(isGitignoredPath(join('other', 'generated'), scopes, true)).toBe(false);
  });

  it('uses the same root and nested exclusions for the embedding source count', async () => {
    await writeFile(join(root, '.gitignore'), 'cargo-cache/\n');
    await mkdir(join(root, 'cargo-cache'));
    await mkdir(join(root, 'src', 'generated'), { recursive: true });
    await writeFile(join(root, 'src', '.gitignore'), 'generated/\n');
    await writeFile(join(root, 'main.rs'), 'fn main() {}\n');
    await writeFile(join(root, 'src', 'kept.rs'), 'fn kept() {}\n');
    for (let i = 0; i < 12; i++) {
      await writeFile(join(root, 'cargo-cache', 'build-' + i + '.rs'), 'fn generated() {}\n');
      await writeFile(join(root, 'src', 'generated', 'build-' + i + '.rs'), 'fn generated() {}\n');
    }
    const scopes = await loadGitignoreScopes(root);
    watcher = new McpWatcher({ rootPath: root, embed: true, embedFileCeiling: 2 });
    const counter = watcher as unknown as {
      countSourceFiles(cap: number, scopes: Awaited<ReturnType<typeof loadGitignoreScopes>>): Promise<number>;
    };
    expect(await counter.countSourceFiles(3, scopes)).toBe(2);
  });
});
