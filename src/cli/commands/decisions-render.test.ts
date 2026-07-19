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
