/**
 * Scoped memory findings and read-only treatment of deleted anchors
 * (change: scope-advisory-noise-to-touched-code).
 *
 * Two properties under test:
 *   1. A scoped drift run enumerates only anchors inside the reviewed changeset
 *      and COUNTS the rest — without changing any verdict.
 *   2. Drift inspection never mutates memory or decision stores, including on
 *      branches that delete or rename anchored files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { detectMemoryStaleness, detectDrift, scopeMemoryFindings } from './drift-detector.js';
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

async function writeDecisions(decisions: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'decisions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'pending.json'),
    JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions }),
    'utf-8',
  );
}

function emptySpecMap(): SpecMap {
  return { byDomain: new Map(), byFile: new Map(), domainCount: 0, totalMappedFiles: 0 };
}

function changed(path: string): ChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 0, isTest: false, isGenerated: false, extension: '.ts' } as ChangedFile;
}

function note(id: string, filePath: string, contentHash: string | null = 'stale-hash'): Record<string, unknown> {
  return {
    id, kind: 'note', content: `note about ${filePath}`, recordedAt: '2026-01-01T00:00:00Z',
    anchors: [{ filePath, ...(contentHash === null ? {} : { contentHash }) }],
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
// 2. Read-only branch semantics
// ============================================================================

describe('read-only handling of anchors to branch-local deletions and renames', () => {
  async function initializeRepository(filePath: string): Promise<void> {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(root, filePath), 'export const anchored = 1;\n', 'utf-8');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add anchored file');
  }

  it('reports a branch-local committed deletion on every run without mutating either store', async () => {
    await initializeRepository('src/gone.ts');
    git('switch', '-q', '-c', 'review-delete');
    await unlink(join(root, 'src', 'gone.ts'));
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'delete anchored file');
    await buildStore([]);
    await writeNotes([note('n1', 'src/gone.ts', null)]);
    await writeDecisions([{
      id: 'd1', status: 'approved', title: 'decision about gone.ts', rationale: '', consequences: '',
      proposedRequirement: null, affectedDomains: [], affectedFiles: ['src/gone.ts'],
      anchors: [{ filePath: 'src/gone.ts' }], sessionId: 's', recordedAt: '2026-01-01T00:00:00Z',
      confidence: 'medium', syncedToSpecs: [],
    }]);

    const notesPath = join(root, OPENLORE_DIR, 'memory', 'notes.json');
    const decisionsPath = join(root, OPENLORE_DIR, 'decisions', 'pending.json');
    const before = await Promise.all([readFile(notesPath, 'utf-8'), readFile(decisionsPath, 'utf-8')]);
    for (let run = 0; run < 2; run++) {
      const issues = await detectMemoryStaleness(root);
      expect(issues.map(i => i.id)).toEqual([
        'memory-orphaned:decision:d1',
        'memory-orphaned:note:n1',
      ]);
      expect(await Promise.all([readFile(notesPath, 'utf-8'), readFile(decisionsPath, 'utf-8')])).toEqual(before);
    }

    // The same durable records become fresh again when the branch context and
    // analysis return to the revision where their subject exists.
    git('switch', '-q', 'main');
    await buildStore([node('src/gone.ts', 'anchored', 27)]);
    expect(await detectMemoryStaleness(root)).toEqual([]);
    expect(await Promise.all([readFile(notesPath, 'utf-8'), readFile(decisionsPath, 'utf-8')])).toEqual(before);
  });

  it('does not permanently retire an old path while inspecting a branch-local rename', async () => {
    await initializeRepository('src/old.ts');
    git('switch', '-q', '-c', 'review-rename');
    git('mv', 'src/old.ts', 'src/new.ts');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'rename anchored file');
    await buildStore([node('src/new.ts', 'anchored', 27)]);
    await writeNotes([note('n1', 'src/old.ts', null)]);
    const notesPath = join(root, OPENLORE_DIR, 'memory', 'notes.json');
    const before = await readFile(notesPath, 'utf-8');

    expect((await detectMemoryStaleness(root)).map(i => i.id)).toEqual(['memory-orphaned:note:n1']);
    expect(await readFile(notesPath, 'utf-8')).toBe(before);

    git('switch', '-q', 'main');
    await buildStore([node('src/old.ts', 'anchored', 27)]);
    expect(await detectMemoryStaleness(root)).toEqual([]);
    expect(await readFile(notesPath, 'utf-8')).toBe(before);
  });
});
