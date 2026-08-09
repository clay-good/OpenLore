/**
 * A gate-blocking `verified` decision must read as "awaiting review" — a glyph
 * distinct from the done statuses (approved/synced), with a legend — and the row
 * must carry no raw ANSI when color is off (OutputContractsAreUniform, change:
 * fix-cli-output-hygiene).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { displayDecision, printDecisionLegend } from './decisions.js';
import { configureLogger } from '../../utils/logger.js';
import type { PendingDecision } from '../../types/index.js';

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { lines.push(String(m ?? '')); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

function decision(status: PendingDecision['status']): PendingDecision {
  return {
    id: 'a1b2c3d4',
    title: 'Use JWTs',
    rationale: 'stateless',
    status,
    confidence: 'high',
    affectedFiles: [],
    affectedDomains: [],
  } as unknown as PendingDecision;
}

describe('decisions rendering', () => {
  beforeEach(() => configureLogger({ noColor: true }));
  afterEach(() => { configureLogger({ noColor: false }); vi.restoreAllMocks(); });

  it('renders a verified decision with the awaiting-review glyph, not a done checkmark', () => {
    const out = capture(() => displayDecision(decision('verified')));
    expect(out).toContain('⧖');
    // Must not read as done (approved ● / synced ✔ / a bare ✓).
    expect(out).not.toContain('✔');
    expect(out).not.toMatch(/(^|[^⧖])✓/);
  });

  it('gives synced and approved distinct glyphs', () => {
    expect(capture(() => displayDecision(decision('synced')))).toContain('✔');
    expect(capture(() => displayDecision(decision('approved')))).toContain('●');
  });

  it('discloses when a decision has no verification evidence', () => {
    const out = capture(() => displayDecision({
      ...decision('verified'),
      verificationEvidence: 'none',
    }, true));
    expect(out).toContain('Verification evidence: none');
  });

  it('warns when approval text was extracted by an LLM from repository content', () => {
    const out = capture(() => displayDecision({
      ...decision('verified'),
      contentOrigin: 'llm-extracted',
    }));
    expect(out).toContain('LLM-extracted from repository content');
    expect(out).toContain('review all text before approval');
  });

  it('labels agent-recorded content and strips terminal controls from verbose fields', () => {
    const out = capture(() => displayDecision({
      ...decision('verified'),
      contentOrigin: 'agent-recorded',
      rationale: 'safe\x1b[2J\nFORGED APPROVAL',
      proposedRequirement: 'SHALL\x1b]8;;https://evil.example\x07click',
      evidenceFile: 'src/x.ts\nAPPROVED',
    }, true));
    expect(out).toContain('Content origin: agent-recorded');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\nFORGED APPROVAL');
  });

  it('labels legacy provenance as unknown and strips controls from scope', () => {
    const out = capture(() => displayDecision({
      ...decision('verified'),
      contentOrigin: 'legacy-unknown',
      scope: 'component\x1b]8;;https://evil.example\x07' as PendingDecision['scope'],
    }, true));
    expect(out).toContain('Content origin: legacy/unknown');
    expect(out).not.toContain('\x1b');
  });

  it('legend explains that verified means awaiting review', () => {
    const legend = capture(() => printDecisionLegend());
    expect(legend.toLowerCase()).toContain('awaiting review');
    expect(legend).toContain('⧖');
  });

  it('emits no raw ANSI escape bytes when color is off', () => {
    const out = capture(() => { displayDecision(decision('verified')); printDecisionLegend(); });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });
});
