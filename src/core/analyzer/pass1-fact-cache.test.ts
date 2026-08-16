/**
 * Pass-1 fact memo (change: optimize-hash-keyed-analyze).
 *
 * The memo exists to make analyze CHEAPER without making it DIFFERENT, so the load-bearing
 * tests here are equality tests: run a corpus through a warm memo and through a full
 * re-extraction and require identical graphs. The hazards being pinned are the ones a stale
 * memo would cause — a changed file served from an old row, an extractor change served from
 * a row it did not produce, a deleted file leaving ghost facts — plus the coverage of the
 * stamp itself, which is the only thing standing between "reuse" and "reuse something wrong".
 *
 * The stub store below is not a mock of extraction: extraction is always the real
 * `dispatchFileExtract`. It only controls which rows exist, which is exactly the variable a
 * real cache introduces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BufferedPass1FactCache,
  computeExtractorStamp,
  deserializeFacts,
  digestStampRoots,
  factKey,
  resolvePackageVersion,
  __grammarPackageNamesForTests,
  serializeFacts,
  __STAMP_ROOTS_FOR_TESTS,
  type ExtractionInput,
  type Pass1FactStorage,
} from './pass1-fact-cache.js';
import { CallGraphBuilder, serializeCallGraph, dispatchFileExtract } from './call-graph.js';
import type { ExtractionWorkerHandle } from './extraction-pool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/src/core/analyzer` → the repo root. */
const REPO_ROOT = resolve(HERE, '../../..');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A corpus with real cross-file calls, so a mis-ordered or mis-keyed merge shows up as edges. */
function corpus(count = 6): ExtractionInput[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `src/mod${i}.ts`,
    language: 'TypeScript',
    content:
      `export function helper${i}(x: number): number {\n` +
      `  if (x > ${i}) { return x - ${i}; }\n` +
      `  return x + ${i};\n` +
      `}\n\n` +
      `export class Widget${i} {\n` +
      `  render(): number {\n` +
      `    return helper${i}(${i}) + helper${(i + 1) % count}(1);\n` +
      `  }\n` +
      `}\n`,
  }));
}

/** An in-memory stand-in for the graph store's memo table. */
class MemoryStorage implements Pass1FactStorage {
  readonly rows = new Map<string, { contentHash: string; stamp: string; facts: string }>();
  /** Every (path, hash, stamp) triple that was asked for — the read log. */
  readonly lookups: string[] = [];

  getPass1Facts(filePath: string, contentHash: string, stamp: string): string | undefined {
    this.lookups.push(filePath);
    const row = this.rows.get(filePath);
    if (!row || row.contentHash !== contentHash || row.stamp !== stamp) return undefined;
    return row.facts;
  }

  absorb(cache: BufferedPass1FactCache): void {
    const { stamp, rows } = cache.take();
    for (const r of rows) this.rows.set(r.filePath, { contentHash: r.contentHash, stamp, facts: r.facts });
  }
}

/**
 * A worker handle that runs the REAL extractor in-process and records what it was asked to
 * parse. In-process on purpose: the fact under test is WHICH files reach the lane, and real
 * threads would only add nondeterminism to an assertion about set membership.
 */
function recordingWorker(log: string[]): ExtractionWorkerHandle {
  const listeners: Record<string, Array<(v: never) => void>> = { message: [], error: [], exit: [] };
  const emit = (msg: unknown): void => { for (const l of listeners.message) (l as (v: unknown) => void)(msg); };
  setTimeout(() => emit({ type: 'ready' }), 0);
  return {
    postMessage(raw: unknown) {
      const msg = raw as { type: string; id: number; file: ExtractionInput };
      if (msg.type !== 'extract') return;
      log.push(msg.file.path);
      void dispatchFileExtract(msg.file).then(
        (value) => emit({ type: 'result', id: msg.id, value }),
        (err: Error) => emit({ type: 'failed', id: msg.id, message: err.message }),
      );
    },
    on(event: string, listener: (v: never) => void) { listeners[event].push(listener); },
    terminate() { /* nothing to stop */ },
  };
}

/**
 * A worker that extracts the first file for real and then reports every later one as
 * containing nothing — a grammar that dies mid-run.
 *
 * The first real answer matters: it is what makes the pool PROVE the language, after which
 * the pool trusts that worker's empty results and passes them straight to the merge. That is
 * the one reachable path on which a "nothing here" answer reaches the memo, so it is the path
 * the memo's own guard has to hold.
 */
