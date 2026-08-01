/**
 * Incremental BM25 corpus patching (change: bulletproof-background-index).
 *
 * The cached corpus used to be rebuilt with `buildBm25Corpus` over every kept row on each
 * incremental update — re-tokenizing the whole repository's symbol text to absorb one saved file.
 * The watcher is meant to be always on, so that cost landed on every keystroke-save and scaled with
 * the repository rather than with the edit.
 *
 * Patching it incrementally is only acceptable if it is EXACTLY what a rebuild would have produced.
 * A corpus that drifts from the rebuild would change search ranking silently and progressively, in
 * a way no user could attribute to the watcher — strictly worse than being slow. So the test here
 * is a differential oracle against `buildBm25Corpus` itself, not a set of hand-written
 * expectations: whatever the rebuild says is the answer, the patch must say the same thing.
 */
import { describe, it, expect } from 'vitest';

import {
  buildBm25Corpus,
  tokenize,
  _patchBm25CorpusForTesting,
  type Bm25Corpus,
} from './vector-index.js';

/** A comparable, order-independent snapshot of everything a score can depend on. */
function snapshot(c: Bm25Corpus): unknown {
  return {
    N: c.N,
    avgLength: c.avgLength,
    df: [...c.df].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    docs: [...c.docs]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(d => ({
        id: d.id,
        length: d.length,
        tf: [...d.tfMap].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      })),
  };
}

type Row = { id: string; filePath: string; text: string };

const row = (filePath: string, symbol: string, text: string): Row => ({
  id: `${filePath}::${symbol}`,
  filePath,
  text,
});

/** Apply the patch to a corpus built from `before`, and rebuild from the same end state. */
function bothWays(before: Row[], changedFiles: string[], added: Row[]) {
  const corpus = buildBm25Corpus(before.map(r => ({ id: r.id, text: r.text })));
  const patched = _patchBm25CorpusForTesting(corpus, before, new Set(changedFiles), added);

  const kept = before.filter(r => !changedFiles.includes(r.filePath));
  const endState = [...kept, ...added];
  const rebuilt = buildBm25Corpus(endState.map(r => ({ id: r.id, text: r.text })));

  return { patched: patched.corpus, rebuilt, patchedRows: patched.rows, endState };
}

const BASE: Row[] = [
  row('a.ts', 'parseConfig', 'export function parseConfig(raw: string) { return JSON.parse(raw); }'),
  row('a.ts', 'writeConfig', 'export function writeConfig(cfg: Config) { save(cfg); }'),
  row('b.ts', 'resolveCallSite', 'function resolveCallSite(node: Node) { return node.callee; }'),
  row('c.ts', 'shared', 'const shared = parseConfig(raw); // parse parse parse'),
  row('d.ts', 'lonely', 'export const uniquetokenhere = 1;'),
];

