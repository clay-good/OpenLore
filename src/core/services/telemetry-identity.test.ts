/**
 * Telemetry emitting identity (change: scope-telemetry-by-agent-and-session).
 *
 * The load-bearing property: a repository shared by two agents must stay
 * separable at READ time, which is only possible if identity was stamped at
 * WRITE time. These tests pin the stamping, the per-process session id, and the
 * invariant that identity resolution can never cost the caller an event.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emit,
  getTelemetryIdentity,
  setTelemetryIdentity,
  setTelemetryIdentitySource,
  resetTelemetryIdentityForTests,
  relativizeTelemetryPaths,
  _relativizeTelemetryPathsWithPrefixes,
} from './telemetry.js';
import { OPENLORE_DIR } from '../../constants.js';

let dir: string;
const prevFlag = process.env['OPENLORE_TELEMETRY'];

function readEvents(domain: string): Record<string, unknown>[] {
  const file = join(dir, OPENLORE_DIR, 'telemetry', `${domain}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openlore-telemetry-identity-'));
  process.env['OPENLORE_TELEMETRY'] = '1';
  resetTelemetryIdentityForTests();
});

afterEach(() => {
  resetTelemetryIdentityForTests();
  if (prevFlag === undefined) delete process.env['OPENLORE_TELEMETRY'];
  else process.env['OPENLORE_TELEMETRY'] = prevFlag;
  rmSync(dir, { recursive: true, force: true });
});

describe('telemetry identity', () => {
  it('stamps agent, version, and session id on every event', () => {
    setTelemetryIdentity('claude-code', '2.1.0');
    emit(dir, 'mcp', { event: 'tool_call', tool: 'orient', ms: 12 });

    const [event] = readEvents('mcp');
    expect(event['agent']).toBe('claude-code');
    expect(event['agent_version']).toBe('2.1.0');
    expect(event['session_id']).toBeTypeOf('string');
    expect(String(event['session_id']).length).toBeGreaterThan(0);
  });

  it('keeps one session id across every event of a process', () => {
    setTelemetryIdentity('claude-code', '2.1.0');
    emit(dir, 'mcp', { event: 'tool_call', tool: 'orient', ms: 1 });
    emit(dir, 'mcp', { event: 'tool_call', tool: 'search_code', ms: 2 });

    const ids = new Set(readEvents('mcp').map(e => e['session_id']));
    expect(ids.size).toBe(1);
  });

  it('mints a distinct session id per process', () => {
    // resetTelemetryIdentityForTests() models a fresh process: the module state
    // a second `openlore`/MCP process would start from.
    setTelemetryIdentity('agent-a', '1.0.0');
    const first = getTelemetryIdentity().session_id;

    resetTelemetryIdentityForTests();
    setTelemetryIdentity('agent-b', '1.0.0');
    const second = getTelemetryIdentity().session_id;

    expect(second).not.toBe(first);
  });

  it('keeps the session id when a client identifies itself late', () => {
    const before = getTelemetryIdentity().session_id;
    setTelemetryIdentity('opencode', '0.4.0');

    const after = getTelemetryIdentity();
    expect(after.agent).toBe('opencode');
    expect(after.session_id).toBe(before);
  });

  it('degrades a throwing identity source to unknown without costing the event', () => {
    setTelemetryIdentitySource(() => { throw new Error('identity source exploded'); });

    expect(() => emit(dir, 'mcp', { event: 'tool_call', tool: 'orient', ms: 3 })).not.toThrow();

    const [event] = readEvents('mcp');
    expect(event).toBeDefined();
    expect(event['agent']).toBe('unknown');
    expect(event['agent_version']).toBe('unknown');
    expect(event['session_id']).toBeTypeOf('string');
  });

  it('resolves a lazy identity source at most once', () => {
    let calls = 0;
    setTelemetryIdentitySource(() => { calls++; return { agent: 'cli:analyze', agentVersion: '9.9.9' }; });

    emit(dir, 'mcp', { event: 'tool_call', tool: 'a', ms: 1 });
    emit(dir, 'mcp', { event: 'tool_call', tool: 'b', ms: 1 });

    expect(calls).toBe(1);
    expect(readEvents('mcp').every(e => e['agent'] === 'cli:analyze')).toBe(true);
  });

  it('lets an explicit identity win over a lazy source', () => {
    setTelemetryIdentity('claude-code', '2.1.0');
    setTelemetryIdentitySource(() => ({ agent: 'cli:analyze', agentVersion: '9.9.9' }));

    expect(getTelemetryIdentity().agent).toBe('claude-code');
  });

  it('lets a call site that states its own agent keep that attribution', () => {
    // The orient events already carry the agent they were called by; identity
    // must not overwrite a more specific attribution.
    setTelemetryIdentity('claude-code', '2.1.0');
    emit(dir, 'orient', { event: 'orient_call', agent: 'opencode', functions: 3, files: 2 });

    const [event] = readEvents('orient');
    expect(event['agent']).toBe('opencode');
    expect(event['session_id']).toBeTypeOf('string');
  });

  it.each([undefined, '', '0', 'false', 'true', 'typo'])(
    'emits nothing unless OPENLORE_TELEMETRY is exactly 1 (value: %s)',
    (value) => {
    if (value === undefined) delete process.env['OPENLORE_TELEMETRY'];
    else process.env['OPENLORE_TELEMETRY'] = value;
    setTelemetryIdentity('claude-code', '2.1.0');

    emit(dir, 'mcp', { event: 'tool_call', tool: 'orient', ms: 1 });

    expect(readEvents('mcp')).toHaveLength(0);
    },
  );

  it('still redacts secrets once identity is merged in', () => {
    setTelemetryIdentity('claude-code', '2.1.0');
    emit(dir, 'mcp', { event: 'tool_call', tool: 'orient', ms: 1, api_key: 'sk-ant-secret-value' });

    const line = JSON.stringify(readEvents('mcp')[0]);
    expect(line).not.toContain('sk-ant-secret-value');
  });

  it('relativizes project and home paths in error and module fields', () => {
    const projectFile = join(dir, 'src', 'payments.ts');
    const homeFile = join(homedir(), 'private', 'outside.ts');

    emit(dir, 'mcp', {
      event: 'tool_error',
      error: `failed at ${projectFile}:12 and ${homeFile}`,
      module: projectFile,
      untouched: projectFile,
    });

    const [event] = readEvents('mcp');
    expect(event['error']).toContain('src/payments.ts:12');
    expect(event['error']).toContain('~/private/outside.ts');
    expect(event['module']).toBe(join('src', 'payments.ts'));
    expect(event['untouched']).toBe(projectFile);
  });

  it('keeps non-path telemetry text byte-identical', () => {
    expect(relativizeTelemetryPaths(dir, 'auth module timed out')).toBe('auth module timed out');
  });

  it('relativizes Windows prefixes with either slash spelling', () => {
    const root = 'C:\\Users\\Ada\\repo';
    const home = 'C:\\Users\\Ada';
    const value = 'C:/Users/Ada/repo/src/a.ts C:\\Users\\Ada\\repo\\src\\b.ts ' +
      'C:/Users/Ada/private/c.ts C:\\Users\\Ada\\private\\d.ts';

    expect(_relativizeTelemetryPathsWithPrefixes(value, root, home, true)).toBe(
      'src/a.ts src\\b.ts ~/private/c.ts ~/private\\d.ts',
    );
  });
});