function dyingWorker(): ExtractionWorkerHandle {
  const listeners: Record<string, Array<(v: never) => void>> = { message: [], error: [], exit: [] };
  const emit = (msg: unknown): void => { for (const l of listeners.message) (l as (v: unknown) => void)(msg); };
  setTimeout(() => emit({ type: 'ready' }), 0);
  let answered = 0;
  return {
    postMessage(raw: unknown) {
      const msg = raw as { type: string; id: number; file: ExtractionInput };
      if (msg.type !== 'extract') return;
      if (answered++ === 0) {
        void dispatchFileExtract(msg.file).then((value) => emit({ type: 'result', id: msg.id, value }));
        return;
      }
      emit({ type: 'result', id: msg.id, value: { nodes: [], rawEdges: [], cfg: new Map() } });
    },
    on(event: string, listener: (v: never) => void) { listeners[event].push(listener); },
    terminate() { /* nothing to stop */ },
  };
}

/** Build once with a memo, returning the serialized graph and what the memo did. */
async function buildWith(
  files: ExtractionInput[],
  storage: Pass1FactStorage | null,
  stamp: string,
  noReuseReason?: 'requested',
): Promise<{ graph: string; cache: BufferedPass1FactCache; reused: number; extracted: number }> {
  const cache = new BufferedPass1FactCache(storage, stamp, noReuseReason);
  const result = await new CallGraphBuilder({ pass1Cache: cache }).build(files);
  return {
    graph: JSON.stringify(serializeCallGraph(result)),
    cache,
    reused: result.pass1Cache?.reused ?? -1,
    extracted: result.pass1Cache?.extracted ?? -1,
  };
}

/** The reference lane: no memo at all — what `analyze --force` computes. */
async function buildFresh(files: ExtractionInput[]): Promise<string> {
  const result = await new CallGraphBuilder().build(files);
  return JSON.stringify(serializeCallGraph(result));
}

// ---------------------------------------------------------------------------
// The equality contract
// ---------------------------------------------------------------------------

describe('reused facts are indistinguishable from re-extracted ones', () => {
  it('a fully warm memo reproduces the from-scratch graph exactly', async () => {
    const files = corpus();
    const storage = new MemoryStorage();

    const cold = await buildWith(files, storage, 'stamp-v1');
    expect(cold.extracted).toBe(files.length);
    expect(cold.reused).toBe(0);
    storage.absorb(cold.cache);

    const warm = await buildWith(files, storage, 'stamp-v1');
    expect(warm.reused).toBe(files.length);
    expect(warm.extracted).toBe(0);

    expect(warm.graph).toBe(cold.graph);
    expect(warm.graph).toBe(await buildFresh(files));
  });

  it('an edit re-extracts exactly one file and still matches a full re-extraction', async () => {
    const files = corpus();
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    const edited = files.map((f, i) =>
      i === 2 ? { ...f, content: f.content.replace('helper2(2)', 'helper2(2) + helper0(9)') } : f,
    );

    const incremental = await buildWith(edited, storage, 'stamp-v1');
    expect(incremental.extracted).toBe(1);
    expect(incremental.reused).toBe(edited.length - 1);
    expect(incremental.graph).toBe(await buildFresh(edited));
    // The edit really did land — otherwise the equality above would be vacuous.
    expect(incremental.graph).not.toBe(await buildFresh(files));
  });

  it('an added file extracts only itself; a removed file leaves nothing behind', async () => {
    const files = corpus();
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    const added = [...files, {
      path: 'src/late.ts',
      language: 'TypeScript',
      content: 'import { helper0 } from "./mod0.js";\nexport function late(): number { return helper0(1); }\n',
    }];
    const grown = await buildWith(added, storage, 'stamp-v1');
    expect(grown.extracted).toBe(1);
    expect(grown.graph).toBe(await buildFresh(added));
    storage.absorb(grown.cache);

    const shrunk = added.filter(f => f.path !== 'src/mod3.ts');
    const afterDelete = await buildWith(shrunk, storage, 'stamp-v1');
    expect(afterDelete.extracted).toBe(0);
    expect(afterDelete.graph).toBe(await buildFresh(shrunk));
    // No node from the deleted file survived into the graph via a stale row.
    expect(afterDelete.graph).not.toContain('src/mod3.ts');
  });

  it('a file renamed to a path with different content keys off the new path', async () => {
    const files = corpus();
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    const renamed = files.map(f => (f.path === 'src/mod1.ts' ? { ...f, path: 'src/renamed.ts' } : f));
    const built = await buildWith(renamed, storage, 'stamp-v1');
    // Same bytes, new path: the row is keyed by path, so the new path misses.
    expect(built.extracted).toBe(1);
    expect(built.graph).toBe(await buildFresh(renamed));
  });
});

