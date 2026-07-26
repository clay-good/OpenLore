/**
 * The end-to-end contract of the Pass-1 fact memo (change: optimize-hash-keyed-analyze),
 * exercised through the REAL analyze pipeline rather than the builder in isolation.
 *
 * The oracle is the one the proposal names: an analyze that reused memoized facts must
 * produce artifacts byte-identical to `analyze --force` on the same working tree. Everything
 * else here — the memo surviving the graph rebuild, deleted files leaving no rows, a stamp
 * change forcing a full re-extraction — is a way for that equality to fail LOUDLY instead of
 * silently, which is the only failure mode a cache is allowed to have.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore } from '../services/edge-store.js';
import { computeExtractorStamp } from './pass1-fact-cache.js';

/**
 * The artifact bytes that must not depend on which lane produced them. `parse-health.json` is
 * here deliberately: it is the memoized `parseHealth` payload, and the merge loop MUTATES it
 * (`result.parseHealth.language = file.language`) immediately after the row is recorded — so
 * it is the field most able to differ between a stored and a freshly-extracted answer.
 */
const ARTIFACTS = [
  'llm-context.json', 'repo-structure.json', 'style-fingerprint.json', 'parse-health.json',
] as const;

let dir: string;
let out: string;

/** A small but structurally real repo: cross-file calls, a test file, an unsupported file. */
async function plantRepo(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'core'), { recursive: true });
  await writeFile(join(root, 'src', 'core', 'math.ts'),
    'export function add(a: number, b: number): number {\n  if (a > b) { return a + b; }\n  return b + a;\n}\n' +
    'export function scale(n: number): number { return add(n, n); }\n');
  await writeFile(join(root, 'src', 'core', 'report.ts'),
    'import { scale } from "./math.js";\nexport class Report {\n  render(n: number): number { return scale(n) + 1; }\n}\n');
  await writeFile(join(root, 'src', 'app.ts'),
    'import { Report } from "./core/report.js";\nexport function main(): number { return new Report().render(2); }\n');
  await writeFile(join(root, 'src', 'app.test.ts'),
    'import { main } from "./app.js";\nimport { describe, it, expect } from "vitest";\ndescribe("app", () => { it("runs", () => { expect(main()).toBe(9); }); });\n');
  await writeFile(join(root, 'src', 'helper.py'),
    'def helper(x):\n    if x > 0:\n        return x\n    return -x\n');
  await writeFile(join(root, 'README.md'), '# fixture\n');
}

async function analyze(opts: { force?: boolean } = {}): Promise<void> {
  const { runAnalysis } = await import('../../cli/commands/analyze.js');
  await runAnalysis(dir, out, { maxFiles: 200, include: [], exclude: [], reExtract: opts.force ?? false });
}

/** The artifact bytes that must not depend on which lane produced them. */
async function artifactBytes(): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const name of ARTIFACTS) {
    snapshot[name] = await readFile(join(out, name), 'utf-8').catch(() => '<absent>');
  }
  return snapshot;
}

/**
 * The names of the functions the graph actually holds for one file. Asserted structurally
 * rather than by substring: a callee NAME appears in the graph whenever some other file calls
 * it, so `contains("scale")` would still pass with the defining file's facts wiped out.
 */
async function definedIn(fileSuffix: string): Promise<string[]> {
  const ctx = JSON.parse(await readFile(join(out, 'llm-context.json'), 'utf-8')) as {
    callGraph?: { nodes: Array<{ name: string; filePath: string; isExternal?: boolean }> };
  };
  return (ctx.callGraph?.nodes ?? [])
    .filter(n => !n.isExternal && n.filePath.replace(/\\/g, '/').endsWith(fileSuffix))
    .map(n => n.name)
    .sort();
}

/** The persisted CFG/def-use overlay, which no JSON artifact carries. */
function cfgOverlay(): Array<{ function_id: string; cfg: string }> {
  const store = EdgeStore.open(EdgeStore.dbPath(out));
  try {
    return (store as unknown as { db: { prepare(sql: string): { all(): unknown } } }).db
      .prepare('SELECT function_id, cfg FROM cfg_overlay ORDER BY function_id')
      .all() as Array<{ function_id: string; cfg: string }>;
  } finally {
    store.close();
  }
}

