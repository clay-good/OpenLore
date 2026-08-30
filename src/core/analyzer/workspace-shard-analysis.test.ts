import { mkdir, mkdtemp, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EdgeStore } from '../services/edge-store.js';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { writeEdgesToSQLite } from './artifact-generator.js';
import {
  MAX_SHARD_RECEIPT_BYTES,
  readPriorShardReceipt,
  runShardScopedAnalysis,
  serializeShardReceipt,
  type ShardScopedAnalysisReceipt,
} from './workspace-shard-analysis.js';
import { detectWorkspaceShards } from './workspace-shards.js';

async function createRepo(sources: Record<string, string>): Promise<{ root: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-shard-analysis-'));
  const output = join(root, '.openlore', 'analysis');
  await mkdir(output, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  for (const [path, source] of Object.entries(sources)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), source);
    await writeFile(join(root, path.split('/').slice(0, 2).join('/'), 'package.json'), JSON.stringify({ name: path.split('/')[1] }));
  }
  return { root, output };
}

async function fullGraph(root: string, sources: Record<string, string>) {
  return new CallGraphBuilder().build(Object.entries(sources).map(([path, content]) => ({
    path, content, language: 'TypeScript',
  })));
}

async function seed(root: string, output: string, sources: Record<string, string>): Promise<void> {
  const graph = await fullGraph(root, sources);
  await writeEdgesToSQLite(serializeCallGraph(graph), EdgeStore.dbPath(output), root);
  const store = EdgeStore.open(EdgeStore.dbPath(output));
  try {
    const { createHash } = await import('node:crypto');
    for (const [path, content] of Object.entries(sources)) {
      store.setFileHash(path, createHash('sha256').update(content).digest('hex'));
    }
  } finally { store.close(); }
}

function edgeKey(edge: { callerId: string; calleeId: string; confidence: string }): string {
  return `${edge.callerId}->${edge.calleeId}:${edge.confidence}`;
}

