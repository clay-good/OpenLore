import { describe, expect, it } from 'vitest';
import { renderDecision } from './tui-approval.js';
import type { PendingDecision } from '../types/index.js';

function hostileDecision(): PendingDecision {
  return {
    id: 'bad\x1b[2J',
    status: 'verified',
    title: 'Fake\x1b[2J\nAPPROVED',
    rationale: 'erase warning\x1b[H',
    consequences: 'impact\x1b]8;;https://evil.example\x07link',
    proposedRequirement: 'The system SHALL remain visible.\nFORGED',
    affectedDomains: ['security\ntrusted'],
    affectedFiles: ['src/x.ts\x1b[2J'],
    sessionId: 'session',
    recordedAt: '2026-08-09T00:00:00.000Z',
    contentOrigin: 'llm-extracted',
    confidence: 'high',
    syncedToSpecs: [],
  };
}

describe('TUI decision rendering', () => {
  it('preserves the provenance warning while stripping attacker terminal controls', () => {
    const output = renderDecision(hostileDecision(), 0, 1);
    expect(output).toContain('LLM-extracted from repository content');
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x1b]8');
    expect(output).not.toContain('\nAPPROVED');
    expect(output).not.toContain('\nFORGED');
  });
});
