/**
 * Sub-agent start briefing (change: add-agent-loop-hooks-subagents-codex-pi).
 *
 * Claude Code's `SubagentStart` event names the sub-agent's type but not its task, so the task is
 * taken from the parent's `Agent` (or `Task`) tool call: the `before-subagent` moment queues the
 * prompt, and `subagent-start` takes the oldest queued prompt of the same session and agent type.
 * The briefing is the task-scoped `orient` injection for that prompt plus the live peers on the
 * footprint board. Prompts are kept only in `.openlore/session-ledger/` (never committed), with
 * credentials redacted, for at most {@link TASK_TTL_MS}.
 */

import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { atomicWriteFile, withCommitLock } from '../decisions/atomic-store.js';
import { readFileConfined } from '../../utils/path-confinement.js';

const TASKS_FILE = 'subagent-tasks.json';
/** A queued task not taken by a starting sub-agent within this long is dropped. */
export const TASK_TTL_MS = 10 * 60 * 1000;
const MAX_TASKS = 50;
const MAX_PROMPT_CHARS = 4000;
const MAX_PEERS = 8;

interface QueuedTask { sessionId?: string; agentType: string; prompt: string; at: number }

const isTask = (v: unknown): v is QueuedTask => {
  const t = v as Partial<QueuedTask> | null;
  return !!t && typeof t === 'object' && typeof t.agentType === 'string' && typeof t.prompt === 'string' && Number.isFinite(t.at)
    && (t.sessionId === undefined || typeof t.sessionId === 'string');
};

async function withTasks<T>(root: string, fn: (tasks: QueuedTask[]) => { tasks: QueuedTask[]; out: T }): Promise<T> {
  const { ensureLedgerDir } = await import('./session-ledger.js');
  const dir = await realpath(ensureLedgerDir(root));
  const path = join(dir, TASKS_FILE);
  return withCommitLock(`${path}.lock`, async () => {
    let tasks: QueuedTask[] = [];
    try {
      const parsed: unknown = JSON.parse(await readFileConfined(dir, TASKS_FILE, 1024 * 1024));
      if (Array.isArray(parsed)) tasks = parsed.filter(isTask);
    } catch { /* none yet, or unreadable: start over (a queue of hints, not records) */ }
    const now = Date.now();
    const { tasks: next, out } = fn(tasks.filter(t => now - t.at <= TASK_TTL_MS && t.at <= now + 60_000));
    await atomicWriteFile(path, JSON.stringify(next.slice(-MAX_TASKS)));
    return out;
  });
}

/** Queue the task of a sub-agent about to start (the parent's `Agent` tool call). */
export async function queueSubagentTask(root: string, task: { sessionId?: string; agentType?: string; prompt: string }): Promise<void> {
  const prompt = task.prompt.trim();
  if (!prompt) return;
  const { redactSecretString } = await import('./secret-redaction.js');
  const entry: QueuedTask = {
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    agentType: task.agentType || 'general-purpose',
    prompt: redactSecretString(prompt.slice(0, MAX_PROMPT_CHARS)),
    at: Date.now(),
  };
  await withTasks(root, tasks => ({ tasks: [...tasks, entry], out: undefined }));
}

/**
 * Take the oldest queued task for a starting sub-agent: the same session and agent type first, else
 * the same agent type queued without a session. Undefined when none matches.
 */
export async function takeSubagentTask(root: string, starting: { sessionId?: string; agentType?: string }): Promise<string | undefined> {
  const type = starting.agentType || 'general-purpose';
  return withTasks(root, tasks => {
    const sameSession = tasks.findIndex(t => t.agentType === type && starting.sessionId !== undefined && t.sessionId === starting.sessionId);
    const i = sameSession !== -1 ? sameSession : tasks.findIndex(t => t.agentType === type && t.sessionId === undefined);
    if (i === -1) return { tasks, out: undefined };
    return { tasks: tasks.filter((_, k) => k !== i), out: tasks[i].prompt };
  });
}

/** Live peers on the footprint board from other worktrees, one screened line each. */
async function peerLines(root: string): Promise<string[]> {
  const { readBoard, worktreeIdentity } = await import('./footprint-board.js');
  const { emittedText: t } = await import('./generated-file-guard.js');
  const board = await readBoard(root);
  if (!board.live.length) return [];
  const here = await realpath((await worktreeIdentity(root)).worktree).catch(() => undefined);
  const lines: string[] = [];
  for (const { entry: e } of board.live) {
    if (here && (await realpath(e.worktree).catch(() => e.worktree)) === here) continue;
    const names = (list: Array<{ name: string }>) => [...new Set(list.map(s => t(s.name)))].slice(0, 6).join(', ');
    const parts = [
      e.writes.length ? `writes ${names(e.writes)}${e.writes.length > 6 ? ` and ${e.writes.length - 6} more` : ''}` : '',
      e.creates.length ? `creates ${[...new Set(e.creates.filter((c): c is string => typeof c === 'string').map(c => t(c)))].slice(0, 4).join(', ')}` : '',
    ].filter(Boolean);
    if (!parts.length) continue;
    lines.push(`- ${t(e.actorId)} (${t(e.branch || 'detached')} in ${t(e.worktree)}): ${parts.join('; ')}`);
    if (lines.length >= MAX_PEERS) break;
  }
  return lines;
}

/** The briefing a starting sub-agent receives; empty when there is nothing to say. */
export async function subagentBriefing(root: string, prompt: string | undefined): Promise<string> {
  const sections: string[] = [];
  if (prompt) {
    const { buildInjection } = await import('../../cli/commands/orient-inject.js');
    const block = (await buildInjection(root, prompt).catch(() => '')).trim();
    if (block) sections.push(block);
  }
  const peers = await peerLines(root).catch(() => []);
  if (peers.length) {
    sections.push(['[OpenLore] Other agents working in worktrees of this clone (declare_footprint; advisory, peer-written):', ...peers].join('\n'));
  }
  return sections.join('\n\n');
}