describe('runShardScopedAnalysis', () => {
  it('rebinds an outside external consumer and preserves an untouched shard', async () => {
    const before = {
      'packages/a/a.ts': 'export function existing() { return 1 }',
      'packages/b/b.ts': 'export function consume() { return newlyAdded() }',
      'packages/c/c.ts': 'export function untouched() { return 3 }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const after = { ...before, 'packages/a/a.ts': `${before['packages/a/a.ts']}\nexport function newlyAdded() { return 2 }` };
    await writeFile(join(root, 'packages/a/a.ts'), after['packages/a/a.ts']);
    const files = ['package.json', ...Object.keys(after), 'packages/a/package.json', 'packages/b/package.json', 'packages/c/package.json'];
    const report = await detectWorkspaceShards(root, files);

    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const expected = await fullGraph(root, after);
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(receipt.frontierFiles).toContain('packages/b/b.ts');
      expect(store.getNode('packages/c/c.ts::untouched')).not.toBeNull();
      expect(store.getAllEdges().map(edgeKey)).toContain('packages/b/b.ts::consume->packages/a/a.ts::newlyAdded:name_only');
      expect(store.getNode('external::newlyAdded')).toBeNull();
      expect(store.getAllInternalNodes().map(node => node.id).sort())
        .toEqual([...expected.nodes.values()].filter(node => !node.isTest).map(node => node.id).sort());
    } finally { store.close(); }
  });

  it('matches a full rebuild when a newly-added duplicate makes an outside name-only call ambiguous', async () => {
    const before = {
      'packages/a/a.ts': 'export function onlyA() { return 1 }',
      'packages/b/b.ts': 'export function consume() { return duplicate() }',
      'packages/c/c.ts': 'export function duplicate() { return 3 }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const after = { ...before, 'packages/a/a.ts': `${before['packages/a/a.ts']}\nexport function duplicate() { return 2 }` };
    await writeFile(join(root, 'packages/a/a.ts'), after['packages/a/a.ts']);
    const files = ['package.json', ...Object.keys(after), 'packages/a/package.json', 'packages/b/package.json', 'packages/c/package.json'];
    const report = await detectWorkspaceShards(root, files);

    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const expected = await fullGraph(root, after);
    const expectedConsumer = expected.edges.filter(edge => edge.callerId === 'packages/b/b.ts::consume').map(edgeKey).sort();
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      const actualConsumer = store.getAllEdges().filter(edge => edge.callerId === 'packages/b/b.ts::consume').map(edgeKey).sort();
      expect(receipt.frontierFiles).toContain('packages/b/b.ts');
      expect(actualConsumer).toEqual(expectedConsumer);
      expect(store.getNode('packages/c/c.ts::duplicate')).not.toBeNull();
    } finally { store.close(); }
  });

  it('detects multiplicity changes even when the selected shard already defined that name', async () => {
    const before = {
      'packages/a/a.ts': 'export function duplicate() { return 1 }',
      'packages/a/second.ts': 'export function other() { return 2 }',
      'packages/b/b.ts': 'export function consume() { return duplicate() }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const after = { ...before, 'packages/a/second.ts': 'export function duplicate() { return 2 }' };
    await writeFile(join(root, 'packages/a/second.ts'), after['packages/a/second.ts']);
    const files = ['package.json', ...Object.keys(after), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const expected = await fullGraph(root, after);
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(receipt.frontierFiles).toContain('packages/b/b.ts');
      expect(store.getAllEdges().filter(edge => edge.callerId === 'packages/b/b.ts::consume').map(edgeKey).sort())
        .toEqual(expected.edges.filter(edge => edge.callerId === 'packages/b/b.ts::consume').map(edgeKey).sort());
    } finally { store.close(); }
  });

  it('re-resolves an ambiguous outside call when a selected definition is removed', async () => {
    const before = {
      'packages/a/a.ts': 'export function duplicate() { return 1 }',
      'packages/b/b.ts': 'export function consume() { return duplicate() }',
      'packages/c/c.ts': 'export function duplicate() { return 3 }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const after = { ...before, 'packages/a/a.ts': 'export function replacement() { return 1 }' };
    await writeFile(join(root, 'packages/a/a.ts'), after['packages/a/a.ts']);
    const files = ['package.json', ...Object.keys(after), 'packages/a/package.json', 'packages/b/package.json', 'packages/c/package.json'];
    const report = await detectWorkspaceShards(root, files);

    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(receipt.frontierFiles).toContain('packages/b/b.ts');
      expect(store.getAllEdges().map(edgeKey)).toContain('packages/b/b.ts::consume->packages/c/c.ts::duplicate:name_only');
    } finally { store.close(); }
  });

  it('marks a bounded-out frontier stale instead of silently claiming convergence', async () => {
    const before = {
      'packages/a/a.ts': 'export function target() { return 1 }',
      'packages/b/b.ts': 'export function b() { return target() }',
      'packages/c/c.ts': 'export function c() { return target() }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    await writeFile(join(root, 'packages/a/a.ts'), 'export function target() { return 2 }');
    const files = ['package.json', ...Object.keys(before), 'packages/a/package.json', 'packages/b/package.json', 'packages/c/package.json'];
    const report = await detectWorkspaceShards(root, files);
    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'], closureBudget: 1 });
    expect(receipt.frontierFiles).toHaveLength(2);
    expect(receipt.staleFiles).toHaveLength(1);
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try { expect(store.getStaleFiles()).toEqual(receipt.staleFiles); }
    finally { store.close(); }
  });

  it('does not mix new frontier edges with old nodes when a retained frontier file also changed', async () => {
    const before = {
      'packages/a/a.ts': 'export function existing() { return 1 }',
      'packages/b/b.ts': 'export function consume() { return newlyAdded() }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    await writeFile(join(root, 'packages/a/a.ts'), `${before['packages/a/a.ts']}\nexport function newlyAdded() { return 2 }`);
    await writeFile(join(root, 'packages/b/b.ts'), `${before['packages/b/b.ts']}\n// unrelated retained-shard edit`);
    const files = ['package.json', ...Object.keys(before), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);
    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    expect(receipt.staleFiles).toContain('packages/b/b.ts');
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try { expect(store.getStaleFiles()).toContain('packages/b/b.ts'); }
    finally { store.close(); }
  });

  it('preserves cross-shard inheritance and removes it when the selected class is replaced', async () => {
    const before = {
      'packages/a/a.ts': 'export class Child extends Base { shared() { return 1 } }',
      'packages/b/b.ts': 'export class Base { shared() { return 1 } }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const files = ['package.json', ...Object.keys(before), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    let store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(store.getAllInheritanceEdges().map(edge => `${edge.parentId}->${edge.childId}`))
        .toContain('packages/b/b.ts::Base->packages/a/a.ts::Child');
      expect(store.getAllInheritanceEdges().some(edge => edge.kind === 'overrides')).toBe(true);
    } finally { store.close(); }

    await writeFile(join(root, 'packages/a/a.ts'), 'export class Replacement { run() { return 1 } }');
    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      const classIds = new Set(store.getAllClasses().map(cls => cls.id));
      expect(store.getAllInheritanceEdges()).toEqual([]);
      expect(store.getAllInheritanceEdges().every(edge => classIds.has(edge.parentId) && classIds.has(edge.childId))).toBe(true);
    } finally { store.close(); }
  });

  it('recomputes retained-child overrides when a selected parent method changes', async () => {
    const before = {
      'packages/a/a.ts': 'export class Child extends Base { shared() { return 1 } }',
      'packages/b/b.ts': 'export class Base { other() { return 1 } }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const files = ['package.json', ...Object.keys(before), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    await writeFile(join(root, 'packages/b/b.ts'), 'export class Base { shared() { return 1 } }');
    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['b'] });
    let store = EdgeStore.open(EdgeStore.dbPath(output));
    try { expect(store.getAllInheritanceEdges().some(edge => edge.kind === 'overrides')).toBe(true); }
    finally { store.close(); }

    await writeFile(join(root, 'packages/b/b.ts'), 'export class Base { other() { return 1 } }');
    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['b'] });
    store = EdgeStore.open(EdgeStore.dbPath(output));
    try { expect(store.getAllInheritanceEdges().some(edge => edge.kind === 'overrides')).toBe(false); }
    finally { store.close(); }
  });

  it('matches cold-build CHA targets when a selected shard adds a call into a retained hierarchy', async () => {
    const before = {
      'packages/a/a.ts': 'export function unrelated() { return 1 }',
      'packages/b/b.ts': 'export class Base { shared() { return 1 } }\nexport class Child extends Base { shared() { return 2 } }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    const after = {
      ...before,
      'packages/a/a.ts': 'export function compute(value: Base) { return value.shared() }',
    };
    await writeFile(join(root, 'packages/a/a.ts'), after['packages/a/a.ts']);
    const files = ['package.json', ...Object.keys(after), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const expected = await fullGraph(root, after);
    const expectedTargets = expected.edges
      .filter(edge => edge.callerId === 'packages/a/a.ts::compute' && edge.confidence === 'synthesized')
      .map(edge => edge.calleeId)
      .sort();
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      const actualTargets = store.getAllEdges()
        .filter(edge => edge.callerId === 'packages/a/a.ts::compute' && edge.confidence === 'synthesized')
        .map(edge => edge.calleeId)
        .sort();
      expect(actualTargets).toEqual(expectedTargets);
      expect(actualTargets).toContain('packages/b/b.ts::Child.shared');
    } finally { store.close(); }
  });

  it('recomputes retained structural metrics when a selected shard adds a cross-shard call', async () => {
    const before = {
      'packages/a/a.ts': 'export function caller() { return 1 }',
      'packages/b/b.ts': 'export function target() { return 2 }',
    };
    const { root, output } = await createRepo(before);
    await seed(root, output, before);
    await writeFile(join(root, 'packages/a/a.ts'), 'export function caller() { return target() }');
    const files = ['package.json', ...Object.keys(before), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(store.getNode('packages/b/b.ts::target')?.fanIn).toBe(1);
      expect(store.getNode('packages/a/a.ts::caller')?.fanOut).toBe(1);
    } finally { store.close(); }
  });

  it('ignores an oversized prior shard receipt without materializing it as trusted state', async () => {
    const sources = {
      'packages/a/a.ts': 'export function a() { return 1 }',
      'packages/b/b.ts': 'export function b() { return 2 }',
    };
    const { root, output } = await createRepo(sources);
    await seed(root, output, sources);
    const receiptPath = join(output, 'workspace-shards.json');
    await writeFile(receiptPath, '');
    await truncate(receiptPath, MAX_SHARD_RECEIPT_BYTES + 1);
    const files = ['package.json', ...Object.keys(sources), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    expect(receipt.shards.find(shard => shard.name === 'b')?.freshness).toBe('unknown');
  });

  it.each([
    'null',
    '42',
    JSON.stringify({ version: 1, shards: [null] }),
    JSON.stringify({ version: 1, mode: 'scoped', source: 'detected', computedAt: 'now', recomputed: [], retained: [], frontierFiles: [], staleFiles: [], artifacts: { recomputed: [], retained: [] }, shards: [{ name: 'a' }], ignoredMembers: [] }),
  ])('rejects malformed prior receipt state: %s', async malformed => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-shard-receipt-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'workspace-shards.json'), malformed);
    await expect(readPriorShardReceipt(output)).resolves.toBeNull();
  });

  it('accepts a maximum-count escaped UTF-8 receipt larger than the former 1 MB cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-shard-receipt-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(output, { recursive: true });
    const shards: ShardScopedAnalysisReceipt['shards'] = Array.from({ length: 5_001 }, (_, index) => ({
      name: index === 5_000 ? 'root' : `${'\\"'.repeat(120)}-${index}`,
      root: index === 5_000 ? '' : `packages/${index}`,
      manifest: index === 5_000 ? null : 'package.json',
      fileCount: 1,
      lastRecomputedAt: '2026-08-30T00:00:00.000Z',
      freshness: 'current',
      fingerprint: 'a'.repeat(64),
    }));
    const receipt: ShardScopedAnalysisReceipt = {
      version: 1,
      mode: 'full',
      source: 'detected',
      computedAt: '2026-08-30T00:00:00.000Z',
      recomputed: shards.map(shard => shard.name),
      retained: [],
      frontierFiles: [],
      staleFiles: [],
      artifacts: { recomputed: [], retained: [] },
      shards,
      ignoredMembers: [],
    };
    const serialized = JSON.stringify(receipt);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(1_048_576);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_SHARD_RECEIPT_BYTES);
    await writeFile(join(output, 'workspace-shards.json'), serialized);
    await expect(readPriorShardReceipt(output)).resolves.toEqual(receipt);
  });

  it('rejects an oversized receipt before materializing its JSON string', () => {
    const longPath = 'x'.repeat(4_096);
    const receipt: ShardScopedAnalysisReceipt = {
      version: 1,
      mode: 'scoped',
      source: 'detected',
      computedAt: '2026-08-30T00:00:00.000Z',
      recomputed: [],
      retained: [],
      frontierFiles: Array(16_500).fill(longPath),
      staleFiles: [],
      artifacts: { recomputed: [], retained: [] },
      shards: [],
      ignoredMembers: [],
    };
    expect(() => serializeShardReceipt(receipt)).toThrow(/bounded schema/);
  });

  it('treats malformed prior state as absent before committing a scoped update', async () => {
    const sources = {
      'packages/a/a.ts': 'export function a() { return 1 }',
      'packages/b/b.ts': 'export function b() { return 2 }',
    };
    const { root, output } = await createRepo(sources);
    await seed(root, output, sources);
    await writeFile(join(output, 'workspace-shards.json'), JSON.stringify({ version: 1, shards: [null] }));
    await writeFile(join(root, 'packages/a/a.ts'), 'export function changed() { return 3 }');
    const files = ['package.json', ...Object.keys(sources), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    await expect(runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] }))
      .resolves.toMatchObject({ recomputed: ['a'] });
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try { expect(store.getNode('packages/a/a.ts::changed')).not.toBeNull(); }
    finally { store.close(); }
  });

  it('does not read an unexamined retained shard to report scoped freshness', async () => {
    const sources = {
      'packages/a/a.ts': 'export function a() { return 1 }',
      'packages/b/b.ts': 'export function b() { return 2 }',
    };
    const { root, output } = await createRepo(sources);
    await seed(root, output, sources);
    const files = ['package.json', ...Object.keys(sources), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);
    await unlink(join(root, 'packages/b/b.ts'));

    const receipt = await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    expect(receipt.shards.find(shard => shard.name === 'b')?.freshness).toBe('unknown');
  });

  it('keeps production-store metrics independent of retained test-only calls', async () => {
    const sources = {
      'packages/a/a.ts': 'export function unrelated() { return 1 }',
      'packages/b/b.ts': 'export function target() { return 2 }',
      'packages/b/b.test.ts': 'export function testTarget() { return target() }',
    };
    const { root, output } = await createRepo(sources);
    await seed(root, output, sources);
    const files = ['package.json', ...Object.keys(sources), 'packages/a/package.json', 'packages/b/package.json'];
    const report = await detectWorkspaceShards(root, files);

    await runShardScopedAnalysis({ rootPath: root, outputPath: output, report, selectedNames: ['a'] });
    const store = EdgeStore.open(EdgeStore.dbPath(output));
    try {
      expect(store.getNode('packages/b/b.ts::target')?.fanIn).toBe(0);
      expect(store.getEntryPoints().map(node => node.id)).toContain('packages/b/b.ts::target');
    } finally { store.close(); }
  });
});
