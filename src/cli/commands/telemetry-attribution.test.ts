/**
 * Agent/session attribution in the telemetry report
 * (change: scope-telemetry-by-agent-and-session).
 *
 * These pin the two failures that made a shared repository's telemetry
 * uninterpretable: one agent's calls landing in another's statistics, and an
 * interval metric pairing one actor's stale warning with another actor's later
 * orientation (which once reported a two-hour "recovery latency").
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeAgentBreakdown,
  computeRecovery,
  computeObstinacy,
  filterByAgent,
  renderSummary,
  renderTelemetryLine,
  type McpEvent,
  type LeaseEvent,
  type CacheEvent,
} from './telemetry.js';

const BASE = Date.parse('2026-08-12T10:00:00.000Z');
const ts = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

function call(tool: string, offsetMs: number, agent?: string, session?: string): McpEvent {
  return { ts: ts(offsetMs), event: 'tool_call', tool, ms: 10, agent, session_id: session };
}
function stale(offsetMs: number, agent?: string, session?: string): LeaseEvent {
  return { ts: ts(offsetMs), event: 'stale', depth: 1, agent, session_id: session };
}
function cacheRead(hit: boolean, agent?: string, session?: string): CacheEvent {
  return { ts: ts(0), event: 'cache_read', hit, agent, session_id: session };
}

describe('per-agent aggregation', () => {
  it('never attributes one agent\'s calls to another', () => {
    const mcp = [
      call('orient', 0, 'opencode', 's1'),
      call('analyze_codebase', 1_000, 'opencode', 's1'),
      call('report_coverage_gaps', 2_000, 'claude-code', 's2'),
    ];
    const breakdown = computeAgentBreakdown(mcp, []);

    const claude = breakdown.per_agent.find(a => a.agent === 'claude-code')!;
    expect(claude.calls).toBe(1);
    expect(claude.top_tools.map(t => t.tool)).not.toContain('analyze_codebase');
    expect(claude.top_tools.map(t => t.tool)).not.toContain('orient');

    const opencode = breakdown.per_agent.find(a => a.agent === 'opencode')!;
    expect(opencode.calls).toBe(2);
  });

  it('reports a cross-agent total that belongs to no single agent', () => {
    const mcp = [call('orient', 0, 'a', 's1'), call('orient', 1, 'b', 's2')];
    const breakdown = computeAgentBreakdown(mcp, []);

    expect(breakdown.across_agents.agents).toBe(2);
    expect(breakdown.across_agents.calls).toBe(2);
    expect(breakdown.per_agent.every(a => a.calls === 1)).toBe(true);
  });

  it('keeps cache hit rates separate per agent', () => {
    const cache = [
      cacheRead(true, 'a', 's1'), cacheRead(true, 'a', 's1'),
      cacheRead(false, 'b', 's2'), cacheRead(false, 'b', 's2'),
    ];
    const breakdown = computeAgentBreakdown([], cache);

    expect(breakdown.per_agent.find(a => a.agent === 'a')!.cache.hit_rate).toBe(100);
    expect(breakdown.per_agent.find(a => a.agent === 'b')!.cache.hit_rate).toBe(0);
    expect(breakdown.across_agents.cache.hit_rate).toBe(50);
  });

  it('counts sessions per agent', () => {
    const mcp = [
      call('orient', 0, 'a', 's1'),
      call('orient', 1, 'a', 's2'),
      call('orient', 2, 'a', 's2'),
    ];
    expect(computeAgentBreakdown(mcp, []).per_agent[0]!.sessions).toBe(2);
  });

  it('reports identity-less events under unknown, never merged into a named agent', () => {
    const mcp = [call('orient', 0, 'claude-code', 's1'), call('get_signatures', 1_000)];
    const breakdown = computeAgentBreakdown(mcp, []);

    expect(breakdown.per_agent.find(a => a.agent === 'claude-code')!.calls).toBe(1);
    expect(breakdown.per_agent.find(a => a.agent === 'unknown')!.calls).toBe(1);
  });

  it('treats malformed persisted identities as unknown instead of crashing', () => {
    const malformed = {
      ...call('orient', 0),
      agent: { unexpected: 'object' },
      session_id: 42,
    } as unknown as McpEvent;

    const breakdown = computeAgentBreakdown([malformed], []);
    expect(breakdown.per_agent).toHaveLength(1);
    expect(breakdown.per_agent[0]!.agent).toBe('unknown');
    expect(breakdown.per_agent[0]!.sessions).toBe(1);
  });
});

describe('--agent filter', () => {
  it('returns only the named agent\'s events', () => {
    const mcp = [call('orient', 0, 'a', 's1'), call('orient', 1, 'b', 's2')];
    expect(filterByAgent(mcp, 'a')).toHaveLength(1);
    expect(filterByAgent(mcp, 'a')[0]!.agent).toBe('a');
  });

  it('selects identity-less events under "unknown"', () => {
    const mcp = [call('orient', 0, 'a', 's1'), call('orient', 1)];
    expect(filterByAgent(mcp, 'unknown')).toHaveLength(1);
    expect(filterByAgent(mcp, 'unknown')[0]!.agent).toBeUndefined();
  });

  it('returns everything when no agent is given', () => {
    const mcp = [call('orient', 0, 'a', 's1'), call('orient', 1, 'b', 's2')];
    expect(filterByAgent(mcp, undefined)).toHaveLength(2);
  });
});

describe('session-bounded interval metrics', () => {
  it('excludes a cross-session pair instead of averaging it', () => {
    // The two-hour latency: one actor goes stale, a DIFFERENT session orients later.
    const lease = [stale(0, 'claude-code', 's1')];
    const mcp = [call('orient', 7_414_139, 'opencode', 's2')];

    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBeNull();
    expect(r.recovery_excluded_pairs).toBe(1);
    expect(r.recovery_sessions).toBe(0);
  });

  it('measures a within-session pair', () => {
    const lease = [stale(0, 'claude-code', 's1')];
    const mcp = [call('orient', 45_000, 'claude-code', 's1')];

    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBe(45_000);
    expect(r.recovery_sessions).toBe(1);
    expect(r.recovery_excluded_pairs).toBe(0);
  });

  it('excludes a same-agent pair that spans two sessions', () => {
    const lease = [stale(0, 'claude-code', 's1')];
    const mcp = [call('orient', 60_000, 'claude-code', 's2')];

    expect(computeRecovery(mcp, lease).avg_recovery_ms).toBeNull();
    expect(computeRecovery(mcp, lease).recovery_excluded_pairs).toBe(1);
  });

  it('does not let delimiter characters collapse distinct identities', () => {
    const lease = [stale(0, 'a\0b', 'c')];
    const mcp = [call('orient', 60_000, 'a', 'b\0c')];

    const result = computeRecovery(mcp, lease);
    expect(result.avg_recovery_ms).toBeNull();
    expect(result.recovery_excluded_pairs).toBe(1);
  });

  it('never pairs a legacy event with an identified one', () => {
    const lease = [stale(0)];                                  // no identity
    const mcp = [call('orient', 60_000, 'claude-code', 's1')]; // identified

    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBeNull();
    expect(r.recovery_excluded_pairs).toBe(1);
    expect(r.unattributed_events).toBe(1);
  });

  it('keeps measuring wholly legacy data as one implicit session', () => {
    const lease = [stale(0)];
    const mcp = [call('orient', 45_000)];

    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBe(45_000);
    expect(r.recovery_sessions).toBe(1);
  });

  it('reports no qualifying pair without inventing a value', () => {
    const r = computeRecovery([], [stale(0, 'a', 's1')]);
    expect(r.avg_recovery_ms).toBeNull();
    expect(r.recovery_excluded_pairs).toBe(0);  // no later candidate at all
    expect(r.recovery_sessions).toBe(0);
  });

  it('does not count another session\'s tool calls as this session\'s obstinacy', () => {
    const lease = [stale(0, 'claude-code', 's1')];
    const mcp = [
      call('search_code', 1_000, 'opencode', 's2'),
      call('get_subgraph', 2_000, 'opencode', 's2'),
      call('orient', 3_000, 'claude-code', 's1'),
    ];

    const r = computeObstinacy(mcp, lease);
    expect(r.total_stale_episodes).toBe(1);
    expect(r.episodes[0]!.calls_before_orient).toBe(0);
  });

  it('counts the same-session tool calls as obstinacy', () => {
    const lease = [stale(0, 'claude-code', 's1')];
    const mcp = [
      call('search_code', 1_000, 'claude-code', 's1'),
      call('get_subgraph', 2_000, 'claude-code', 's1'),
      call('orient', 3_000, 'claude-code', 's1'),
    ];

    expect(computeObstinacy(mcp, lease).episodes[0]!.calls_before_orient).toBe(2);
  });
});

describe('terminal rendering boundary', () => {
  it('sanitizes and bounds agent and tool labels in summaries', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const hostileAgent = `agent\n\u001b]52;c;forged\u0007${'x'.repeat(200)}`;
    const hostileTool = `tool\r\n\u001b[2J${'y'.repeat(200)}`;

    renderSummary([call(hostileTool, 0, hostileAgent, 's1')], [], [], [], []);

    const lines = log.mock.calls.map(args => String(args[0]));
    // eslint-disable-next-line no-control-regex -- proving no terminal controls survive rendering
    expect(lines.every(line => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(line))).toBe(true);
    expect(lines.some(line => line.includes('…'))).toBe(true);
    expect(lines.some(line => line.includes('\u001b[2J'))).toBe(false);
    log.mockRestore();
  });

  it('sanitizes live event fields before writing them to the terminal', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const payload = JSON.stringify({
      ts: '2026-08-12T10:00:00.000Z',
      event: 'tool_call',
      tool: 'orient\nFORGED\u001b[2J',
      ms: 12,
      agent: 'bad\u001b]0;title\u0007agent',
    });

    renderTelemetryLine('/repo/.openlore/telemetry/mcp.jsonl', payload, '/repo/.openlore/telemetry/epistemic-lease.jsonl');

    const rendered = String(log.mock.calls[0]?.[0]);
    // eslint-disable-next-line no-control-regex -- proving no terminal controls survive rendering
    expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(rendered).toContain('orientFORGED');
    expect(rendered).toContain('[bad]0;titleagent]');
    log.mockRestore();
  });
});
