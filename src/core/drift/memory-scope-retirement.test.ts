/**
 * Scoped memory findings + terminal disposition for deleted anchors
 * (change: scope-advisory-noise-to-touched-code).
 *
 * Two properties under test:
 *   1. A scoped drift run enumerates only anchors inside the reviewed changeset
 *      and COUNTS the rest — without changing any verdict.
 *   2. An anchor to a file gone from working tree AND `HEAD` is retired once,
 *      never re-reported, never rewritten, and still served by `recall --asOf`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { detectMemoryStaleness, detectDrift, scopeMemoryFindings } from './drift-detector.js';
import { isFileGoneFromHistory } from '../decisions/retirement.js';
import { handleRecall } from '../services/mcp-handlers/memory.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import type { ChangedFile, DriftIssue, SpecMap } from '../../types/index.js';

let root: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
}

function node(filePath: string, name: string, endIndex: number): FunctionNode {
  return {
    id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'typescript',
    startIndex: 0, endIndex, fanIn: 0, fanOut: 0,
  };
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

async function writeNotes(memories: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'notes.json'),
    JSON.stringify({ version: '1', updatedAt: '', memories }),
    'utf-8',
  );
}

async function readNotes(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(root, OPENLORE_DIR, 'memory', 'notes.json'), 'utf-8');
  return (JSON.parse(raw) as { memories: Array<Record<string, unknown>> }).memories;
}

function emptySpecMap(): SpecMap {
  return { byDomain: new Map(), byFile: new Map(), domainCount: 0, totalMappedFiles: 0 };
}

function changed(path: string): ChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 0, isTest: false, isGenerated: false, extension: '.ts' } as ChangedFile;
}

function note(id: string, filePath: string): Record<string, unknown> {
  return {
    id, kind: 'note', content: `note about ${filePath}`, recordedAt: '2026-01-01T00:00:00Z',
    anchors: [{ filePath, contentHash: 'stale-hash' }],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-scope-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
  await buildStore([node('src/a.ts', 'a', 20)]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// ============================================================================
// 1. Scoping
// ============================================================================

describe('scopeMemoryFindings', () => {
  const issue = (id: string, filePath: string): DriftIssue => ({
    id, kind: 'memory-drifted', severity: 'info', message: '', filePath,
    domain: null, specPath: null, suggestion: '',
  });

  it('enumerates in-scope anchors and counts the rest', () => {
    const issues = [issue('a', 'src/a.ts'), issue('b', 'src/b.ts'), issue('c', 'src/c.ts')];
    const { inScope, outOfScope } = scopeMemoryFindings(issues, new Set(['src/a.ts']));
    expect(inScope.map(i => i.id)).toEqual(['a']);
    expect(outOfScope).toBe(2);
  });

  it('enumerates everything when there is no scope', () => {
    const issues = [issue('a', 'src/a.ts'), issue('b', 'src/b.ts')];
    expect(scopeMemoryFindings(issues, new Set()).inScope).toHaveLength(2);
    expect(scopeMemoryFindings(issues, new Set()).outOfScope).toBe(0);
  });

  it('fails open: an unattributable finding is enumerated, never silently counted', () => {
    const { inScope, outOfScope } = scopeMemoryFindings([issue('x', '')], new Set(['src/a.ts']));
    expect(inScope.map(i => i.id)).toEqual(['x']);
    expect(outOfScope).toBe(0);
  });
});

describe('detectDrift memory scope', () => {
  it('counts out-of-scope drifted anchors instead of listing them, with no verdict change', async () => {
    await writeNotes([
      note('n1', 'src/a.ts'),   // in the reviewed changeset
      note('n2', 'src/b.ts'),
      note('n3', 'src/c.ts'),
    ]);

    const memoryIssues = (r: { issues: DriftIssue[] }) =>
      r.issues.filter(i => i.kind === 'memory-drifted' || i.kind === 'memory-orphaned');

    const unscoped = await detectDrift({
      rootPath: root, specMap: emptySpecMap(), changedFiles: [], failOn: 'warning',
    });
    expect(memoryIssues(unscoped)).toHaveLength(3);
    expect(unscoped.summary.memoryOutOfScope).toBe(0);

    const scoped = await detectDrift({
      rootPath: root, specMap: emptySpecMap(), changedFiles: [changed('src/a.ts')], failOn: 'warning',
    });
    // src/a.ts exists but its anchor hash moved ⇒ drifted; the other two are orphaned.
    expect(memoryIssues(scoped).map(i => i.id)).toEqual(['memory-drifted:note:n1']);
    expect(scoped.summary.memoryOutOfScope).toBe(2);

    // Same verdict either way — scope changes presentation, never truth.
    const verdictOf = (r: { issues: DriftIssue[] }, id: string) =>
      r.issues.find(i => i.id === id)?.kind;
    expect(verdictOf(scoped, 'memory-drifted:note:n1'))
      .toBe(verdictOf(unscoped, 'memory-drifted:note:n1'));
  });

  it('honors an explicit repository scope', async () => {
    await writeNotes([note('n1', 'src/a.ts'), note('n2', 'src/b.ts')]);
    const result = await detectDrift({
      rootPath: root, specMap: emptySpecMap(), changedFiles: [changed('src/a.ts')],
      failOn: 'warning', memoryScope: 'repository',
    });
    expect(result.issues.filter(i => i.kind.startsWith('memory-'))).toHaveLength(2);
    expect(result.summary.memoryOutOfScope).toBe(0);
  });
});

// ============================================================================
// 2. Retirement
// ============================================================================

describe('retirement of anchors to deleted files', () => {
  /** Commit src/gone.ts, then delete it in a second commit. */
  async function repoWithDeletedFile(): Promise<void> {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(root, 'src', 'gone.ts'), 'export const gone = 1;\n', 'utf-8');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add gone');
    await unlink(join(root, 'src', 'gone.ts'));
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'delete gone');
  }

  it('recognizes a file absent from working tree and HEAD', async () => {
    await repoWithDeletedFile();
    expect(await isFileGoneFromHistory(root, 'src/gone.ts')).toBe(true);
    expect(await isFileGoneFromHistory(root, 'src/a.ts')).toBe(false);
  });

  it('retires once and never re-reports, keeping the recorded text intact', async () => {
    await repoWithDeletedFile();
    await writeNotes([note('n1', 'src/gone.ts')]);

    const first = await detectMemoryStaleness(root);
    expect(first.some(i => i.id === 'memory-orphaned:note:n1')).toBe(false);

    const stored = (await readNotes()).find(m => m.id === 'n1')!;
    expect(stored.retiredReason).toBe('anchor-file-deleted');
    expect(typeof stored.retiredAt).toBe('string');
    expect(stored.content).toBe('note about src/gone.ts');   // text untouched

    const second = await detectMemoryStaleness(root);
    expect(second.some(i => i.id === 'memory-orphaned:note:n1')).toBe(false);
    // The disposition is written once, not re-stamped on every run.
    expect((await readNotes()).find(m => m.id === 'n1')!.retiredAt).toBe(stored.retiredAt);
  });

  it('does NOT retire an uncommitted deletion — it may be the change under review', async () => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(root, 'src', 'pending.ts'), 'export const p = 1;\n', 'utf-8');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add pending');
    await unlink(join(root, 'src', 'pending.ts'));   // deleted in the working tree only

    expect(await isFileGoneFromHistory(root, 'src/pending.ts')).toBe(false);

    await writeNotes([note('n1', 'src/pending.ts')]);
    const issues = await detectMemoryStaleness(root);
    expect(issues.some(i => i.id === 'memory-orphaned:note:n1')).toBe(true);
    expect((await readNotes()).find(m => m.id === 'n1')!.retiredAt).toBeUndefined();
  });

  it('retires nothing outside a git repository (no history to be absent from)', async () => {
    await writeNotes([note('n1', 'src/never-existed.ts')]);
    const issues = await detectMemoryStaleness(root);
    expect(issues.some(i => i.id === 'memory-orphaned:note:n1')).toBe(true);
    expect((await readNotes()).find(m => m.id === 'n1')!.retiredAt).toBeUndefined();
  });

  it('keeps a retired record queryable under asOf, and out of current memory', async () => {
    await repoWithDeletedFile();
    await writeNotes([note('n1', 'src/gone.ts')]);
    await detectMemoryStaleness(root);   // retires n1

    const current = await handleRecall(root) as {
      authoritative?: Array<{ id: string }>;
      needsReanchoring?: Array<{ id: string }>;
    };
    const currentIds = [
      ...(current.authoritative ?? []),
      ...(current.needsReanchoring ?? []),
    ].map(i => i.id);
    expect(currentIds).not.toContain('n1');

    const historical = await handleRecall(root, undefined, 10, undefined, 'HEAD') as {
      authoritative?: Array<{ id: string; text: string; retired?: boolean; retiredReason?: string }>;
      needsReanchoring?: Array<{ id: string; text: string; retired?: boolean; retiredReason?: string }>;
    };
    const served = [
      ...(historical.authoritative ?? []),
      ...(historical.needsReanchoring ?? []),
    ].find(i => i.id === 'n1');
    expect(served).toBeDefined();
    expect(served!.retired).toBe(true);
    expect(served!.retiredReason).toBe('anchor-file-deleted');
    expect(served!.text).toBe('note about src/gone.ts');
  });
});
