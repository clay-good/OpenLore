import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const blast = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock('./blast-radius.js', () => ({ computeBlastRadius: vi.fn(async () => blast.result) }));
vi.mock('./test-impact.js', () => ({
  handleSelectTests: vi.fn(async () => ({ selectedTests: [{ test: 'parses', file: 'src/config.test.ts' }] })),
}));

import { handleGetHandoffBriefing, renderHandoff } from './handoff.js';
import { runHook } from '../../../cli/commands/hook.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'olhand-')));
  dirs.push(root);
  mkdirSync(join(root, '.openlore'));
  for (const [rel, c] of Object.entries(files)) write(root, rel, c);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env: GIT_ENV });
  return root;
}

const briefing = (over: Record<string, unknown> = {}) => ({
  baseRef: 'HEAD', resolvedBaseRef: 'HEAD',
  changed: { files: 1, symbols: 1, symbolNames: ['parseConfig', 'helper'] },
  impact: { highestRiskLevel: 'high', maxAffectedCallers: 7, hubsTouched: [], layersCrossed: [], governingDecisions: [], governingDecisionProvenance: [], analyzedSymbolCount: 1,
    topSymbols: [{ symbol: 'parseConfig', file: 'src/config.ts', riskLevel: 'high', affectedCallers: 7, fanIn: 9, isHub: true }] },
  tests: { count: 1, toRun: [{ test: 'parses config', file: 'src/config.test.ts', confidence: 'high' }], soundness: null },
  memory: { drifted: 0, orphaned: 0, willDrift: [], orphanFindings: [] },
  specs: { willGoStale: 1, items: [{ kind: 'stale', message: 'Config parsing requirement may go stale', domain: 'config', specPath: null, provenance: 'reviewed-corpus' }] },
  decisions: { affected: 0, orphaned: 0, items: [], orphanFindings: [] },
  caveats: [],
  ...over,
});

const CHANGE = '# Tasks\n\n- [x] done thing\n- [ ] Handle empty `src/config.ts` input\n- [ ] Document defaults\n';

describe('get_handoff_briefing', () => {
  it('a clean tree says nothing is in flight, with the lease', async () => {
    const root = repo({ 'src/config.ts': 'export const a = 1;\n' });
    const r = await handleGetHandoffBriefing({ directory: root });
    expect(r.inFlight).toBe(false);
    expect(r.message).toContain('Nothing is in flight');
    expect(r.lease).toBeDefined();
  });

  it('composes touched symbols, open changes with unchecked tasks, tests, drifted specs and the uncommitted split', async () => {
    const root = repo({ 'src/config.ts': 'export const a = 1;\n', 'src/other.ts': 'export const b = 1;\n', 'openspec/changes/fix-config/tasks.md': CHANGE, 'openspec/changes/unrelated/tasks.md': '- [ ] other\n' });
    blast.result = briefing();
    write(root, 'src/config.ts', 'export const a = 2;\n');
    write(root, 'src/other.ts', 'export const b = 2;\n');
    execFileSync('git', ['add', 'src/other.ts'], { cwd: root, env: GIT_ENV });
    write(root, 'src/new.ts', 'export const c = 1;\n');
    const r = await handleGetHandoffBriefing({ directory: root }) as Record<string, unknown> & {
      touched: Array<{ symbol: string; callers?: number; expand: { tool: string } }>;
      openChanges: Array<{ change: string; uncheckedTasks: string[] }>;
      testsToRun: unknown[]; driftedSpecs: unknown[];
      unfinished: { uncommitted: { staged: string[]; unstaged: string[]; untracked: string[] } };
    };
    expect(r.inFlight).toBe(true);
    expect(r.touched.map(t => t.symbol)).toEqual(['helper', 'parseConfig']);
    expect(r.touched.find(t => t.symbol === 'parseConfig')).toMatchObject({ callers: 7, hub: true, expand: { tool: 'get_subgraph' } });
    expect(r.openChanges).toEqual([expect.objectContaining({ change: 'fix-config', uncheckedTasks: ['Handle empty `src/config.ts` input', 'Document defaults'] })]);
    expect(r.testsToRun).toEqual([{ test: 'parses config', file: 'src/config.test.ts' }]);
    expect(r.driftedSpecs).toHaveLength(1);
    expect(r.unfinished.uncommitted).toEqual({ staged: ['src/other.ts'], unstaged: ['src/config.ts'], untracked: ['src/new.ts'] });
    // Deterministic: the same state gives the same bytes.
    expect(JSON.stringify(await handleGetHandoffBriefing({ directory: root }))).toBe(JSON.stringify(r));
    expect(renderHandoff(r)).toContain('unchecked: "Handle empty `src/config.ts` input"');
  });

  it('a tight budget trims the least central sections first, with receipts naming the call', async () => {
    const root = repo({ 'src/config.ts': 'export const a = 1;\n' });
    blast.result = briefing({
      tests: { count: 60, toRun: Array.from({ length: 60 }, (_, i) => ({ test: `test number ${i} with a long name`, file: `src/t${i}.test.ts`, confidence: 'high' })), soundness: null },
    });
    write(root, 'src/config.ts', 'export const a = 2;\n');
    const r = await handleGetHandoffBriefing({ directory: root, tokenBudget: 300 }) as { touched: unknown[]; truncated: Record<string, { omitted: number; expand: { tool: string } }> };
    expect(r.truncated.testsToRun).toMatchObject({ expand: { tool: 'select_tests' } });
    expect(r.truncated.testsToRun.omitted).toBeGreaterThan(40);
    expect(r.touched.length).toBeGreaterThan(0); // touched symbols are kept longest
  });

  it('symbols this session committed survive a clean tree (session ledger)', async () => {
    const root = repo({ 'src/config.ts': 'export function parseConfig() { return 1; }\n' });
    const now = new Date().toISOString();
    write(root, `.openlore/session-ledger/${process.pid}.json`, JSON.stringify({
      schemaVersion: 1, pid: process.pid, root, startedAt: now, updatedAt: now, editSource: 'watcher', agentEditsReported: true,
      counts: { served: 1, edited: 1, untracked: 0, dropped: 0 }, backgroundChanges: [], editOscillation: [],
      edited: [{ id: 'src/config.ts::parseConfig', name: 'parseConfig', file: 'src/config.ts' }],
    }));
    const r = await handleGetHandoffBriefing({ directory: root }) as { inFlight: boolean; touched: Array<{ symbol: string; committedThisSession?: true }>; testsToRun: unknown[] };
    expect(r.inFlight).toBe(true);
    expect(r.touched).toEqual([expect.objectContaining({ symbol: 'parseConfig', committedThisSession: true })]);
    expect(r.testsToRun).toEqual([{ test: 'parses', file: 'src/config.test.ts' }]);
  });

  it('the after-compact hook prints the briefing as SessionStart context', async () => {
    const root = repo({ 'src/config.ts': 'export const a = 1;\n' });
    blast.result = briefing();
    write(root, 'src/config.ts', 'export const a = 2;\n');
    const r = await runHook('after-compact', JSON.stringify({ session_id: 'c', cwd: root, source: 'compact' }));
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('[openlore handoff] In-flight work');
    expect(out.hookSpecificOutput.additionalContext).toContain('parseConfig');
    writeFileSync(join(root, '.openlore', 'config.json'), JSON.stringify({ hooks: { 'after-compact': false } }));
    expect((await runHook('after-compact', JSON.stringify({ session_id: 'c', cwd: root }))).stdout).toBe('');
  });
});
