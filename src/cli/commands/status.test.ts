/**
 * `openlore status` — the index's self-state (change: make-index-self-state-honest).
 *
 * Read-only is a property, not a promise: the test asserts that nothing on disk moves,
 * because a status command that touches the index is one nobody can run while a build
 * is in flight.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectIndexStatus, statusCommand } from './status.js';
import { _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';

const ANALYSIS = join('.openlore', 'analysis');

describe('openlore status — what the index is', () => {
  let root: string;
  const savedBaseUrl = process.env.EMBED_BASE_URL;
  const savedModel = process.env.EMBED_MODEL;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-status-'));
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    _resetVectorIndexCachesForTesting();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (savedBaseUrl === undefined) delete process.env.EMBED_BASE_URL; else process.env.EMBED_BASE_URL = savedBaseUrl;
    if (savedModel === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = savedModel;
  });

  async function withIndex(hasEmbeddings: boolean, builtAt = new Date().toISOString()): Promise<string> {
    const analysisDir = join(root, ANALYSIS);
    await mkdir(join(analysisDir, 'vector-index'), { recursive: true });
    await writeFile(join(analysisDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings,
      dim: hasEmbeddings ? 384 : 0,
      model: hasEmbeddings ? 'all-MiniLM-L6-v2' : null,
      builtAt,
      schemaVersion: 1,
      tokenizerVersion: 2,
    }), 'utf-8');
    return analysisDir;
  }

  const writeConfig = async (embedding: Record<string, unknown> | null): Promise<void> => {
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-5' },
      createdAt: '2026-09-20T00:00:00.000Z',
      lastRun: null,
      ...(embedding ? { embedding } : {}),
    }), 'utf-8');
  };

  it('names the cause when a configured provider is unrealized', async () => {
    await withIndex(false);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });

    const status = await collectIndexStatus(root);

    expect(status.retrievalMode).toMatch(/^keyword/);
    expect(status.keywordCause).toBe('configured-provider-unrealized');
    expect(status.configuredProvider).toBe('all-MiniLM-L6-v2');
  });

  it('distinguishes the unconfigured keyword default from that finding', async () => {
    await withIndex(false);
    await writeConfig(null);

    const status = await collectIndexStatus(root);

    expect(status.keywordCause).toBe('no-provider-configured');
    expect(status.configuredProvider).toBeNull();
  });

  it('reports the semantic mode and no keyword cause when vectors are present', async () => {
    await withIndex(true);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });
    process.env.EMBED_BASE_URL = 'http://127.0.0.1:8765/v1';
    process.env.EMBED_MODEL = 'all-MiniLM-L6-v2';

    const status = await collectIndexStatus(root);

    expect(status.retrievalMode).toBe('remote-semantic');
    expect(status.keywordCause).toBeNull();
  });

  it('reports a missing index instead of crashing', async () => {
    await writeConfig(null);

    const status = await collectIndexStatus(root);

    expect(status.indexPresent).toBe(false);
    expect(status.retrievalMode).toBeNull();
    expect(status.builtAt).toBeNull();
  });

  it('carries a recorded embed failure and the last build degradations', async () => {
    const analysisDir = await withIndex(false);
    await writeConfig(null);
    await writeFile(join(analysisDir, 'analysis-indexes.json'), JSON.stringify({
      result: { functionIndex: 'degraded', textIndex: 'built', specIndex: 'built', degraded: [{ index: 'function', reason: 'endpoint unavailable' }] },
      embedFailure: { at: '2026-09-20T15:40:00.000Z', reason: 'fetch failed', endpoint: 'http://127.0.0.1:8765/v1' },
    }), 'utf-8');

    const status = await collectIndexStatus(root);

    expect(status.embedFailure).toMatchObject({ reason: 'fetch failed' });
    expect(status.degraded).toEqual([{ index: 'function', reason: 'endpoint unavailable' }]);
  });

  it('is read-only: no file in the analysis directory changes', async () => {
    const analysisDir = await withIndex(true);
    await writeConfig(null);
    const before = new Map<string, number>();
    for (const entry of await readdir(analysisDir)) {
      before.set(entry, (await stat(join(analysisDir, entry))).mtimeMs);
    }

    await collectIndexStatus(root);

    const after = await readdir(analysisDir);
    expect(after.sort()).toEqual([...before.keys()].sort());
    for (const entry of after) {
      expect((await stat(join(analysisDir, entry))).mtimeMs).toBe(before.get(entry));
    }
  });

  it('emits the same fields through --json', async () => {
    await withIndex(false);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.chdir(root);
      await statusCommand.parseAsync(['node', 'openlore', '--json']);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }

    const parsed = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      indexPresent: true,
      keywordCause: 'configured-provider-unrealized',
      configuredProvider: 'all-MiniLM-L6-v2',
    });
    expect(typeof parsed.retrievalMode).toBe('string');
    expect(Array.isArray(parsed.staleFiles)).toBe(true);
  });

  it('reports unknown freshness when git is unavailable rather than claiming current', async () => {
    // `root` is a bare temp directory: `git status` there fails, which must degrade to
    // "nothing known" instead of taking down a read-only command.
    await withIndex(true, '2020-01-01T00:00:00.000Z');
    await writeConfig(null);

    const status = await collectIndexStatus(root);

    expect(status.staleFiles).toEqual([]);
    expect(status.staleFilesTruncated).toBe(false);
    expect(status.staleFilesUnknown).toBe(true);
  });

  it('keeps unusual git filenames intact and reports deleted indexed files', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await writeFile(join(root, 'removed.ts'), 'export function removed() {}\n');
    await writeFile(join(root, 'before-rename.ts'), 'export function renamed() {}\n');
    execFileSync('git', ['add', 'removed.ts', 'before-rename.ts'], { cwd: root });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline'], { cwd: root });
    await withIndex(false, '2020-01-01T00:00:00.000Z');
    await writeConfig(null);
    // Windows filenames cannot contain quotes; still exercise spaces there.
    const unusual = process.platform === 'win32' ? 'quoted name.ts' : 'quoted "name"\n.ts';
    await writeFile(join(root, unusual), 'export function unusual() {}\n');
    await mkdir(join(root, 'new-directory'));
    await writeFile(join(root, 'new-directory', 'added.ts'), 'export function added() {}\n');
    await rm(join(root, 'removed.ts'));
    execFileSync('git', ['mv', 'before-rename.ts', 'after-rename.ts'], { cwd: root });

    const status = await collectIndexStatus(root);

    expect(status.staleFiles).toContain(unusual);
    expect(status.staleFiles).toContain('new-directory/added.ts');
    expect(status.staleFiles).toContain('removed.ts');
    expect(status.staleFiles).toContain('before-rename.ts');
    expect(status.staleFiles).toContain('after-rename.ts');
  });
});
