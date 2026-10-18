/**
 * Property-based fuzzing for pushed-memory triggers in
 * `src/core/services/mcp-handlers/memory-triggers.ts`.
 *
 * `notes.json` is committed repo content, so every store entry, trigger and anchor is untrusted.
 * Invariants: selection never throws on arbitrary JSON; every pushed receipt is bounded and never
 * orphaned; the output does not depend on store order; the small glob matcher and the shared hop
 * walk agree with brute-force references; the trigger validator accepts exactly the closed union.
 */
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import {
  validateMemoryTrigger, matchGlob, makeHopProbe, selectInjectedMemories, injectionFields,
} from '../core/services/mcp-handlers/memory-triggers.js';

// Brute-force glob: `**` segment spans segments, `*` any run and `?` one char within a segment.
const refSeg = (p: string, t: string): boolean =>
  p === '' ? t === '' : p[0] === '*' ? [...Array(t.length + 1).keys()].some(i => refSeg(p.slice(1), t.slice(i)))
    : t !== '' && (p[0] === '?' || p[0] === t[0]) && refSeg(p.slice(1), t.slice(1));
const refGlob = (ps: string[], ts: string[]): boolean =>
  ps.length === 0 ? ts.length === 0 : ps[0] === '**' ? [...Array(ts.length + 1).keys()].some(i => refGlob(ps.slice(1), ts.slice(i)))
    : ts.length > 0 && refSeg(ps[0], ts[0]) && refGlob(ps.slice(1), ts.slice(1));
const str = (chars: string[], max: number) => fc.array(fc.constantFrom(...chars), { maxLength: max }).map(a => a.join(''));

// Untrusted values, including shapes JSON.parse yields that break naive coercion.
const junk = fc.oneof(fc.jsonValue(), fc.constant(JSON.parse('{"toString":1}')), fc.integer());
const NODES = ['n1', 'n2', 'n3'];
const view = {
  nodeHash: (id: string) => (NODES.includes(id) ? 'h' : undefined),
  fileExists: (f: string) => f.startsWith('src/'),
  fileHash: () => undefined,
};
const anchor = fc.record({
  filePath: fc.constantFrom('src/a.ts', 'gone.ts'),
  nodeId: fc.oneof({ weight: 9, arbitrary: fc.constantFrom(...NODES) }, junk), contentHash: fc.oneof({ weight: 4, arbitrary: fc.constant('h') }, junk),
  stableId: fc.oneof({ weight: 9, arbitrary: fc.constant('S') }, junk), symbolName: junk, possiblyMovedTo: fc.array(fc.oneof(fc.string({ maxLength: 300 }), junk), { maxLength: 8 }),
}, { requiredKeys: ['filePath'] });
const memory = (id: string) => fc.record({
  id: fc.constant(id), content: fc.oneof({ weight: 6, arbitrary: fc.string({ maxLength: 1200 }) }, fc.constant('?key=12345678 '.repeat(80)), junk),
  anchors: fc.oneof({ weight: 6, arbitrary: fc.array(anchor, { maxLength: 3 }) }, { weight: 1, arbitrary: junk }),
  trigger: fc.oneof(fc.constantFrom({ fileGlob: 'src/**' }, { symbolPattern: 'f*' }, { specDomain: 'd' }, { withinHops: 2 }), junk),
  pinned: fc.oneof({ weight: 4, arbitrary: fc.boolean() }, junk), recordedAt: junk, type: junk,
  invalidatedAt: fc.oneof({ weight: 5, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: junk }),
}, { requiredKeys: ['id'] });
const store = fc.uniqueArray(fc.stringMatching(/^[\w-]{1,4}$/), { maxLength: 30 })
  .chain(ids => fc.tuple(...ids.map(memory)) as fc.Arbitrary<unknown[]>);
const touched = { files: ['src/a.ts'], symbols: [{ id: 'n1', name: 'foo' }], domains: ['d'] };
const graph: Record<string, string[]> = { n1: ['n2'], n2: ['n3', 'n1'], n3: [] };
const traversal = { hasNode: (id: string) => id in graph, neighborIds: (id: string) => graph[id] ?? [] } as never;
const select = (mems: unknown[]) => selectInjectedMemories(mems as never, touched, view as never,
  { includePinned: true, probe: makeHopProbe(traversal, touched.symbols, 2) });

