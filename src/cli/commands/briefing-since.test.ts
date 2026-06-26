/**
 * `openlore briefing-since` CLI surface (change: add-change-significance-briefing).
 * Verifies the human renderer and exit codes over a mocked handler: tiers render
 * with their icons + evidence, the base-ref fallback and shallow-history warnings
 * surface, --json passes the conclusion through verbatim, and an error result exits 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/services/mcp-handlers/briefing-since.js', () => ({
  handleBriefingSince: vi.fn(),
}));

const writes: string[] = [];
vi.mock('../output.js', () => ({
  writeStdout: vi.fn(async (s: string) => { writes.push(s); }),
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn((s: string) => writes.push(`WARN ${s}`)) },
  configureLogger: vi.fn(),
}));

import { runBriefingSinceCli } from './briefing-since.js';
import { handleBriefingSince } from '../../core/services/mcp-handlers/briefing-since.js';

const mockedHandler = vi.mocked(handleBriefingSince);

function fullResult(over: Record<string, unknown> = {}) {
  return {
    baseRef: 'mainsha',
    scope: 'repo',
    changedFiles: 3,
    changedSymbols: 4,
    tierCounts: { 'surprising-change': 1, 'hub-change': 1, 'chokepoint-change': 0, 'ordinary-change': 2 },
    briefing: [
      { name: 'coreHub', file: 'src/core.ts', community: 'core', tier: 'surprising-change', labels: ['hub', 'chokepoint'], evidence: { fanIn: 9, fanOut: 2, priorChurn: 1, volatility: 'low' } },
      { name: 'orchHub', file: 'src/orch.ts', community: 'orch', tier: 'hub-change', labels: ['hub', 'orchestrator'], evidence: { fanIn: 6, fanOut: 30, priorChurn: 20, volatility: 'high' } },
    ],
    truncation: { bounded: true, returned: 2, omitted: 2, lowestTierReached: 'hub-change', omittedByTier: { 'ordinary-change': 2 } },
    regions: [{ community: 'core', count: 1 }, { community: 'orch', count: 1 }],
    testsToRun: { count: 5, files: ['src/core.test.ts'] },
    surprisingChange: { available: true, historyCommitsScanned: 40 },
    caveats: ['Changed symbols are at FILE granularity: …'],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
});

describe('runBriefingSinceCli', () => {
  it('renders the tier-ranked briefing with evidence and a tests-to-run line', async () => {
    mockedHandler.mockResolvedValue(fullResult());
    const code = await runBriefingSinceCli({ cwd: '/repo', base: 'main' });
    const out = writes.join('');
    expect(code).toBe(0);
    expect(out).toContain('Change significance briefing since mainsha');
    expect(out).toContain('coreHub'); // surprising hub
    expect(out).toContain('fanIn=9');
    expect(out).toContain('🔥'); // surprising-change icon
    expect(out).toContain('🎯'); // hub-change icon
    expect(out).toContain('2 more omitted'); // truncation receipt
    expect(out).toContain('Tests to run for this change set: 5');
  });

  it('surfaces the base-ref fallback and shallow-history warnings', async () => {
    mockedHandler.mockResolvedValue(fullResult({
      baseRef: 'main',
      baseRefFallback: { requested: 'bogus', resolved: 'main' },
      surprisingChange: { available: false, reason: 'only 1 commit(s) of history', historyCommitsScanned: 1 },
      tierCounts: { 'surprising-change': 0, 'hub-change': 1, 'chokepoint-change': 0, 'ordinary-change': 3 },
    }));
    const code = await runBriefingSinceCli({ cwd: '/repo', base: 'bogus' });
    const out = writes.join('');
    expect(code).toBe(0);
    expect(out).toContain('requested base "bogus" not found');
    expect(out).toContain('surprising-change withheld');
  });

  it('passes the conclusion through verbatim with --json', async () => {
    const r = fullResult();
    mockedHandler.mockResolvedValue(r);
    const code = await runBriefingSinceCli({ cwd: '/repo', json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.briefing[0].name).toBe('coreHub');
    expect(parsed.tierCounts['surprising-change']).toBe(1);
  });

  it('exits 1 on an error result', async () => {
    mockedHandler.mockResolvedValue({ error: 'No analysis found. Run analyze_codebase first.' });
    const code = await runBriefingSinceCli({ cwd: '/repo' });
    expect(code).toBe(1);
    expect(writes.join('')).toMatch(/No analysis found/);
  });

  it('renders the "nothing changed" note honestly', async () => {
    mockedHandler.mockResolvedValue(fullResult({
      changedSymbols: 0,
      briefing: [],
      tierCounts: { 'surprising-change': 0, 'hub-change': 0, 'chokepoint-change': 0, 'ordinary-change': 0 },
      note: 'No production code changed since mainsha — "nothing changed", NOT "nothing significant".',
    }));
    const code = await runBriefingSinceCli({ cwd: '/repo' });
    expect(code).toBe(0);
    expect(writes.join('')).toContain('nothing changed');
  });
});
