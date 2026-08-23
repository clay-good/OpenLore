import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionConstraintBlock, DecisionStatus, PendingDecision } from '../../types/index.js';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import {
  decisionConstraintViolationFindings,
  loadDecisionConstraintState,
  parseDecisionConstraintMarkers,
  renderDecisionConstraintMarker,
  validateDecisionConstraintBlock,
} from './constraint-ledger.js';
import { saveDecisionStore } from './store.js';

function decision(
  id: string,
  status: DecisionStatus,
  constraints?: DecisionConstraintBlock,
  supersedes?: string,
): PendingDecision {
  return {
    id,
    status,
    title: `Decision ${id}`,
    rationale: `Rationale ${id}`,
    consequences: '',
    proposedRequirement: null,
    affectedDomains: ['architecture'],
    affectedFiles: [],
    sessionId: 'test-session',
    recordedAt: '2026-08-23T00:00:00.000Z',
    contentOrigin: 'agent-recorded',
    confidence: 'high',
    syncedToSpecs: [],
    constraints,
    supersedes,
  };
}

function eligible(rules: DecisionConstraintBlock['rules']): DecisionConstraintBlock {
  return {
    version: 1,
    eligibility: {
      status: 'eligible',
      enforcedBoundary: 'Dependencies under src/app obey the declared boundary.',
      humanReviewRemainder: 'Humans judge whether the boundary captures the full intent.',
    },
    rules,
  };
}

function forbidden(id: string, from = 'src/app', to = 'src/db') {
  return { id, scope: 'src/app', kind: 'forbidden' as const, from, to, reason: 'app stays database-agnostic' };
}

async function rootWithStore(decisions: PendingDecision[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-constraint-'));
  await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
  await saveDecisionStore(root, {
    version: '1',
    sessionId: 'test-session',
    updatedAt: '2026-08-23T00:00:00.000Z',
    sequence: 0,
    decisions,
  });
  return root;
}

function graph(edges: Array<[string, string]>): DependencyGraphResult {
  const files = [...new Set(edges.flat())];
  return {
    nodes: files.map((path) => ({
      id: `/repo/${path}`,
      file: { path, absolutePath: `/repo/${path}` },
      exports: [],
      metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 },
    })),
    edges: edges.map(([from, to]) => ({
      source: `/repo/${from}`,
      target: `/repo/${to}`,
      importedNames: [],
      isTypeOnly: false,
      weight: 1,
    })),
  } as unknown as DependencyGraphResult;
}

describe('decision constraint durable marker', () => {
  it('round-trips only when structurally adjacent to the generated decision id', () => {
    const d = decision('aaaaaaaa', 'approved', eligible([forbidden('no-db')]));
    const marker = renderDecisionConstraintMarker(d);
    const parsed = parseDecisionConstraintMarkers(`### Title\n\n**ID:** aaaaaaaa\n${marker}\n\nprose`);
    expect(parsed).toEqual([{ payload: expect.objectContaining({ decisionId: 'aaaaaaaa', constraints: d.constraints }) }]);

    expect(parseDecisionConstraintMarkers(`**ID:** aaaaaaaa\n\nRationale\n${marker}`)).toEqual([]);
    expect(parseDecisionConstraintMarkers(`\`\`\`md\n**ID:** aaaaaaaa\n${marker}\n\`\`\``)).toEqual([]);
  });

  it('refuses a marker whose payload id disagrees with the adjacent record', () => {
    const marker = renderDecisionConstraintMarker(decision('bbbbbbbb', 'approved', eligible([])));
    const parsed = parseDecisionConstraintMarkers(`**ID:** aaaaaaaa\n${marker}`);
    expect(parsed[0]?.error).toContain('does not match adjacent decision');
  });

  it('does not let a shorter fence close a longer fenced block', () => {
    const marker = renderDecisionConstraintMarker(decision('aaaaaaaa', 'approved', eligible([])));
    expect(parseDecisionConstraintMarkers(`\`\`\`\`md\n\`\`\`\n**ID:** aaaaaaaa\n${marker}\n\`\`\`\``)).toEqual([]);
  });

  it('ignores blockquoted and invalidly closed fenced marker examples', () => {
    const marker = renderDecisionConstraintMarker(decision('aaaaaaaa', 'approved', eligible([])));
    expect(parseDecisionConstraintMarkers([
      '> ```md', '> Decision ID: aaaaaaaa', `> ${marker}`, '> ```',
    ].join('\n'))).toEqual([]);
    expect(parseDecisionConstraintMarkers([
      '```md', '```js', '**ID:** aaaaaaaa', marker, '```',
    ].join('\n'))).toEqual([]);
  });
});

