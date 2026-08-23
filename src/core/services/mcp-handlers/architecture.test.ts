import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCheckArchitecture } from './architecture.js';

function depGraphJson(dir: string, edges: Array<[string, string]>): string {
  const files = new Set<string>();
  for (const [a, b] of edges) { files.add(a); files.add(b); }
  const abs = (rel: string) => join(dir, rel);
  return JSON.stringify({
    nodes: [...files].map(rel => ({
      id: abs(rel), file: { path: rel, absolutePath: abs(rel) }, exports: [],
      metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 },
    })),
    edges: edges.map(([a, b]) => ({ source: abs(a), target: abs(b), importedNames: [], isTypeOnly: false, weight: 1 })),
  });
}

describe('handleCheckArchitecture', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'arch-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('is inert (scan) when no rules are declared', async () => {
    const res = (await handleCheckArchitecture({ directory: dir })) as Record<string, unknown>;
    expect(res).toMatchObject({ mode: 'scan', rulesDeclared: false, violationCount: 0 });
    expect(res.violations).toEqual([]);
  });

  it('is inert (pre-edit) when no rules are declared', async () => {
    const res = (await handleCheckArchitecture({ directory: dir, from: 'a.ts', to: 'b.ts' })) as Record<string, unknown>;
    expect(res).toMatchObject({ mode: 'pre-edit', rulesDeclared: false, allowed: true });
  });

  it('scans violations and answers a pre-edit query when rules are declared', async () => {
    await mkdir(join(dir, '.openlore', 'analysis'), { recursive: true });
    await writeFile(
      join(dir, '.openlore', 'architecture.json'),
      JSON.stringify({ forbidden: [{ from: 'src/domain', to: 'src/infra', reason: 'domain stays infra-free' }] }),
    );
    await writeFile(
      join(dir, '.openlore', 'analysis', 'dependency-graph.json'),
      depGraphJson(dir, [['src/domain/order.ts', 'src/infra/db.ts']]),
    );

    const scan = (await handleCheckArchitecture({ directory: dir })) as Record<string, unknown>;
    expect(scan).toMatchObject({ mode: 'scan', rulesDeclared: true, violationCount: 1 });

    const denied = (await handleCheckArchitecture({
      directory: dir, from: 'src/domain/order.ts', to: 'src/infra/db.ts',
    })) as Record<string, unknown>;
    expect(denied).toMatchObject({ mode: 'pre-edit', allowed: false });

    const allowed = (await handleCheckArchitecture({
      directory: dir, from: 'src/domain/order.ts', to: 'src/domain/money.ts',
    })) as Record<string, unknown>;
    expect(allowed).toMatchObject({ allowed: null, assessmentComplete: false });
  });

  it('does not present malformed authoritative constraints as a clean allow or zero scan', async () => {
    await mkdir(join(dir, '.openlore', 'decisions'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'decisions', 'pending.json'), JSON.stringify({
      version: '1', sessionId: 's1', updatedAt: '2026-08-23T00:00:00Z', decisions: [{
        id: 'aaaaaaaa', status: 'approved', title: 'Malformed policy', rationale: 'A rationale.',
        consequences: '', proposedRequirement: null, affectedDomains: [], affectedFiles: [],
        sessionId: 's1', recordedAt: '2026-08-23T00:00:00Z', contentOrigin: 'agent-recorded',
        confidence: 'high', syncedToSpecs: [], constraints: { version: 2, rules: [] },
      }],
    }));

    const preEdit = await handleCheckArchitecture({ directory: dir, from: 'src/a.ts', to: 'src/b.ts' }) as Record<string, unknown>;
    expect(preEdit).toMatchObject({ mode: 'pre-edit', allowed: null, assessmentComplete: false });

    const scan = await handleCheckArchitecture({ directory: dir }) as Record<string, unknown>;
    expect(scan).toMatchObject({ mode: 'scan', violationCount: null, assessmentComplete: false });
  });
});
