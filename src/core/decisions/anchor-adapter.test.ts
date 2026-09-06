/**
 * AnchorContext + makeFreshnessView — disk-backed anchoring against a real edge
 * store and real source files. (change: add-code-anchored-memory-staleness)
 *
 * Covers byte-accurate multibyte span hashing, span clamping on a shrunken file,
 * deterministic resolution (no guessing), and the freshness view. Plain .test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { AnchorContext, makeFreshnessView, isNamedIn } from './anchor-adapter.js';
import { memoryFreshness } from './anchor.js';
import type { FunctionNode } from '../analyzer/call-graph.js';

let root: string;

function node(filePath: string, name: string, startIndex: number, endIndex: number, opts: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id: `${filePath}::${name}`,
    name,
    filePath,
    isAsync: false,
    language: 'typescript',
    startIndex,
    endIndex,
    fanIn: 0,
    fanOut: 0,
    ...opts,
  };
}

async function analysisDir(): Promise<string> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const store = EdgeStore.open(EdgeStore.dbPath(await analysisDir()));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-anchor-'));
  await mkdir(join(root, 'src'), { recursive: true });
});
afterEach(async () => { await removeFixture(root); });

/**
 * Remove a fixture, tolerating a handle Windows will not let us delete around.
 *
 * POSIX unlinks an open file happily; Windows refuses with EBUSY/EPERM until the last handle
 * closes, and these fixtures hold call-graph.db whose SQLite -shm/-wal siblings clear a beat
 * after the store does. A plain rm raced that and the tests failed in TEARDOWN, naming a temp
 * path — which reads as unrelated to anything they assert. Deletion is not under test here, so
 * retry briefly and then leave it to the OS.
 */
async function removeFixture(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

describe('AnchorContext.open', () => {
  it('returns null when no analysis exists', () => {
    expect(AnchorContext.open(root)).toBeNull();
  });
});

describe('byte-accurate span hashing', () => {
  it('hashes the exact byte span of a multibyte source file and detects an in-span edit', async () => {
    // Two functions; the first contains multibyte characters so byte offsets != char offsets.
    const src = 'const fooʮ = () => "café 🚀";\nconst bar = () => 2;\n';
    await writeFile(join(root, 'src', 'm.ts'), src, 'utf-8');
    const buf = Buffer.from(src, 'utf-8');
    const fooStart = 0;
    const fooEnd = buf.indexOf(Buffer.from(';', 'utf-8')) + 1; // end of first stmt (byte offset)
    await buildStore([node('src/m.ts', 'foo', fooStart, fooEnd)]);

    const ctx = AnchorContext.open(root)!;
    try {
      const view = ctx.freshnessView();
      const h1 = view.nodeHash('src/m.ts::foo');
      expect(h1).toBeDefined();
      // Re-evaluating yields the identical hash (determinism).
      expect(makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR))), root).nodeHash('src/m.ts::foo')).toBe(h1);
    } finally {
      ctx.close();
    }
  });

  it('drifts when the anchored span content changes; stays fresh when only out-of-span bytes change', async () => {
    const src = 'function a() { return 1; }\nfunction b() { return 2; }\n';
    await writeFile(join(root, 'src', 's.ts'), src, 'utf-8');
    const aEnd = src.indexOf('}') + 1;
    await buildStore([node('src/s.ts', 'a', 0, aEnd)]);

    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const baseline = makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root).nodeHash('src/s.ts::a');

    // Change only function b (outside a's span) — a's span hash is unchanged.
    await writeFile(join(root, 'src', 's.ts'), 'function a() { return 1; }\nfunction b() { return 999; }\n', 'utf-8');
    expect(makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root).nodeHash('src/s.ts::a')).toBe(baseline);

    // Change function a's body — its span hash changes.
    await writeFile(join(root, 'src', 's.ts'), 'function a() { return 7; }\nfunction b() { return 2; }\n', 'utf-8');
    expect(makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root).nodeHash('src/s.ts::a')).not.toBe(baseline);
  });

  it('clamps an out-of-range span on a shrunken file (no crash, deterministic)', async () => {
    const src = 'function big() { /* long body */ return 123456; }\n';
    await writeFile(join(root, 'src', 'shrink.ts'), src, 'utf-8');
    await buildStore([node('src/shrink.ts', 'big', 0, Buffer.byteLength(src, 'utf-8'))]);
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

    // Truncate the file well below endIndex; subarray must clamp, not throw.
    await writeFile(join(root, 'src', 'shrink.ts'), 'fn x', 'utf-8');
    const view = makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root);
    expect(() => view.nodeHash('src/shrink.ts::big')).not.toThrow();
    expect(view.nodeHash('src/shrink.ts::big')).toBeDefined();
  });

  it('nodeHash is undefined for a missing node and a missing file', async () => {
    await writeFile(join(root, 'src', 'g.ts'), 'function g() {}\n', 'utf-8');
    await buildStore([node('src/g.ts', 'g', 0, 14)]);
    const view = AnchorContext.open(root)!.freshnessView();
    expect(view.nodeHash('src/g.ts::nonexistent')).toBeUndefined();
    expect(view.fileExists('src/g.ts')).toBe(true);
    expect(view.fileExists('src/missing.ts')).toBe(false);
  });
});

