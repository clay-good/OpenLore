import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// The task-scoped orient injection is its own tested unit: here it only shows which prompt it got.
vi.mock('../../cli/commands/orient-inject.js', () => ({ buildInjection: vi.fn(async (_dir: string, prompt: string) => `[OpenLore] briefing for: ${prompt}`) }));

import { runHook } from '../../cli/commands/hook.js';
import { handleDeclareFootprint } from './mcp-handlers/declare-footprint.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../constants.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV }).toString().trim();
const write = (root: string, rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };

const CONFIG_TS = 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\n';
const nodes = [{ id: 'src/config.ts::parseConfig', name: 'parseConfig', filePath: 'src/config.ts', startIndex: 0, endIndex: 63, startLine: 1, endLine: 3, language: 'TypeScript' }];
const index = (root: string) => write(root, join(OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph: { nodes, edges: [] } }));

function clone(): { a: string; b: string } {
  const a = realpathSync(mkdtempSync(join(tmpdir(), 'olsub-')));
  dirs.push(a);
  write(a, '.gitignore', '.openlore/\n');
  write(a, 'src/config.ts', CONFIG_TS);
  git(a, 'init', '-q', '-b', 'main');
  git(a, 'add', '-A');
  git(a, 'commit', '-qm', 'init');
  const b = `${a}-b`;
  dirs.push(b);
  git(a, 'worktree', 'add', '-q', '-b', 'feat-b', b, 'main');
  index(a);
  index(b);
  return { a, b };
}

const agentCall = (root: string, prompt: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'd', prompt, subagent_type: 'Explore', ...extra } });
const start = (root: string, agentType = 'Explore', sessionId = 's1') =>
  JSON.stringify({ session_id: sessionId, cwd: root, hook_event_name: 'SubagentStart', agent_id: 'x1', agent_type: agentType });
const context = (stdout: string) => (stdout ? (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput : undefined);

describe('sub-agent start briefing', () => {
  it('the parent\'s Agent call is queued silently; the sub-agent gets the briefing for its own task', async () => {
    const { a } = clone();
    expect((await runHook('before-subagent', agentCall(a, 'Find where parseConfig is called'))).stdout).toBe('');
    const out = context((await runHook('subagent-start', start(a))).stdout);
    expect(out?.hookEventName).toBe('SubagentStart');
    expect(out?.additionalContext).toContain('briefing for: Find where parseConfig is called');
    // Taken once: a second sub-agent of the same type gets no task briefing.
    expect((await runHook('subagent-start', start(a))).stdout).toBe('');
  });

  it('parallel sub-agents each get their own task, matched by agent type then queue order', async () => {
    const { a } = clone();
    await runHook('before-subagent', agentCall(a, 'first explore task'));
    await runHook('before-subagent', agentCall(a, 'a plan task', { subagent_type: 'Plan' }));
    await runHook('before-subagent', agentCall(a, 'second explore task'));
    expect(context((await runHook('subagent-start', start(a, 'Plan'))).stdout)?.additionalContext).toContain('a plan task');
    expect(context((await runHook('subagent-start', start(a))).stdout)?.additionalContext).toContain('first explore task');
    expect(context((await runHook('subagent-start', start(a))).stdout)?.additionalContext).toContain('second explore task');
  });

  it('live peers from other worktrees are listed; credentials in a queued prompt are not stored', async () => {
    const { a, b } = clone();
    await handleDeclareFootprint({ directory: b, actorId: 'agent-b', writeSet: ['parseConfig'] });
    await runHook('before-subagent', agentCall(a, 'use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 to fetch'));
    const stored = readFileSync(join(a, OPENLORE_DIR, 'session-ledger', 'subagent-tasks.json'), 'utf-8');
    expect(stored).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const text = context((await runHook('subagent-start', start(a))).stdout)?.additionalContext ?? '';
    expect(text).toContain('agent-b (feat-b in');
    expect(text).toContain('writes parseConfig');
  });

  it('other tools, other sessions\' tasks, and a turned-off moment are quiet', async () => {
    const { a } = clone();
    await runHook('before-subagent', JSON.stringify({ session_id: 's1', cwd: a, tool_name: 'Edit', tool_input: { prompt: 'not an agent call' } }));
    await runHook('before-subagent', agentCall(a, 'session one task'));
    expect((await runHook('subagent-start', start(a, 'Explore', 's2'))).stdout).toBe('');
    write(a, join(OPENLORE_DIR, 'config.json'), JSON.stringify({ hooks: { 'subagent-start': false } }));
    expect((await runHook('subagent-start', start(a))).stdout).toBe('');
  });
});