describe('decision constraint validation', () => {
  const base = { id: 'aaaaaaaa', title: 'A', rationale: 'because' };

  it.each([
    [{ version: 2, rules: [] }, 'unsupported version'],
    [{ version: 1, rules: [{ id: 'x', scope: '../src', kind: 'forbidden', from: 'src/a', to: 'src/b' }] }, 'confined repository-relative'],
    [{ version: 1, rules: [{ id: 'x', scope: 'src', kind: 'mystery' }] }, 'existing architecture rule vocabulary'],
    [{ version: 1, rules: [forbidden('x'), forbidden('x')] }, 'duplicated'],
    [{ version: 1, eligibility: { status: 'ineligible' }, rules: [] }, 'requires a stated reason'],
    [{ version: 1, eligibility: { status: 'eligible' }, rules: [] }, 'requires a stated enforced boundary'],
  ])('reports malformed input %# without throwing', (block, message) => {
    const findings = validateDecisionConstraintBlock(base, block);
    expect(findings.some((finding) => finding.message.includes(message))).toBe(true);
  });

  it('accepts an eligible zero-rule decision as a coverage gap', () => {
    expect(validateDecisionConstraintBlock(base, eligible([]))).toEqual([]);
  });
});

describe('decision constraint lifecycle and ledger', () => {
  it('publishes four honest measurements without counting retired rules', async () => {
    const root = await rootWithStore([
      decision('aaaaaaaa', 'approved', eligible([forbidden('r1'), forbidden('r2', 'src/app', 'src/infra')])),
      decision('bbbbbbbb', 'approved', eligible([])),
      decision('cccccccc', 'approved', { version: 1, eligibility: { status: 'ineligible', reason: 'Team practice only.' }, rules: [] }),
      decision('dddddddd', 'approved'),
      decision('eeeeeeee', 'rejected', eligible([forbidden('retired')])),
    ]);
    const state = await loadDecisionConstraintState(root);
    expect(state.ledger).toMatchObject({
      adoption: { constrained: 1, authoritative: 4, ratio: 0.25 },
      coverage: { constrainedEligible: 1, eligible: 2, ratio: 0.5 },
      unclassifiedCount: 1,
      activeRuleCount: 2,
      coverageGaps: [{ decisionId: 'bbbbbbbb', title: 'Decision bbbbbbbb' }],
    });
    expect(state.retiredRules).toEqual([
      expect.objectContaining({ decisionId: 'eeeeeeee', ruleId: 'retired', status: 'rejected' }),
    ]);
  });

  it.each<DecisionStatus>(['draft', 'consolidated', 'verified', 'phantom', 'rejected', 'auto-approved'])(
    'does not enforce %s constraints', async (status) => {
    const root = await rootWithStore([decision('aaaaaaaa', status, eligible([forbidden('r1')]))]);
    const state = await loadDecisionConstraintState(root);
    expect(state.rules).toEqual([]);
    expect(state.retiredRules).toHaveLength(1);
    },
  );

  it('only an authoritative superseder retires an approved decision', async () => {
    const old = decision('aaaaaaaa', 'approved', eligible([forbidden('old-rule')]));
    const draftRoot = await rootWithStore([old, decision('bbbbbbbb', 'draft', eligible([]), 'aaaaaaaa')]);
    expect((await loadDecisionConstraintState(draftRoot)).rules.map((rule) => rule.ruleId)).toEqual(['old-rule']);

    const approvedRoot = await rootWithStore([old, decision('bbbbbbbb', 'approved', eligible([]), 'aaaaaaaa')]);
    const state = await loadDecisionConstraintState(approvedRoot);
    expect(state.rules).toEqual([]);
    expect(state.retiredRules).toEqual([
      expect.objectContaining({ decisionId: 'aaaaaaaa', ruleId: 'old-rule', status: 'superseded' }),
    ]);
  });

  it('keeps self-superseding rules active and retires every member of an authoritative cycle', async () => {
    const selfRoot = await rootWithStore([
      decision('aaaaaaaa', 'approved', eligible([forbidden('self-rule')]), 'aaaaaaaa'),
    ]);
    const self = await loadDecisionConstraintState(selfRoot);
    expect(self.rules.map((rule) => rule.ruleId)).toEqual(['self-rule']);
    expect(self.malformedFindings.map((finding) => finding.discriminator)).toContain('supersession:self');

    const cycleRoot = await rootWithStore([
      decision('aaaaaaaa', 'approved', eligible([forbidden('a-rule')]), 'bbbbbbbb'),
      decision('bbbbbbbb', 'approved', eligible([forbidden('b-rule')]), 'aaaaaaaa'),
    ]);
    const cycle = await loadDecisionConstraintState(cycleRoot);
    expect(cycle.rules).toEqual([]);
    expect(cycle.retiredRules.map((rule) => rule.ruleId)).toEqual(['a-rule', 'b-rule']);
    expect(cycle.violationAssessmentComplete).toBe(false);
  });

  it('reports a null ratio when there are no authoritative decisions', async () => {
    const root = await rootWithStore([]);
    expect((await loadDecisionConstraintState(root)).ledger.adoption).toEqual({
      constrained: 0,
      authoritative: 0,
      ratio: null,
    });
  });

  it('keeps distinct governing receipts for two rules violated by the same edge', async () => {
    const root = await rootWithStore([
      decision('aaaaaaaa', 'approved', eligible([forbidden('r1')])),
      decision('bbbbbbbb', 'approved', eligible([forbidden('r2')])),
    ]);
    const state = await loadDecisionConstraintState(root);
    const findings = decisionConstraintViolationFindings(graph([['src/app/a.ts', 'src/db/b.ts']]), state);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.decision?.id)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(findings[0]).toMatchObject({
      code: 'decision-constraint-violation',
      location: { path: 'src/app/a.ts' },
      decision: { id: 'aaaaaaaa', title: 'Decision aaaaaaaa', rationale: 'Rationale aaaaaaaa', ruleId: 'r1' },
    });
    expect(findings[0].location).not.toHaveProperty('line');
  });

  it('loads a synced constraint from the durable spec after the pending store is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-constraint-durable-'));
    const d = decision('aaaaaaaa', 'synced', eligible([forbidden('persisted')]));
    const specDir = join(root, 'openspec', 'specs', 'architecture');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'spec.md'), [
      '# Architecture', '', '## Decisions', '', '### Decision aaaaaaaa', '',
      '**Status:** Approved', '**Date:** 2026-08-23', '**ID:** aaaaaaaa', renderDecisionConstraintMarker(d), '',
      'Rationale aaaaaaaa', '', '**Consequences:** consequence', '',
    ].join('\n'));
    const state = await loadDecisionConstraintState(root);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0]).toMatchObject({ ruleId: 'persisted', decision: { id: 'aaaaaaaa' } });
  });

  it('never throws on a malformed durable marker and rejects unknown durable status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-constraint-malformed-durable-'));
    const specDir = join(root, 'openspec', 'specs', 'architecture');
    await mkdir(specDir, { recursive: true });
    const payload = JSON.stringify({
      decisionId: 'aaaaaaaa',
      title: 'Decision aaaaaaaa',
      rationale: 'Rationale aaaaaaaa',
      constraints: { version: 1 },
    });
    await writeFile(join(specDir, 'spec.md'), [
      '# Architecture', '', '## Decisions', '', '### Decision aaaaaaaa', '',
      '**Status:** banana', '**Date:** 2026-08-23', '**ID:** aaaaaaaa', `> OpenLore constraints: ${payload}`, '',
      'Rationale aaaaaaaa', '', '**Consequences:** consequence', '',
    ].join('\n'));

    const state = await loadDecisionConstraintState(root);

    expect(state.rules).toEqual([]);
    expect(state.malformedFindings.map((finding) => finding.message).join(' ')).toMatch(/status.*not authoritative/i);
  });

  it('reports a non-object durable rule without suppressing a valid sibling decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-constraint-total-parser-'));
    const specDir = join(root, 'openspec', 'specs', 'architecture');
    await mkdir(specDir, { recursive: true });
    const malformedPayload = JSON.stringify({
      decisionId: 'aaaaaaaa', title: 'Bad', rationale: 'bad rationale',
      constraints: { version: 1, rules: [null] },
    });
    const valid = decision('bbbbbbbb', 'synced', eligible([forbidden('valid-rule')]));
    await writeFile(join(specDir, 'spec.md'), [
      '# Architecture', '', '## Decisions', '',
      '### Bad', '', '**Status:** Approved', '**Date:** 2026-08-23', '**ID:** aaaaaaaa',
      `> OpenLore constraints: ${malformedPayload}`, '', 'bad rationale', '', '**Consequences:** none', '',
      '### Decision bbbbbbbb', '', '**Status:** Approved', '**Date:** 2026-08-23', '**ID:** bbbbbbbb',
      renderDecisionConstraintMarker(valid), '', 'Rationale bbbbbbbb', '', '**Consequences:** none', '',
    ].join('\n'));

    const state = await loadDecisionConstraintState(root);

    expect(state.rules.map((rule) => rule.ruleId)).toEqual(['valid-rule']);
    expect(state.malformedFindings.some((finding) => finding.subject === 'decision:aaaaaaaa')).toBe(true);
    expect(state.violationAssessmentComplete).toBe(false);
  });

  it('rejects duplicate full projections for one decision in the same spec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-constraint-duplicate-projection-'));
    const specDir = join(root, 'openspec', 'specs', 'architecture');
    await mkdir(specDir, { recursive: true });
    const d = decision('aaaaaaaa', 'synced', eligible([forbidden('duplicate-rule')]));
    const entry = [
      '### Decision aaaaaaaa', '', '**Status:** Approved', '**Date:** 2026-08-23', '**ID:** aaaaaaaa',
      renderDecisionConstraintMarker(d), '', 'Rationale aaaaaaaa', '', '**Consequences:** none', '',
    ];
    await writeFile(join(specDir, 'spec.md'), ['# Architecture', '', '## Decisions', '', ...entry, ...entry].join('\n'));

    const state = await loadDecisionConstraintState(root);

    expect(state.rules).toEqual([]);
    expect(state.malformedFindings.map((finding) => finding.message).join(' ')).toMatch(/2 durable projections/);
  });
});

it('has no LLM, embedding, network, or process dependency in the evaluator', async () => {
  const source = await readFile(new URL('./constraint-ledger.ts', import.meta.url), 'utf-8');
  const imports = source.split('\n').filter((line) => /^import\b/.test(line)).join('\n');
  expect(imports).not.toMatch(/llm-service|embedder|vector-index|node:child_process/);
  expect(source).not.toMatch(/\bglobal\.fetch\s*\(|\bfetch\s*\(/);
});

it('evaluates a real constraint without touching the network', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
  try {
    const root = await rootWithStore([
      decision('aaaaaaaa', 'approved', eligible([forbidden('offline-rule')])),
    ]);
    const state = await loadDecisionConstraintState(root);
    expect(decisionConstraintViolationFindings(graph([['src/app/a.ts', 'src/db/b.ts']]), state)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