function memoRows(): Array<{ filePath: string; contentHash: string; stamp: string }> {
  const store = EdgeStore.open(EdgeStore.dbPath(out));
  try {
    return store.listPass1FactKeys();
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hash-keyed-analyze-'));
  out = join(dir, '.openlore', 'analysis');
  await plantRepo(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('analyze cost scales with the diff', () => {
  it('populates the memo on the first run and keeps it across the graph rebuild', async () => {
    await analyze();
    const first = memoRows();
    // Every call-graph-bearing file is memoized (README.md is never handed to the builder).
    expect(first.map(r => r.filePath).some(p => p.endsWith('math.ts'))).toBe(true);
    expect(first.map(r => r.filePath).some(p => p.endsWith('helper.py'))).toBe(true);
    expect(first.map(r => r.filePath).some(p => p.endsWith('README.md'))).toBe(false);
    expect(first.every(r => r.stamp === computeExtractorStamp())).toBe(true);

    // The second analyze runs a FULL graph rebuild (clearAll) — the memo must survive it.
    await writeFile(join(dir, 'src', 'app.ts'),
      'import { Report } from "./core/report.js";\nexport function main(): number { return new Report().render(3); }\n');
    await analyze();
    expect(memoRows().map(r => r.filePath)).toEqual(first.map(r => r.filePath));
  });

  it('a reused-lane analyze is byte-identical to --force on the same tree', async () => {
    await analyze();
    await writeFile(join(dir, 'src', 'core', 'math.ts'),
      'export function add(a: number, b: number): number {\n  if (a > b) { return a + b; }\n  return b + a;\n}\n' +
      'export function scale(n: number): number { return add(n, n) * 2; }\n' +
      'export function shrink(n: number): number { return add(n, -n); }\n');

    await analyze();                       // the reused lane: one file re-extracted
    const reused = await artifactBytes();
    const reusedOverlay = cfgOverlay();

    await analyze({ force: true });        // the reference lane: everything re-extracted
    const forced = await artifactBytes();
    const forcedOverlay = cfgOverlay();

    for (const name of ARTIFACTS) {
      expect(reused[name], `${name} differs between the reused and forced lanes`).toBe(forced[name]);
    }
    // The CFG overlay lives only in SQLite, never in a JSON artifact — and it is the one
    // memoized field with a non-trivial encoding (a `Map`, round-tripped as array-of-entries),
    // so the JSON comparison above would miss a serialization bug in it entirely.
    expect(reusedOverlay).toEqual(forcedOverlay);
    expect(reusedOverlay.length).toBeGreaterThan(0);
    // …and the edit really landed, so the equality above is not comparing two stale files.
    expect(await definedIn('src/core/math.ts')).toEqual(['add', 'scale', 'shrink']);
  });

  it('an added and a deleted file both land, and the deleted one leaves no memo row', async () => {
    await analyze();

    await writeFile(join(dir, 'src', 'extra.ts'),
      'import { add } from "./core/math.js";\nexport function extra(): number { return add(1, 2); }\n');
    await rm(join(dir, 'src', 'core', 'report.ts'));
    await writeFile(join(dir, 'src', 'app.ts'), 'export function main(): number { return 0; }\n');

    await analyze();
    const paths = memoRows().map(r => r.filePath);
    expect(paths.some(p => p.endsWith('extra.ts'))).toBe(true);
    expect(paths.some(p => p.endsWith('report.ts'))).toBe(false);

    // No ghost: the deleted file contributes no symbols; the added one does.
    expect(await definedIn('src/core/report.ts')).toEqual([]);
    expect(await definedIn('src/extra.ts')).toEqual(['extra']);

    const reused = await artifactBytes();
    await analyze({ force: true });
    expect(reused).toEqual(await artifactBytes());
  });

  it('a stamp change re-extracts everything rather than serving foreign rows', async () => {
    await analyze();
    const before = memoRows();
    expect(before.length).toBeGreaterThan(0);

    // Simulate an OpenLore whose extraction code changed: re-stamp every row, then analyze.
    const store = EdgeStore.openForAnalyze(EdgeStore.dbPath(out));
    try {
      store.putPass1Facts(
        before.map(r => ({ filePath: r.filePath, contentHash: r.contentHash, facts: '{"v":1,"n":[],"e":[]}' })),
        'a-stamp-from-a-different-openlore',
      );
    } finally {
      store.close();
    }

    await analyze();
    // Had the foreign rows been served, math.ts would have contributed no symbols at all.
    expect(await definedIn('src/core/math.ts')).toEqual(['add', 'scale']);
    expect(memoRows().every(r => r.stamp === computeExtractorStamp())).toBe(true);
  });

  /**
   * The watcher patches the graph per file and never touches the memo, which raises the
   * question this pins: after a daemon has patched the store for an edit it saw, does a later
   * batch analyze still converge on the same artifacts a clean run would produce? It must —
   * the memo is keyed by the file's CURRENT bytes, so a patched file misses and re-extracts,
   * and the graph is rebuilt from the merged facts either way.
   */
  it('converges with a graph a watcher has already patched', async () => {
    await analyze();

    // Stand in for the watcher's per-file patch: rewrite the graph rows for one file, as a
    // daemon would after seeing it change, and mark the file's new content hash.
    const edited =
      'export function add(a: number, b: number): number { return a + b; }\n' +
      'export function scale(n: number): number { return add(n, n); }\n' +
      'export function patched(n: number): number { return scale(n); }\n';
    await writeFile(join(dir, 'src', 'core', 'math.ts'), edited);
    const store = EdgeStore.openForAnalyze(EdgeStore.dbPath(out));
    try {
      store.deleteNodesForFile('src/core/math.ts');
      store.setFileHash('src/core/math.ts', 'whatever-the-watcher-computed');
    } finally {
      store.close();
    }

    await analyze();
    const reused = await artifactBytes();
    await analyze({ force: true });
    expect(reused).toEqual(await artifactBytes());
    expect(await definedIn('src/core/math.ts')).toEqual(['add', 'patched', 'scale']);
  });

  /**
   * Every store built by the currently-released OpenLore lacks the memo table, as does one
   * materialized from a bundle (export strips it). That is a whole-store condition, and it
   * must be NAMED once — not rediscovered as a swallowed error per file, and never reported
   * as a bare "reused 0" the operator cannot distinguish from a broken cache.
   */
  it('names an index that carries no memo yet, instead of a bare "reused 0"', async () => {
    await analyze();
    const store = EdgeStore.openForAnalyze(EdgeStore.dbPath(out));
    try {
      (store as unknown as { db: { exec(sql: string): void } }).db.exec('DROP TABLE pass1_facts');
    } finally {
      store.close();
    }

    const { runAnalysis } = await import('../../cli/commands/analyze.js');
    const result = await runAnalysis(dir, out, { maxFiles: 200, include: [], exclude: [] });
    expect(result.artifacts.pass1CacheNote).toContain('reused 0 cached');
    expect(result.artifacts.pass1CacheNote).toContain('carries no extraction cache yet');

    // …and the run leaves the memo behind, so the next one is cheap.
    expect(memoRows().length).toBeGreaterThan(0);
    const next = await runAnalysis(dir, out, { maxFiles: 200, include: [], exclude: [] });
    expect(next.artifacts.pass1CacheNote).toMatch(/re-extracted 0 file\(s\), reused \d+ cached$/);
  });

  it('a hostile memo row for an UNCHANGED file cannot be served under the real key', async () => {
    await analyze();
    const rows = memoRows();
    const target = rows.find(r => r.filePath.endsWith('math.ts'))!;

    // Poison the row under a content hash that does NOT match the file on disk. A correct
    // implementation misses on the key and re-extracts; a path-keyed one would serve it.
    const store = EdgeStore.openForAnalyze(EdgeStore.dbPath(out));
    try {
      store.putPass1Facts(
        [{ filePath: target.filePath, contentHash: 'not-the-hash-of-anything', facts: '{"v":1,"n":[],"e":[]}' }],
        computeExtractorStamp(),
      );
    } finally {
      store.close();
    }

    await analyze();
    expect(await definedIn('src/core/math.ts')).toEqual(['add', 'scale']);
  });
});