describe('the memo refuses to serve what it cannot prove', () => {
  it('a stamp bump reuses nothing and repopulates under the new stamp', async () => {
    const files = corpus();
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    const bumped = await buildWith(files, storage, 'stamp-v2');
    expect(bumped.reused).toBe(0);
    expect(bumped.extracted).toBe(files.length);
    expect(bumped.graph).toBe(await buildFresh(files));

    storage.absorb(bumped.cache);
    for (const row of storage.rows.values()) expect(row.stamp).toBe('stamp-v2');

    const warmUnderV2 = await buildWith(files, storage, 'stamp-v2');
    expect(warmUnderV2.reused).toBe(files.length);
  });

  it('the same bytes under a different LANGUAGE are a different key', async () => {
    const file: ExtractionInput = { path: 'src/a.ts', language: 'TypeScript', content: 'function f() { return 1; }\n' };
    expect(factKey(file)).not.toBe(factKey({ ...file, language: 'JavaScript' }));
    expect(factKey(file)).toBe(factKey({ ...file, path: 'src/elsewhere.ts' }));
  });

  it('a corrupt or foreign-format row is a miss, never a partial graph', async () => {
    const files = corpus(3);
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    for (const [path, row] of storage.rows) {
      storage.rows.set(path, { ...row, facts: path === 'src/mod0.ts' ? '{not json' : '{"v":999,"n":[],"e":[]}' });
    }

    const built = await buildWith(files, storage, 'stamp-v1');
    expect(built.extracted).toBe(files.length);
    expect(built.graph).toBe(await buildFresh(files));
  });

  it('a storage that throws degrades to full extraction, and is asked exactly once', async () => {
    // An index materialized from a bundle, or built before this feature, has no memo table at
    // all — so the FIRST read throws and every later one would too. Raising and swallowing one
    // exception per file for an answer already known is pure waste, so the store is retired.
    const files = corpus(3);
    let asked = 0;
    const angry: Pass1FactStorage = {
      getPass1Facts() { asked++; throw new Error('no such table: pass1_facts'); },
    };
    const built = await buildWith(files, angry, 'stamp-v1');
    expect(built.extracted).toBe(files.length);
    expect(asked).toBe(1);
    expect(built.graph).toBe(await buildFresh(files));
    // …and the run still refills the memo, so the next one is cheap.
    expect(built.cache.take().rows).toHaveLength(files.length);
  });

  it('bypassed reads (--force) extract everything and still refill the memo', async () => {
    const files = corpus(4);
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    const forced = await buildWith(files, storage, 'stamp-v1', 'requested');
    expect(forced.extracted).toBe(files.length);
    expect(storage.lookups).toHaveLength(files.length); // the warm run's reads, not the forced one's
    expect(forced.cache.take().rows).toHaveLength(files.length);
    expect(forced.graph).toBe(await buildFresh(files));
  });

  it('memoizes exactly the files it re-extracted — no more, no fewer', async () => {
    const files = corpus(4);
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);

    const edited = files.map((f, i) => (i === 1 ? { ...f, content: f.content + '\nexport const extra = 1;\n' } : f));
    const run = await buildWith(edited, storage, 'stamp-v1');
    expect(run.cache.take().rows.map(r => r.filePath)).toEqual(['src/mod1.ts']);
  });

  /**
   * The hazard: the extractors report an unloadable grammar by returning an EMPTY result, not
   * by throwing — and loadability is a property of the RUNNING PROCESS (Node ABI, prebuilt
   * binaries, a transient dlopen failure) that no content hash or code digest can see.
   * Persisting one empty result would serve an empty graph from cache forever, and repairing
   * the environment would never undo it. This is the memo's version of the pool's "never
   * trust an unproven silence".
   */
  it('a grammar that dies mid-run cannot make its empty answers permanent', async () => {
    // Grammar loadability is a property of the RUNNING PROCESS — Node ABI, prebuilt binaries,
    // a transient dlopen failure — that no content hash or code digest can see. The
    // extractors report it by returning an EMPTY result rather than throwing, so persisting
    // one would serve an empty graph from cache forever, and repairing the environment would
    // never undo it. Only the file that really parsed may be memoized.
    const cache = new BufferedPass1FactCache(null, 'stamp-v1');
    const files = corpus(3);
    await new CallGraphBuilder({
      pass1Cache: cache,
      extraction: { poolSize: 1, workerFactory: () => dyingWorker() },
    }).build(files);
    expect(cache.take().rows.map(r => r.filePath)).toEqual(['src/mod0.ts']);
  });

  it('a file that PARSED and simply has no symbols is still a real answer', async () => {
    // The distinction that makes the guard above safe: an empty result carrying evidence the
    // parse happened (style counters) is trustworthy and memoized; one carrying nothing at
    // all is not. Otherwise every symbol-free file would re-parse forever.
    const barren: ExtractionInput = { path: 'src/empty.ts', language: 'TypeScript', content: '\n' };
    const facts = await dispatchFileExtract(barren);
    expect(facts!.nodes).toHaveLength(0);
    expect(facts!.style, 'a real parse leaves style counters behind').toBeDefined();

    const cache = new BufferedPass1FactCache(null, 'stamp-v1');
    await new CallGraphBuilder({ pass1Cache: cache }).build([barren]);
    expect(cache.take().rows.map(r => r.filePath)).toEqual(['src/empty.ts']);
  });

  it('a language with no extractor is memoized as a real answer, not re-dispatched forever', async () => {
    const files: ExtractionInput[] = [
      { path: 'infra/main.tf', language: 'Terraform', content: 'resource "aws_s3_bucket" "b" {}\n' },
    ];
    const storage = new MemoryStorage();
    const cold = await buildWith(files, storage, 'stamp-v1');
    const { stamp, rows } = cold.cache.take();
    expect(rows[0].facts).toBe('null');
    for (const r of rows) storage.rows.set(r.filePath, { contentHash: r.contentHash, stamp, facts: r.facts });

    const warm = await buildWith(files, storage, 'stamp-v1');
    expect(warm.reused).toBe(1);
    expect(warm.extracted).toBe(0);
    expect(warm.graph).toBe(await buildFresh(files));
  });

  it('the extraction lane is never even handed a file the memo answered', async () => {
    const files = corpus(20);
    const storage = new MemoryStorage();
    storage.absorb((await buildWith(files, storage, 'stamp-v1')).cache);
    const edited = files.map((f, i) => (i === 7 ? { ...f, content: f.content + '\nexport const tail = 1;\n' } : f));

    // Instrument the lane itself: a stub worker that runs the REAL extractor but records
    // every file it is asked to parse. Anything reused must never reach it.
    const dispatched: string[] = [];
    const cache = new BufferedPass1FactCache(storage, 'stamp-v1');
    const result = await new CallGraphBuilder({
      pass1Cache: cache,
      extraction: { poolSize: 1, workerFactory: () => recordingWorker(dispatched) },
    }).build(edited);

    expect(dispatched).toEqual(['src/mod7.ts']);
    expect(result.pass1Cache).toEqual({ reused: 19, extracted: 1, uncacheable: 0 });
    expect(JSON.stringify(serializeCallGraph(result))).toBe(await buildFresh(edited));
  });
});