describe('memory triggers (fuzz)', () => {
  it('validateMemoryTrigger accepts exactly the closed union', () => {
    const accepts = (raw: unknown): boolean => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1) return false;
      const [k, v] = Object.entries(raw)[0];
      if (k === 'withinHops') return Number.isInteger(v) && v >= 1 && v <= 20;
      if (!['fileGlob', 'symbolPattern', 'specDomain'].includes(k) || typeof v !== 'string') return false;
      if (!v.trim() || v.length > 256 || /[\r\n]/.test(v)) return false;
      return k === 'specDomain' || !(/\{[^}]*,[^}]*\}/.test(v) || v.trim().startsWith('!'));
    };
    let ok = 0;
    const key = fc.constantFrom('fileGlob', 'symbolPattern', 'specDomain', 'withinHops', 'x');
    const val = fc.oneof(fc.string({ maxLength: 260 }), fc.integer({ min: -1, max: 22 }), fc.double(), junk);
    fc.assert(fc.property(fc.oneof(fc.anything(), fc.dictionary(key, val, { maxKeys: 2 }),
      { weight: 4, arbitrary: fc.tuple(key, val).map(([k, v]) => ({ [k]: v })) }), (raw) => {
      const r = validateMemoryTrigger(raw);
      if ('trigger' in r) ok++;
      expect('trigger' in r).toBe(accepts(raw));
    }), { numRuns: 3000 });
    expect(ok).toBeGreaterThan(300); // non-vacuity: the accept path fires
  });

  it('matchGlob agrees with a brute-force reference (a literal * or ? in the path included)', () => {
    let hits = 0;
    fc.assert(fc.property(str(['a', 'b', '/', '*', '?', '['], 9), str(['a', 'b', '/', '*', '?'], 9), (p, t) => {
      const want = refGlob(p.split('/'), t.split('/'));
      if (want) hits++;
      expect(matchGlob(p, t)).toBe(want);
    }), { numRuns: 20000 });
    expect(hits).toBeGreaterThan(500);
  });

  it('makeHopProbe agrees with per-source BFS on random cyclic graphs', () => {
    const id = fc.nat(7).map(i => `v${i}`);
    let hits = 0;
    fc.assert(fc.property(fc.array(fc.tuple(id, id), { maxLength: 24 }),
      fc.array(fc.record({ id, name: fc.constantFrom('a', 'b', 'c') }), { maxLength: 4 }),
      fc.integer({ min: -1, max: 22 }), fc.nat(22), fc.array(id, { maxLength: 4 }), (edges, src, maxHops, hops, anchors) => {
        const adj: Record<string, string[]> = {};
        for (const [a, b] of edges) {
          const out = (adj[a] ??= []);
          if (!out.includes(b)) out.push(b);
        }
        const t = { hasNode: (n: string) => n in adj, neighborIds: (n: string) => adj[n] ?? [] } as never;
        const cap = Math.min(Math.max(0, maxHops), 20, hops);
        let best: { matched: string; distance: number } | undefined;
        for (const s of src.filter(s => s.id in adj)) {
          const dist = new Map([[s.id, 0]]);
          for (const q = [s.id]; q.length;) { const u = q.shift()!; for (const v of adj[u] ?? []) if (!dist.has(v)) { dist.set(v, dist.get(u)! + 1); q.push(v); } }
          for (const a of anchors) {
            const d = dist.get(a);
            if (d !== undefined && d <= cap && (!best || d < best.distance || (d === best.distance && s.name < best.matched))) best = { matched: s.name, distance: d };
          }
        }
        if (best) hits++;
        expect(makeHopProbe(t, src, maxHops)(anchors, hops)).toEqual(best);
      }), { numRuns: 5000 });
    expect(hits).toBeGreaterThan(500);
  });

  it('selection never throws, stays bounded, and ignores store order', () => {
    let pushed = 0;
    fc.assert(fc.property(store, fc.integer(), (mems, seed) => {
      const a = select(mems);
      const b = select([...mems].map((m, i) => ({ m, k: (i * 7919 + seed) % 101 })).sort((x, y) => x.k - y.k).map(x => x.m));
      expect(b.injected.map(m => m.id)).toEqual(a.injected.map(m => m.id));
      expect(b.stale.map(m => m.id)).toEqual(a.stale.map(m => m.id));
      expect(a.injected.length).toBeLessThanOrEqual(10);
      expect(a.stale.length).toBeLessThanOrEqual(10);
      for (const m of [...a.injected, ...a.stale]) {
        expect(m.id).toMatch(/^[\w-]{1,64}$/);
        expect(m.anchors.length).toBeLessThanOrEqual(5);
        for (const x of m.anchors) for (const s of x.possiblyMovedTo ?? []) expect(s.length).toBeLessThanOrEqual(256);
      }
      for (const m of a.injected) {
        pushed++;
        expect(m.freshness).not.toBe('orphaned');
        expect((m.content ?? '').length).toBeLessThanOrEqual(1000);
        expect((m.unreconciledWith ?? []).length).toBeLessThanOrEqual(10);
      }
      expect(() => JSON.stringify(injectionFields(a))).not.toThrow();
    }), { numRuns: 1500 });
    expect(pushed).toBeGreaterThan(1000);
  });
});
