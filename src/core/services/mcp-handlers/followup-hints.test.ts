/**
 * Follow-up hints (change: add-conclusion-followup-hints): a closed rule table that fires only on
 * fields already in the payload, at most two per response, attached at dispatch. Plain .test.ts so
 * CI runs it.
 */
import { describe, it, expect } from 'vitest';
import { followupHints, withFollowupHints, FOLLOWUP_HINT_RULES, MAX_FOLLOWUP_HINTS } from './followup-hints.js';
import { TOOL_OUTPUT_CLASS } from './tool-contract.js';

describe('the rule table is closed', () => {
  it('names only registered tools on both sides', () => {
    for (const rule of FOLLOWUP_HINT_RULES) {
      expect(TOOL_OUTPUT_CLASS[rule.forTool], rule.forTool).toBeDefined();
      expect(TOOL_OUTPUT_CLASS[rule.tool], rule.tool).toBeDefined();
      expect(rule.tool).not.toBe(rule.forTool);
    }
  });
});

describe('rules fire only on the payload field they name', () => {
  it('search_code: a hub top hit suggests analyze_impact, citing its fanIn', () => {
    const hub = { results: [{ name: 'dispatch', isHub: true, fanIn: 74 }, { name: 'x', isHub: false, fanIn: 1 }] };
    expect(followupHints('search_code', hub)).toEqual([{
      tool: 'analyze_impact',
      trigger: { field: 'results[0].fanIn', value: 74 },
      message: expect.stringContaining('"dispatch" is a hub (fanIn 74)'),
    }]);
    expect(followupHints('search_code', { results: [{ name: 'leaf', isHub: false, fanIn: 74 }] })).toEqual([]);
    expect(followupHints('search_code', { results: [] })).toEqual([]);
  });

  it('find_dead_code: low-confidence candidates suggest verify_claim', () => {
    expect(followupHints('find_dead_code', { byConfidence: { high: 2, medium: 0, low: 3 } })[0])
      .toMatchObject({ tool: 'verify_claim', trigger: { field: 'byConfidence.low', value: 3 } });
    expect(followupHints('find_dead_code', { byConfidence: { high: 2, medium: 0, low: 0 } })).toEqual([]);
  });

  it('blast_radius: specs that may go stale suggest check_spec_drift', () => {
    expect(followupHints('blast_radius', { specs: { willGoStale: 2, items: [] } })[0])
      .toMatchObject({ tool: 'check_spec_drift', trigger: { field: 'specs.willGoStale', value: 2 } });
    expect(followupHints('blast_radius', { specs: { willGoStale: 0, items: [] } })).toEqual([]);
  });

  it('never fires on errors, other tools, or non-object payloads', () => {
    expect(followupHints('blast_radius', { error: 'x', specs: { willGoStale: 2 } })).toEqual([]);
    expect(followupHints('orient', { specs: { willGoStale: 2 } })).toEqual([]);
    expect(followupHints('search_code', 'text')).toEqual([]);
    expect(followupHints('search_code', [{ isHub: true }])).toEqual([]);
  });
});

describe('withFollowupHints', () => {
  it('adds followUp only when a rule fires and leaves other payloads untouched', () => {
    const quiet = { specs: { willGoStale: 0 } };
    expect(withFollowupHints('blast_radius', quiet)).toBe(quiet);
    const loud = withFollowupHints('blast_radius', { specs: { willGoStale: 1 }, summary: 's' }) as Record<string, unknown>;
    expect(loud.summary).toBe('s');
    expect(loud.followUp).toHaveLength(1);
  });

  it('caps hints per response', () => {
    expect(MAX_FOLLOWUP_HINTS).toBe(2);
  });
});