describe('serialization round-trips the extractor’s own answer', () => {
  it('preserves nodes, edges, CFG, style, parse health, and late-pass facts', async () => {
    const file = corpus(1)[0];
    const facts = await dispatchFileExtract(file);
    expect(facts).toBeDefined();
    expect(facts!.cfg?.size ?? 0).toBeGreaterThan(0);
    facts!.classRelationships = [{ className: 'Child', parentClasses: ['Base'], interfaces: [] }];
    facts!.dynamicDispatch = {
      events: [{
        group: 'TypeScript',
        rule: 'event-channel',
        registrations: [{ key: 'str:ready', handlerIds: ['handler-ref'] }],
        dispatches: [{ key: 'str:ready', callerId: 'caller', line: 7 }],
      }],
      callbacks: [{ group: 'TypeScript', callerId: 'caller', handlerId: 'handler-ref', line: 8 }],
    };

    const round = deserializeFacts(serializeFacts(facts));
    expect(round).toBeDefined();
    const back = round!.facts!;
    expect(back.nodes).toEqual(facts!.nodes);
    expect(back.rawEdges).toEqual(facts!.rawEdges);
    expect(back.cfg).toBeInstanceOf(Map);
    expect([...back.cfg!.entries()]).toEqual([...facts!.cfg!.entries()]);
    expect(back.style).toEqual(facts!.style);
    expect(back.parseHealth).toEqual(facts!.parseHealth);
    expect(back.classRelationships).toEqual(facts!.classRelationships);
    expect(back.dynamicDispatch).toEqual(facts!.dynamicDispatch);
  });

  it('stores "no extractor for this language" as a reusable answer, not a miss', () => {
    expect(serializeFacts(undefined)).toBe('null');
    expect(deserializeFacts('null')).toEqual({ facts: undefined });
  });

  it('rejects an unreadable payload instead of inventing an empty one', () => {
    expect(deserializeFacts('{')).toBeUndefined();
    expect(deserializeFacts('{"v":1}')).toBeUndefined();
    expect(deserializeFacts('[]')).toBeUndefined();
  });
});