describe('patchBm25Cache — identical to a full rebuild', () => {
  it('replacing a file that shares tokens with others', async () => {
    const { patched, rebuilt } = bothWays(BASE, ['a.ts'], [
      row('a.ts', 'parseConfig', 'export function parseConfig(raw: string) { return YAML.parse(raw); }'),
    ]);
    expect(snapshot(patched)).toEqual(snapshot(rebuilt));
  });

  it('deleting a file whose tokens appear nowhere else drops them from df entirely', async () => {
    // The token only that file carried must disappear, not linger at df 0 — a stale zero entry
    // would change the idf of nothing but would make the corpus differ from a rebuild, which is
    // the drift this whole design forbids.
    const { patched, rebuilt } = bothWays(BASE, ['d.ts'], []);
    expect(patched.df.has('uniquetokenhere')).toBe(false);
    expect(snapshot(patched)).toEqual(snapshot(rebuilt));
  });

  it('deleting a file whose tokens are SHARED leaves them in df with a smaller count', async () => {
    // `parse` appears in a.ts and c.ts. Removing a.ts must decrement it, not delete it — a
    // decrement-to-delete bug is invisible in the single-owner case above.
    const before = buildBm25Corpus(BASE.map(r => ({ id: r.id, text: r.text })));
    const dfBefore = before.df.get('parse') ?? 0;
    expect(dfBefore, 'fixture must share this token across files').toBeGreaterThan(1);

    const { patched, rebuilt } = bothWays(BASE, ['a.ts'], []);
    expect(patched.df.get('parse')).toBe(rebuilt.df.get('parse'));
    expect(patched.df.get('parse')).toBeGreaterThan(0);
    expect(snapshot(patched)).toEqual(snapshot(rebuilt));
  });

  it('adding a brand-new file', async () => {
    const { patched, rebuilt } = bothWays(BASE, [], [
      row('e.ts', 'brandNew', 'export function brandNew() { return parseConfig(); }'),
    ]);
    expect(snapshot(patched)).toEqual(snapshot(rebuilt));
  });

  it('one file whose several symbols change at once', async () => {
    // A file contributes MANY docs. Removing it must remove all of them, and df must be
    // decremented once per doc — a token in three of that file's symbols is worth three.
    const { patched, rebuilt } = bothWays(BASE, ['a.ts'], [
      row('a.ts', 'x', 'export function x() { return 1; }'),
      row('a.ts', 'y', 'export function y() { return 2; }'),
      row('a.ts', 'z', 'export function z() { return 3; }'),
    ]);
    expect(snapshot(patched)).toEqual(snapshot(rebuilt));
  });

  it('emptying the corpus completely', async () => {
    const { patched, rebuilt } = bothWays(BASE, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], []);
    expect(patched.N).toBe(0);
    expect(patched.df.size).toBe(0);
    expect(snapshot(patched)).toEqual(snapshot(rebuilt));
  });

  it('survives a long run of edits without drifting from a rebuild', async () => {
    // The real hazard is not one patch but a thousand. Any per-patch error — an off-by-one in df,
    // a length not subtracted — accumulates silently across a day of editing. Chain the patches,
    // then compare once at the end against a rebuild of the final state.
    let rows: Row[] = [...BASE];
    let corpus = buildBm25Corpus(rows.map(r => ({ id: r.id, text: r.text })));

    for (let i = 0; i < 60; i++) {
      const file = ['a.ts', 'b.ts', 'c.ts', 'new.ts'][i % 4];
      const added = i % 7 === 0
        ? [] // a deletion round
        : [row(file, `sym${i % 3}`, `export function sym${i % 3}() { return parseConfig(${i}); }`)];
      const patched = _patchBm25CorpusForTesting(corpus, rows, new Set([file]), added);
      corpus = patched.corpus;
      rows = patched.rows as Row[];
    }

    const rebuilt = buildBm25Corpus(rows.map(r => ({ id: r.id, text: r.text })));
    expect(snapshot(corpus), 'the corpus drifted from a rebuild over 60 edits').toEqual(snapshot(rebuilt));
  });

  it('does not re-tokenize the rows it kept', async () => {
    // The whole point. If surviving docs are re-tokenized, the work is still O(repository) and the
    // watcher cost is unchanged even though every equivalence assertion above still passes.
    const before = buildBm25Corpus(BASE.map(r => ({ id: r.id, text: r.text })));
    const survivor = before.docs.find(d => d.id === 'b.ts::resolveCallSite');
    expect(survivor).toBeDefined();

    const patched = _patchBm25CorpusForTesting(before, BASE, new Set(['a.ts']), []);
    const after = patched.corpus.docs.find(d => d.id === 'b.ts::resolveCallSite');
    // Same object identity: it was carried over, not rebuilt from its text.
    expect(after, 'a surviving doc was re-tokenized instead of carried over').toBe(survivor);
  });

  it('tokenizes added rows with the SAME tokenizer the rebuild uses', async () => {
    // Guards the one asymmetry the oracle cannot catch on its own: if the patch used a different
    // splitting rule, every comparison above would compare two identically-wrong corpora.
    const text = 'export function parseConfigValue(rawInput: string) {}';
    const patched = _patchBm25CorpusForTesting(
      buildBm25Corpus([]), [], new Set(), [row('n.ts', 'n', text)]
    );
    const doc = patched.corpus.docs[0];
    expect(doc.length).toBe(tokenize(text).length);
    expect([...doc.tfMap.keys()].sort()).toEqual([...new Set(tokenize(text))].sort());
  });
});
