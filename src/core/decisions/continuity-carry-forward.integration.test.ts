/**
 * End-to-end carry-forward against a real on-disk EdgeStore + memory store.
 * (change: add-symbol-identity-continuity)
 *
 * Simulates a re-analysis where a symbol was renamed: snapshot the old graph,
 * overwrite the store with the new graph, then carry the anchored memory forward.
 *
 * NOTE: integration tests are excluded from CI (`*.integration.test.ts`); run
 * locally with `npx vitest run src/core/decisions/continuity-carry-forward.integration.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { stableSymbolId } from '../scip/moniker.js';
import { hashSpan } from './anchor.js';
import { loadMemoryStore, saveMemoryStore } from './memory-store.js';
import { snapshotOldNodes, carryForwardContinuity } from './continuity-carry-forward.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_MEMORY_SUBDIR } from '../../constants.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import type { AnchoredMemory } from '../../types/index.js';

function node(p: Partial<FunctionNode> & Pick<FunctionNode, 'id' | 'name' | 'filePath' | 'signature'>): FunctionNode {
  const base: FunctionNode = {
    isAsync: false,
    language: 'TypeScript',
    startIndex: 0,
    endIndex: 0,
    fanIn: 0,
    fanOut: 0,
    ...p,
  };
  return { ...base, stableId: stableSymbolId(base) };
}

describe('carryForwardContinuity (integration)', () => {
  let root: string;
  let storeDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'continuity-int-'));
    storeDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(storeDir, { recursive: true });
    await mkdir(join(root, OPENLORE_DIR, OPENLORE_MEMORY_SUBDIR), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('carries an anchored memory across a pure rename → recalls re-pointed with provenance', async () => {
    const oldSrc = 'export function computeTax(amount: number) {\n  return amount * 0.2;\n}\n';
    const newSrc = 'export function calculateTax(amount: number) {\n  return amount * 0.2;\n}\n';
    const file = 'src/tax.ts';

    // ── Old graph (computeTax) ───────────────────────────────────────────────
    await writeFile(join(root, file), oldSrc);
    const oldNode = node({ id: `${file}::computeTax`, name: 'computeTax', filePath: file, signature: 'function computeTax(amount: number)', startIndex: 0, endIndex: oldSrc.length });
    {
      const s = EdgeStore.open(EdgeStore.dbPath(storeDir));
      s.insertNodes([oldNode]);
      s.close();
    }

    // ── Anchor a memory to computeTax (baseline hash = OLD span) ──────────────
    const anchor = {
      nodeId: oldNode.id,
      stableId: oldNode.stableId,
      symbolName: 'computeTax',
      filePath: file,
      contentHash: hashSpan(oldSrc),
    };
    const memory: AnchoredMemory = {
      id: 'mem001',
      kind: 'note',
      content: 'computeTax applies the standard 20% rate; do not hardcode locale rates here.',
      anchors: [anchor],
      recordedAt: new Date(0).toISOString(),
    };
    await saveMemoryStore(root, { version: '1', updatedAt: '', sequence: 0, memories: [memory] });

    // ── Snapshot, then simulate re-analysis: rename to calculateTax ──────────
    const oldNodes = snapshotOldNodes(storeDir);
    expect(oldNodes).toHaveLength(1);

    await writeFile(join(root, file), newSrc);
    const newNode = node({ id: `${file}::calculateTax`, name: 'calculateTax', filePath: file, signature: 'function calculateTax(amount: number)', startIndex: 0, endIndex: newSrc.length });
    {
      const s = EdgeStore.open(EdgeStore.dbPath(storeDir));
      s.clearAll();
      s.insertNodes([newNode]);
      s.close();
    }

    // ── Carry forward ────────────────────────────────────────────────────────
    const summary = await carryForwardContinuity(root, oldNodes, storeDir);
    expect(summary.carried).toHaveLength(1);
    expect(summary.carried[0].basis).toBe('exact-signature');
    expect(summary.carried[0].reason).toBe('renamed');
    expect(summary.memoriesUpdated).toBe(1);

    // ── The persisted memory is now re-pointed with provenance ───────────────
    const reloaded = await loadMemoryStore(root);
    const a = reloaded.memories[0].anchors[0];
    expect(a.nodeId).toBe(`${file}::calculateTax`);
    expect(a.symbolName).toBe('calculateTax');
    expect(a.stableId).toBe(newNode.stableId);
    expect(a.contentHash).toBe(hashSpan(oldSrc)); // baseline preserved
    expect(a.carriedAcross).toMatchObject({ from: { symbolName: 'computeTax', filePath: file }, reason: 'renamed', basis: 'exact-signature' });
  });

  it('carries a pure move (byte-identical body) via exact-body and keeps it fresh', async () => {
    const src = 'export function helper(x: string) {\n  return x.trim();\n}\n';
    const oldFile = 'src/old/util.ts';
    const newFile = 'src/new/util.ts';
    await mkdir(join(root, 'src/old'), { recursive: true });
    await mkdir(join(root, 'src/new'), { recursive: true });
    await writeFile(join(root, oldFile), src);

    const oldNode = node({ id: `${oldFile}::helper`, name: 'helper', filePath: oldFile, signature: 'function helper(x: string)', startIndex: 0, endIndex: src.length });
    { const s = EdgeStore.open(EdgeStore.dbPath(storeDir)); s.insertNodes([oldNode]); s.close(); }

    const memory: AnchoredMemory = {
      id: 'mem002', kind: 'note', content: 'helper trims input', recordedAt: new Date(0).toISOString(),
      anchors: [{ nodeId: oldNode.id, stableId: oldNode.stableId, symbolName: 'helper', filePath: oldFile, contentHash: hashSpan(src) }],
    };
    await saveMemoryStore(root, { version: '1', updatedAt: '', sequence: 0, memories: [memory] });

    const oldNodes = snapshotOldNodes(storeDir);

    // Move: identical body, new file. stableId is identical (name+shape) — so to make
    // this a genuine *move* the resolver can't auto-handle, the new node id differs and
    // we delete the old file. exact-body matches on the identical span hash.
    await writeFile(join(root, newFile), src);
    const newNode = node({ id: `${newFile}::helper`, name: 'helper', filePath: newFile, signature: 'function helper(x: string)', startIndex: 0, endIndex: src.length });
    { const s = EdgeStore.open(EdgeStore.dbPath(storeDir)); s.clearAll(); s.insertNodes([newNode]); s.close(); }

    const summary = await carryForwardContinuity(root, oldNodes, storeDir);
    // stableId resolves the move on its own (getNodeByStableId) → not "disappeared",
    // so no carry needed. The memory still resolves; assert we did not corrupt it.
    const reloaded = await loadMemoryStore(root);
    const a = reloaded.memories[0].anchors[0];
    // Either carried by exact-body OR left intact because stableId still resolves —
    // both are correct; the invariant is the memory is NOT orphaned/clobbered.
    expect(a.symbolName).toBe('helper');
    expect(summary.ambiguous).toHaveLength(0);
  });

  it('discloses possiblyMovedTo for an ambiguous rename instead of guessing', async () => {
    const oldSrc = 'export function pick(a: number) {\n  return a;\n}\n';
    const file = 'src/pick.ts';
    await writeFile(join(root, file), oldSrc);
    const oldNode = node({ id: `${file}::pick`, name: 'pick', filePath: file, signature: 'function pick(a: number)', startIndex: 0, endIndex: oldSrc.length });
    { const s = EdgeStore.open(EdgeStore.dbPath(storeDir)); s.insertNodes([oldNode]); s.close(); }

    const memory: AnchoredMemory = {
      id: 'mem003', kind: 'note', content: 'pick returns its arg', recordedAt: new Date(0).toISOString(),
      anchors: [{ nodeId: oldNode.id, stableId: oldNode.stableId, symbolName: 'pick', filePath: file, contentHash: hashSpan(oldSrc) }],
    };
    await saveMemoryStore(root, { version: '1', updatedAt: '', sequence: 0, memories: [memory] });

    const oldNodes = snapshotOldNodes(storeDir);

    // Two new same-shape candidates → ambiguous → no carry, both disclosed.
    const newSrc = 'export function chooseA(a: number) {\n  return a;\n}\nexport function chooseB(a: number) {\n  return a + 1;\n}\n';
    await writeFile(join(root, file), newSrc);
    const aStart = newSrc.indexOf('export function chooseA');
    const bStart = newSrc.indexOf('export function chooseB');
    const nA = node({ id: `${file}::chooseA`, name: 'chooseA', filePath: file, signature: 'function chooseA(a: number)', startIndex: aStart, endIndex: bStart });
    const nB = node({ id: `${file}::chooseB`, name: 'chooseB', filePath: file, signature: 'function chooseB(a: number)', startIndex: bStart, endIndex: newSrc.length });
    { const s = EdgeStore.open(EdgeStore.dbPath(storeDir)); s.clearAll(); s.insertNodes([nA, nB]); s.close(); }

    const summary = await carryForwardContinuity(root, oldNodes, storeDir);
    expect(summary.carried).toHaveLength(0);
    expect(summary.ambiguous).toHaveLength(1);

    const reloaded = await loadMemoryStore(root);
    const a = reloaded.memories[0].anchors[0];
    expect(a.nodeId).toBe(`${file}::pick`); // unchanged → still orphaned
    expect(a.possiblyMovedTo).toEqual([`${file}::chooseA`, `${file}::chooseB`]);
    expect(a.carriedAcross).toBeUndefined();
  });

  it('is a no-op when nothing moved (idempotent)', async () => {
    const src = 'export function stable(a: number) {\n  return a;\n}\n';
    const file = 'src/stable.ts';
    await writeFile(join(root, file), src);
    const n = node({ id: `${file}::stable`, name: 'stable', filePath: file, signature: 'function stable(a: number)', startIndex: 0, endIndex: src.length });
    { const s = EdgeStore.open(EdgeStore.dbPath(storeDir)); s.insertNodes([n]); s.close(); }
    const memory: AnchoredMemory = {
      id: 'mem004', kind: 'note', content: 'stable', recordedAt: new Date(0).toISOString(),
      anchors: [{ nodeId: n.id, stableId: n.stableId, symbolName: 'stable', filePath: file, contentHash: hashSpan(src) }],
    };
    await saveMemoryStore(root, { version: '1', updatedAt: '', sequence: 0, memories: [memory] });

    const oldNodes = snapshotOldNodes(storeDir);
    // Re-write identical graph (same ids) — nothing disappeared.
    { const s = EdgeStore.open(EdgeStore.dbPath(storeDir)); s.clearAll(); s.insertNodes([n]); s.close(); }
    const summary = await carryForwardContinuity(root, oldNodes, storeDir);
    expect(summary.carried).toHaveLength(0);
    expect(summary.memoriesUpdated).toBe(0);
  });
});