describe('late-pass facts survive the persistent cache boundary', () => {
  it('keeps inheritance, cross-file events, and callbacks byte-identical on a fully warm run', async () => {
    const files: ExtractionInput[] = [
      {
        path: 'src/register.ts', language: 'TypeScript',
        content: `
class Base { run(): void {} }
class Child extends Base { run(): void {} }
export function handler(): void {}
export function register(emitter: any): void {
  emitter.on('ready', handler);
  setTimeout(handler, 1);
}
`,
      },
      {
        path: 'src/dispatch.ts', language: 'TypeScript',
        content: `export function dispatch(emitter: any): void { emitter.emit('ready'); }`,
      },
    ];
    const storage = new MemoryStorage();
    const cold = await buildWith(files, storage, 'late-facts-v1');
    storage.absorb(cold.cache);
    const warm = await buildWith(files, storage, 'late-facts-v1');

    expect(warm.reused).toBe(files.length);
    expect(warm.extracted).toBe(0);
    expect(warm.graph).toBe(cold.graph);
    const graph = JSON.parse(warm.graph) as {
      inheritanceEdges: Array<{ kind: string }>;
      edges: Array<{ synthesizedBy?: string }>;
    };
    expect(graph.inheritanceEdges.some(edge => edge.kind === 'extends')).toBe(true);
    expect(graph.edges.some(edge => edge.synthesizedBy === 'event-channel')).toBe(true);
    expect(graph.edges.some(edge => edge.synthesizedBy === 'callback-registration')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The stamp — the soundness boundary
// ---------------------------------------------------------------------------

describe('the extractor stamp', () => {
  it('is stable across calls and is a real digest', () => {
    const a = computeExtractorStamp();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeExtractorStamp()).toBe(a);
  });

  /**
   * The stamp roots are hand-written; this test refuses to let them rot. It walks the REAL
   * static import closure of the extraction entry point and requires every module it reaches
   * to sit under a stamped root — so a future extractor that pulls in a new directory fails
   * here rather than silently becoming invisible to cache invalidation.
   */
  it('covers every module Pass-1 extraction can reach', () => {
    const roots = __STAMP_ROOTS_FOR_TESTS.map(r => resolve(HERE, r));
    const covered = (file: string): boolean =>
      roots.some(root => file === root || file.startsWith(root + sep) || file.startsWith(root + '.'));

    const seen = new Set<string>();
    const uncovered: string[] = [];
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      if (!covered(file)) { uncovered.push(relative(HERE, file)); return; }
      let source: string;
      try { source = readFileSync(file, 'utf-8'); } catch { return; }
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), m[1].replace(/\.js$/, '.ts'));
        visit(target);
      }
    };
    visit(join(HERE, 'call-graph.ts'));

    expect(seen.size).toBeGreaterThan(5); // the walk actually walked
    expect(uncovered).toEqual([]);
  });

  /**
   * The grammar half of the stamp. A package that is installed but reports `absent` is worse
   * than useless: upgrading or removing it would not move the stamp, so its facts would be
   * served stale forever — and `web-tree-sitter` is exactly that case, because its `exports`
   * map forbids `require.resolve('web-tree-sitter/package.json')`.
   */
  it('resolves a real version for every grammar package that is actually installed', () => {
    const require = createRequire(import.meta.url);
    const names = __grammarPackageNamesForTests(HERE);
    expect(names).toContain('web-tree-sitter');
    expect(names).toContain('tree-sitter-wasms');

    const installed = names.filter(n => existsSync(join(REPO_ROOT, 'node_modules', n)));
    expect(installed.length).toBeGreaterThan(1);
    for (const name of installed) {
      expect(resolvePackageVersion(require, name), `${name} is installed but stamps as absent`)
        .toMatch(/^\d+\.\d+/);
    }
  });

  it('reports a genuinely missing package as absent rather than inventing a version', () => {
    const require = createRequire(import.meta.url);
    expect(resolvePackageVersion(require, 'tree-sitter-not-a-real-grammar')).toBeUndefined();
  });

  describe('the code digest under it', () => {
    /** A miniature "installation": a code root plus a nested module and some noise. */
    function plant(dir: string, extractorBody: string): void {
      mkdirSync(join(dir, 'analyzer', 'nested'), { recursive: true });
      mkdirSync(join(dir, 'analyzer', '__tests__'), { recursive: true });
      mkdirSync(join(dir, 'utils'), { recursive: true });
      writeFileSync(join(dir, 'analyzer', 'extract.ts'), extractorBody);
      writeFileSync(join(dir, 'analyzer', 'nested', 'deep.ts'), 'export const deep = 1;\n');
      writeFileSync(join(dir, 'analyzer', 'extract.test.ts'), 'it("x", () => {});\n');
      writeFileSync(join(dir, 'analyzer', 'extract.d.ts'), 'export declare const x: number;\n');
      writeFileSync(join(dir, 'analyzer', '__tests__', 'helper.ts'), 'export const h = 1;\n');
      writeFileSync(join(dir, 'utils', 'misc.ts'), 'export const m = 1;\n');
      writeFileSync(join(dir, 'constants.ts'), 'export const CAP = 8;\n');
    }

    const ROOTS = ['./analyzer', './utils', './constants'];
    let tmp: string;
    let twin: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'stamp-a-'));
      twin = mkdtempSync(join(tmpdir(), 'stamp-b-'));
      plant(tmp, 'export const version = 1;\n');
      plant(twin, 'export const version = 1;\n');
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(twin, { recursive: true, force: true });
    });

    it('is identical for the same code installed at a different location', () => {
      expect(digestStampRoots(tmp, ROOTS)).toBe(digestStampRoots(twin, ROOTS));
    });

    it('changes when any stamped module changes — extractor, nested, sibling root, or a file root', () => {
      const base = digestStampRoots(tmp, ROOTS);
      for (const [file, body] of [
        [join(tmp, 'analyzer', 'extract.ts'), 'export const version = 2;\n'],
        [join(tmp, 'analyzer', 'nested', 'deep.ts'), 'export const deep = 2;\n'],
        [join(tmp, 'utils', 'misc.ts'), 'export const m = 2;\n'],
        [join(tmp, 'constants.ts'), 'export const CAP = 9;\n'],
      ] as const) {
        const previous = readFileSync(file, 'utf-8');
        writeFileSync(file, body);
        expect(digestStampRoots(tmp, ROOTS), `${file} must move the stamp`).not.toBe(base);
        writeFileSync(file, previous);
      }
      expect(digestStampRoots(tmp, ROOTS)).toBe(base); // and restoring restores it
    });

    it('adding or removing a stamped module changes it', () => {
      const base = digestStampRoots(tmp, ROOTS);
      writeFileSync(join(tmp, 'analyzer', 'brand-new.ts'), 'export const n = 1;\n');
      const grown = digestStampRoots(tmp, ROOTS);
      expect(grown).not.toBe(base);
      rmSync(join(tmp, 'analyzer', 'brand-new.ts'));
      expect(digestStampRoots(tmp, ROOTS)).toBe(base);
    });

    it('ignores what cannot change extraction: tests, declarations, and test directories', () => {
      const base = digestStampRoots(tmp, ROOTS);
      writeFileSync(join(tmp, 'analyzer', 'extract.test.ts'), 'it("y", () => { expect(1).toBe(1); });\n');
      writeFileSync(join(tmp, 'analyzer', 'extract.d.ts'), 'export declare const x: string;\n');
      writeFileSync(join(tmp, 'analyzer', '__tests__', 'helper.ts'), 'export const h = 2;\n');
      writeFileSync(join(tmp, 'analyzer', 'notes.md'), '# not code\n');
      expect(digestStampRoots(tmp, ROOTS)).toBe(base);
    });

    it('an absent root contributes nothing rather than throwing', () => {
      expect(() => digestStampRoots(tmp, ['./nowhere'])).not.toThrow();
      expect(digestStampRoots(tmp, [...ROOTS, './nowhere'])).toBe(digestStampRoots(tmp, ROOTS));
    });
  });
});