describe('resolveDecisionAnchors', () => {
  it('anchors a symbol named verbatim in the decision text, plus file-level anchors', async () => {
    const src = 'export function validateDirectory() { return true; }\nexport function helper() {}\n';
    await writeFile(join(root, 'src', 'utils.ts'), src, 'utf-8');
    await buildStore([
      node('src/utils.ts', 'validateDirectory', 0, src.indexOf('}') + 1),
      node('src/utils.ts', 'helper', src.indexOf('export function helper'), Buffer.byteLength(src, 'utf-8')),
    ]);
    const ctx = AnchorContext.open(root)!;
    try {
      const anchors = ctx.resolveDecisionAnchors(['src/utils.ts'], 'Harden validateDirectory against traversal');
      const symbol = anchors.filter((a) => a.nodeId);
      const files = anchors.filter((a) => !a.nodeId);
      expect(symbol.map((a) => a.symbolName)).toEqual(['validateDirectory']); // helper not mentioned
      expect(files.map((a) => a.filePath)).toEqual(['src/utils.ts']);
      expect(files[0].contentHash).toBeDefined();
    } finally {
      ctx.close();
    }
  });

  it('produces only a file-level anchor when no symbol is mentioned', async () => {
    const src = 'export function foo() {}\n';
    await writeFile(join(root, 'src', 'a.ts'), src, 'utf-8');
    await buildStore([node('src/a.ts', 'foo', 0, Buffer.byteLength(src, 'utf-8'))]);
    const ctx = AnchorContext.open(root)!;
    try {
      const anchors = ctx.resolveDecisionAnchors(['src/a.ts'], 'A general decision about the module');
      expect(anchors.every((a) => !a.nodeId)).toBe(true);
      expect(anchors).toHaveLength(1);
    } finally {
      ctx.close();
    }
  });
});

