import { describe, it, expect } from 'vitest';
import { projectDecisions, decisionNodeId, DECISION_NODE_PREFIX } from './project.js';
import type { DecisionStore, PendingDecision, DecisionStatus } from '../../types/index.js';

function makeDecision(overrides: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    status: 'verified',
    title: `Decision ${overrides.id}`,
    rationale: 'because',
    consequences: 'tradeoff',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: [],
    sessionId: 'sess',
    recordedAt: '2026-05-30T00:00:00.000Z',
    contentOrigin: 'agent-recorded',
    confidence: 'high',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return { version: '1', sessionId: 'sess', updatedAt: '2026-05-30T00:00:00.000Z', decisions };
}

describe('projectDecisions', () => {
  it('projects an active decision into a typed node + one affects edge per file', () => {
    const store = makeStore([
      makeDecision({
        id: 'aaaa1111',
        title: 'Use JWTs',
        affectedDomains: ['auth'],
        affectedFiles: ['src/auth/middleware.ts', 'src/auth/token.ts'],
      }),
    ]);

    const { nodes, edges } = projectDecisions(store);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: 'decision::aaaa1111',
      decisionId: 'aaaa1111',
      kind: 'decision',
      title: 'Use JWTs',
      status: 'verified',
      affectedDomains: ['auth'],
    });
    expect(edges).toHaveLength(2);
    expect(edges.every(e => e.kind === 'affects')).toBe(true);
    expect(edges.map(e => e.filePath).sort()).toEqual([
      'src/auth/middleware.ts',
      'src/auth/token.ts',
    ]);
    expect(edges.every(e => e.decisionNodeId === 'decision::aaaa1111')).toBe(true);
  });

  it('excludes inactive decisions (synced / rejected / phantom)', () => {
    const inactive: DecisionStatus[] = ['synced', 'rejected', 'phantom'];
    const store = makeStore([
      makeDecision({ id: 'active01', status: 'approved', affectedFiles: ['src/a.ts'] }),
      ...inactive.map((status, i) =>
        makeDecision({ id: `inact00${i}`, status, affectedFiles: ['src/b.ts'] }),
      ),
    ]);

    const { nodes, edges } = projectDecisions(store);

    expect(nodes.map(n => n.decisionId)).toEqual(['active01']);
    expect(edges.map(e => e.filePath)).toEqual(['src/a.ts']);
  });

  it('deduplicates repeated affected files', () => {
    const store = makeStore([
      makeDecision({ id: 'dup00001', affectedFiles: ['src/x.ts', 'src/x.ts', 'src/y.ts'] }),
    ]);
    const { edges } = projectDecisions(store);
    expect(edges.map(e => e.filePath).sort()).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('an empty store projects to nothing', () => {
    expect(projectDecisions(makeStore([]))).toEqual({ nodes: [], edges: [] });
  });

  it('a legacy store with no decisions array projects cleanly', () => {
    const legacy = { version: '1', sessionId: 's', updatedAt: 'x' } as unknown as DecisionStore;
    expect(projectDecisions(legacy)).toEqual({ nodes: [], edges: [] });
  });

  it('preserves the supersedes link and emits deterministic order', () => {
    const store = makeStore([
      makeDecision({ id: 'zzzz9999', affectedFiles: ['src/z.ts'] }),
      makeDecision({ id: 'aaaa0000', affectedFiles: ['src/a.ts'], supersedes: 'old12345' }),
    ]);
    const { nodes } = projectDecisions(store);
    // sorted by id
    expect(nodes.map(n => n.decisionId)).toEqual(['aaaa0000', 'zzzz9999']);
    expect(nodes[0].supersedes).toBe('old12345');
    expect(nodes[1].supersedes).toBeUndefined();
  });

  it('decisionNodeId / prefix are stable', () => {
    expect(decisionNodeId('c6d1ad07')).toBe('decision::c6d1ad07');
    expect(DECISION_NODE_PREFIX).toBe('decision::');
  });
});
