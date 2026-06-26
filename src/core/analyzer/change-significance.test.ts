/**
 * Change significance labeling (change: add-change-significance-briefing).
 * Pure-function tests of the tier classifier: a stable hub ranks top as
 * surprising-change, the surprise label is withheld without history, the
 * hub/chokepoint partition is non-empty on both sides, within-tier ordering is by
 * raw fan-in, and the labeling is deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  labelChangeSignificance,
  tierCounts,
  TIER_RANK,
  type ChangedSymbolFacts,
} from './change-significance.js';

function facts(over: Partial<ChangedSymbolFacts> & { id: string }): ChangedSymbolFacts {
  return {
    name: over.id.split('::')[1] ?? over.id,
    filePath: over.id.split('::')[0] ?? 'x.ts',
    fanIn: 0, fanOut: 0, isHub: false, isOrchestrator: false, isChokepoint: false, churn: 0,
    ...over,
  };
}

// A stable hub (high fan-in funnel, low churn) among many trivial leaf changes.
const stableHub = facts({ id: 'src/core.ts::coreHub', fanIn: 9, fanOut: 2, isHub: true, isChokepoint: true, churn: 1 });
const leaf1 = facts({ id: 'src/core.ts::leafA', fanIn: 0 });
const leaf2 = facts({ id: 'src/util.ts::leafB', fanIn: 1 });
const leaf3 = facts({ id: 'src/util.ts::leafC', fanIn: 0 });

describe('labelChangeSignificance', () => {
  it('ranks a stable hub top as surprising-change among trivial changes', () => {
    const out = labelChangeSignificance([leaf1, stableHub, leaf2, leaf3], { historyAvailable: true });
    expect(out[0].name).toBe('coreHub');
    expect(out[0].tier).toBe('surprising-change');
    // carries the raw evidence behind the label
    expect(out[0].evidence).toMatchObject({ fanIn: 9, priorChurn: 1, volatility: 'low' });
    expect(out[0].labels).toContain('hub');
    // trivial leaves sink to ordinary-change
    expect(out.slice(1).every(c => c.tier === 'ordinary-change')).toBe(true);
  });

  it('withholds surprising-change when history is too shallow (falls back to hub-change)', () => {
    const out = labelChangeSignificance([stableHub], { historyAvailable: false });
    expect(out[0].tier).not.toBe('surprising-change');
    // a chokepoint hub falls back to chokepoint-change; the point is: no surprise without history
    expect(['hub-change', 'chokepoint-change']).toContain(out[0].tier);
  });

  it('partitions hubs into hub-change (orchestrator) and chokepoint-change (funnel), both non-empty', () => {
    // both hubs are VOLATILE (high churn) so neither is surprising — the partition shows
    const orchHub = facts({ id: 'src/o.ts::orchHub', fanIn: 6, fanOut: 30, isHub: true, isOrchestrator: true, churn: 50 });
    const funnelHub = facts({ id: 'src/f.ts::funnelHub', fanIn: 7, fanOut: 1, isHub: true, isChokepoint: true, churn: 50 });
    const out = labelChangeSignificance([funnelHub, orchHub], { historyAvailable: true });
    const byName = Object.fromEntries(out.map(c => [c.name, c.tier]));
    expect(byName['orchHub']).toBe('hub-change');
    expect(byName['funnelHub']).toBe('chokepoint-change');
    // tier order: hub-change outranks chokepoint-change
    expect(out[0].name).toBe('orchHub');
  });

  it('orders within a tier by raw fan-in, then stable file/name tiebreak', () => {
    const a = facts({ id: 'src/z.ts::a', fanIn: 3 });
    const b = facts({ id: 'src/a.ts::b', fanIn: 7 });
    const c = facts({ id: 'src/a.ts::c', fanIn: 7 });
    const out = labelChangeSignificance([a, b, c], { historyAvailable: true });
    // all ordinary; b & c (fanIn 7) before a (fanIn 3); b before c by name within same file
    expect(out.map(x => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('a brand-new hub with zero prior churn is surprising (priorChurn=0 disclosed)', () => {
    const newHub = facts({ id: 'src/new.ts::newHub', fanIn: 10, fanOut: 2, isHub: true, isChokepoint: true, churn: 0 });
    const out = labelChangeSignificance([newHub], { historyAvailable: true });
    expect(out[0].tier).toBe('surprising-change');
    expect(out[0].evidence.priorChurn).toBe(0);
  });

  it('is deterministic — byte-identical for the same input', () => {
    const input = [leaf1, stableHub, leaf2, leaf3];
    const a = JSON.stringify(labelChangeSignificance(input, { historyAvailable: true }));
    const b = JSON.stringify(labelChangeSignificance(input, { historyAvailable: true }));
    expect(a).toBe(b);
  });

  it('tierCounts rolls up the full labeled set', () => {
    const out = labelChangeSignificance([leaf1, stableHub, leaf2, leaf3], { historyAvailable: true });
    const counts = tierCounts(out);
    expect(counts['surprising-change']).toBe(1);
    expect(counts['ordinary-change']).toBe(3);
  });

  it('tier rank order is surprising > hub > chokepoint > ordinary', () => {
    expect(TIER_RANK['surprising-change']).toBeGreaterThan(TIER_RANK['hub-change']);
    expect(TIER_RANK['hub-change']).toBeGreaterThan(TIER_RANK['chokepoint-change']);
    expect(TIER_RANK['chokepoint-change']).toBeGreaterThan(TIER_RANK['ordinary-change']);
  });
});