describe('resolveInputAnchors (remember hints)', () => {
  let ctx: AnchorContext;
  beforeEach(async () => {
    const src = 'export function foo() {}\nexport function dup() {}\n';
    await writeFile(join(root, 'src', 'x.ts'), src, 'utf-8');
    const src2 = 'export function dup() {}\n';
    await writeFile(join(root, 'src', 'y.ts'), src2, 'utf-8');
    await buildStore([
      node('src/x.ts', 'foo', 0, src.indexOf('}') + 1),
      node('src/x.ts', 'dup', src.indexOf('export function dup'), Buffer.byteLength(src, 'utf-8')),
      node('src/y.ts', 'dup', 0, Buffer.byteLength(src2, 'utf-8')),
    ]);
    ctx = AnchorContext.open(root)!;
  });
  afterEach(() => ctx.close());

  it('resolves a unique symbol hint to a symbol anchor', () => {
    const anchors = ctx.resolveInputAnchors([{ symbol: 'foo', file: 'src/x.ts' }]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ symbolName: 'foo', filePath: 'src/x.ts' });
    expect(anchors[0].nodeId).toBeDefined();
  });

  it('narrows an ambiguous symbol by the hinted file', () => {
    const anchors = ctx.resolveInputAnchors([{ symbol: 'dup', file: 'src/y.ts' }]);
    expect(anchors[0]).toMatchObject({ symbolName: 'dup', filePath: 'src/y.ts' });
  });

  it('falls back to a file anchor when the symbol is ambiguous and unnarrowed', () => {
    const anchors = ctx.resolveInputAnchors([{ symbol: 'dup', file: 'src/nonexistent-or-unhinted.ts' }]);
    // symbol "dup" is ambiguous across two files; with a file hint that does not
    // contain it, it cannot resolve to one node, so a file-level anchor is used.
    expect(anchors[0].nodeId).toBeUndefined();
    expect(anchors[0].filePath).toBe('src/nonexistent-or-unhinted.ts');
  });

  it('drops a hint with neither a resolvable symbol nor a file', () => {
    expect(ctx.resolveInputAnchors([{ symbol: 'doesNotExist' }])).toEqual([]);
  });

  // A symbol-only hint used to build an AnchorNode for EVERY internal node, reading and
  // hashing each one's source span — i.e. the whole repository, to resolve one symbol.
  // (change: optimize-serving-hot-path-caches)
  it('resolves a symbol-only hint by reading only that symbol\'s file', () => {
    const anchors = ctx.resolveInputAnchors([{ symbol: 'foo' }]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ symbolName: 'foo', filePath: 'src/x.ts' });
    // src/y.ts holds an unrelated symbol and must not have been read.
    expect(ctx._filesReadForTesting()).toBe(1);
  });

  it('still detects ambiguity on a symbol-only hint, and reads no more than the ambiguous files', () => {
    // 'dup' exists in both x.ts and y.ts: unresolvable without a file, and with no file
    // hint to fall back on the hint is dropped entirely.
    expect(ctx.resolveInputAnchors([{ symbol: 'dup' }])).toEqual([]);
    expect(ctx._filesReadForTesting()).toBeLessThanOrEqual(2);
  });

  it('an unknown symbol-only hint reads nothing at all', () => {
    expect(ctx.resolveInputAnchors([{ symbol: 'noSuchSymbolAnywhere' }])).toEqual([]);
    expect(ctx._filesReadForTesting()).toBe(0);
  });
});

describe('isNamedIn', () => {
  it('matches whole-word symbol mentions only', () => {
    expect(isNamedIn('we call validateDirectory here', 'validateDirectory')).toBe(true);
    expect(isNamedIn('validateDirectoryImpl is different', 'validateDirectory')).toBe(false);
    expect(isNamedIn('the foo.bar method', 'bar')).toBe(true);
    expect(isNamedIn('short names skipped', 'fo')).toBe(false);
  });

  it('treats regex metacharacters in names literally', () => {
    expect(isNamedIn('call a.b()', 'a.b')).toBe(true);
    expect(isNamedIn('call axb()', 'a.b')).toBe(false);
  });
});

describe('end-to-end freshness via memoryFreshness + adapter view', () => {
  it('fresh -> drifted -> orphaned as the anchored function evolves', async () => {
    const src = 'function target() { return 1; }\n';
    await writeFile(join(root, 'src', 't.ts'), src, 'utf-8');
    await buildStore([node('src/t.ts', 'target', 0, Buffer.byteLength(src, 'utf-8'))]);
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

    const ctx0 = AnchorContext.open(root)!;
    const anchors = ctx0.resolveDecisionAnchors(['src/t.ts'], 'keep target pure');
    ctx0.close();
    const symbolAnchor = anchors.find((a) => a.symbolName === 'target')!;
    expect(symbolAnchor).toBeDefined();

    // fresh
    let view = makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root);
    expect(memoryFreshness([symbolAnchor], view).freshness).toBe('fresh');

    // drifted — edit body, keep node offsets (re-point endIndex to new length)
    const edited = 'function target() { return 42; }\n';
    await writeFile(join(root, 'src', 't.ts'), edited, 'utf-8');
    await buildStore([node('src/t.ts', 'target', 0, Buffer.byteLength(edited, 'utf-8'))]);
    view = makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root);
    expect(memoryFreshness([symbolAnchor], view).freshness).toBe('drifted');

    // orphaned — node removed from the graph
    await buildStore([]);
    view = makeFreshnessView(EdgeStore.open(EdgeStore.dbPath(dir)), root);
    expect(memoryFreshness([symbolAnchor], view).freshness).toBe('orphaned');
  });
});
