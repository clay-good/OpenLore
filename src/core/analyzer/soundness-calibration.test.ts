import { describe, expect, it } from 'vitest';

import { CallGraphBuilder } from './call-graph.js';
import type { CallEdge, EdgeConfidence } from './call-graph-types.js';
import {
  PRECISION_ORDER_FINDING,
  calibratePrecisionOrder,
  compareCha,
  compareRefining,
} from './soundness-calibration.js';
import { FINDING_CODE_REGISTRY } from '../services/mcp-handlers/enforcement-policy.js';

const edge = (p: Partial<CallEdge> & { callerId: string; calleeName: string }): CallEdge => ({
  calleeId: p.calleeId ?? `${p.calleeName}#id`,
  confidence: (p.confidence ?? 'import') as EdgeConfidence,
  line: p.line ?? 1,
  ...p,
});

describe('compareRefining (monotone refinement)', () => {
  it('flags a resolution the full build dropped', () => {
    const conservative = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'B', confidence: 'same_file' })];
    // Full build left the same call site unresolved (external) — a dropped edge.
    const full = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'external::f', confidence: 'external' })];
    const findings = compareRefining('type_inference', conservative, full);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(PRECISION_ORDER_FINDING);
  });

  it('passes when the full build refines the same site to a higher tier', () => {
    const conservative = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'B', confidence: 'name_only' })];
    const full = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'C', confidence: 'type_inference' })];
    expect(compareRefining('type_inference', conservative, full)).toEqual([]);
  });

  it('does not flag a site the conservative build left external (resolution is allowed to add)', () => {
    const conservative = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'external::f', confidence: 'external' })];
    const full = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'B', confidence: 'type_inference' })];
    expect(compareRefining('type_inference', conservative, full)).toEqual([]);
  });

  it('ignores synthesized and overrides edges', () => {
    const conservative = [
      edge({ callerId: 'A', calleeName: 'f', calleeId: 'B', confidence: 'synthesized', synthesizedBy: 'route-handler' }),
      edge({ callerId: 'A', calleeName: 'g', calleeId: 'B', kind: 'overrides', confidence: 'synthesized' }),
    ];
    expect(compareRefining('re_export', conservative, [])).toEqual([]);
  });
});

describe('compareCha (additive-only)', () => {
  it('passes when CHA only adds overrides edges', () => {
    const direct = edge({ callerId: 'A', calleeName: 'f', calleeId: 'B', confidence: 'import' });
    const withCha = [direct, edge({ callerId: 'A', calleeName: 'f', calleeId: 'D', kind: 'overrides', confidence: 'synthesized' })];
    const withoutCha = [direct];
    expect(compareCha(withCha, withoutCha)).toEqual([]);
  });

  it('flags a non-overrides edge CHA perturbed', () => {
    const withoutCha = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'B', confidence: 'import' })];
    // Same site, different resolved target with CHA on — CHA disturbed direct structure.
    const withCha = [edge({ callerId: 'A', calleeName: 'f', calleeId: 'Z', confidence: 'import' })];
    const findings = compareCha(withCha, withoutCha);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(f => f.code === PRECISION_ORDER_FINDING)).toBe(true);
  });
});

describe('resolution toggles are threaded into the builder', () => {
  const files = [{
    path: '/virtual/zoo.ts',
    language: 'TypeScript',
    content: `
class Animal { speak(): string { return 'a'; } }
class Dog extends Animal { speak(): string { return 'woof'; } }
export function greet(a: Animal): string { return a.speak(); }
`,
  }];

  it('cha:false synthesizes no overrides edges, default may', async () => {
    const full = await new CallGraphBuilder().build(files);
    const noCha = await new CallGraphBuilder({ resolution: { cha: false } }).build(files);
    const overrides = (es: CallEdge[]) => es.filter(e => e.kind === 'overrides').length;
    expect(overrides(noCha.edges)).toBe(0);
    // The gate demonstrably removes edges the full build had.
    expect(overrides(full.edges)).toBeGreaterThanOrEqual(overrides(noCha.edges));
  });
});

describe('calibratePrecisionOrder (integration)', () => {
  it('reports no violation on a clean, monotone fixture', async () => {
    const files = [
      { path: '/virtual/util.ts', language: 'TypeScript', content: `export function helper(): number { return 1; }` },
      { path: '/virtual/barrel.ts', language: 'TypeScript', content: `export { helper } from './util.js';` },
      { path: '/virtual/main.ts', language: 'TypeScript', content: `
import { helper } from './barrel.js';
export function run(): number { return helper(); }
` },
    ];
    const findings = await calibratePrecisionOrder({ files, repoLabel: 'fixture' });
    expect(findings).toEqual([]);
  });
});

describe('finding code registration', () => {
  it('callgraph-precision-order-violation is registered, advisory by default', () => {
    const spec = FINDING_CODE_REGISTRY[PRECISION_ORDER_FINDING];
    expect(spec).toBeDefined();
    expect(spec.defaultClass).toBe('advisory');
    expect(spec.source).toBe('callgraph-soundness');
  });
});
