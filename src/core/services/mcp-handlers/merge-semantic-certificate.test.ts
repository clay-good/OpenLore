import { describe, expect, it } from 'vitest';

import type { CallEdge, FunctionNode } from '../../analyzer/call-graph-types.js';
import { addedEdges, changedSymbols, crossJoin, type ChangedSymbol } from './merge-semantic-certificate.js';

const node = (p: Partial<FunctionNode> & { id: string; name: string }): FunctionNode => ({
  language: 'TypeScript', filePath: 'a.ts', ...p,
} as unknown as FunctionNode);
const edge = (p: Partial<CallEdge> & { callerId: string; calleeId: string; calleeName: string }): CallEdge => ({
  confidence: 'import', line: 1, ...p,
} as CallEdge);
const graph = (nodes: FunctionNode[], edges: CallEdge[] = []) =>
  ({ nodes: new Map(nodes.map(n => [n.id, n])), edges });

describe('changedSymbols', () => {
  it('reports a removed symbol', () => {
    const base = graph([node({ id: 'a.ts::gone', name: 'gone' }), node({ id: 'a.ts::keep', name: 'keep' })]);
    const side = graph([node({ id: 'a.ts::keep', name: 'keep' })]);
    const changed = changedSymbols(base, side);
    expect(changed).toEqual([{ id: 'a.ts::gone', name: 'gone', kind: 'removed', ruleCodes: ['export-removed'] }]);
  });

  it('does not flag an unchanged symbol', () => {
    const base = graph([node({ id: 'a.ts::f', name: 'f', signature: 'f(x: number): void' })]);
    const side = graph([node({ id: 'a.ts::f', name: 'f', signature: 'f(x: number): void' })]);
    expect(changedSymbols(base, side)).toEqual([]);
  });

  it('ignores external nodes', () => {
    const base = graph([node({ id: 'external::x', name: 'x', isExternal: true })]);
    expect(changedSymbols(base, graph([]))).toEqual([]);
  });
});

describe('addedEdges', () => {
  it('returns only edges new in the side graph', () => {
    const shared = edge({ callerId: 'a.ts::c', calleeId: 'a.ts::f', calleeName: 'f', line: 2 });
    const base = graph([], [shared]);
    const novel = edge({ callerId: 'a.ts::c', calleeId: 'a.ts::g', calleeName: 'g', line: 9 });
    const side = graph([], [shared, novel]);
    expect(addedEdges(base, side)).toEqual([novel]);
  });

  it('excludes external and non-call edges', () => {
    const base = graph([], []);
    const side = graph([], [
      edge({ callerId: 'c', calleeId: 'external::x', calleeName: 'x', confidence: 'external' }),
      edge({ callerId: 'c', calleeId: 'd', calleeName: 'd', kind: 'overrides' }),
    ]);
    expect(addedEdges(base, side)).toEqual([]);
  });
});

describe('crossJoin', () => {
  const nameOf = () => 'caller';
  it('flags an added call into a removed symbol as incompatible', () => {
    const added = [edge({ callerId: 'c', calleeId: 'a.ts::gone', calleeName: 'gone', line: 3 })];
    const changed: ChangedSymbol[] = [{ id: 'a.ts::gone', name: 'gone', kind: 'removed', ruleCodes: ['export-removed'] }];
    const out = crossJoin('theirs', added, 'ours', changed, nameOf);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe('incompatible');
    expect(out[0].side).toBe('theirs');
  });

  it('flags a potentially-breaking change as potentially-incompatible', () => {
    const added = [edge({ callerId: 'c', calleeId: 'a.ts::f', calleeName: 'f' })];
    const changed: ChangedSymbol[] = [{ id: 'a.ts::f', name: 'f', kind: 'potentially-breaking', ruleCodes: ['param-type-narrowed'] }];
    expect(crossJoin('ours', added, 'theirs', changed, nameOf)[0].verdict).toBe('potentially-incompatible');
  });

  it('does not flag an added call into an unchanged symbol', () => {
    const added = [edge({ callerId: 'c', calleeId: 'a.ts::stable', calleeName: 'stable' })];
    expect(crossJoin('theirs', added, 'ours', [], nameOf)).toEqual([]);
  });
});
