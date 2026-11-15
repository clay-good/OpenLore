/**
 * The per-session hook record and the moment list, shared by `openlore hook` and the
 * prompt-submitted moment (`openlore orient --inject`) (change: hook-reliability, task 3.1).
 *
 * Moved unchanged from `src/cli/commands/hook.ts`: the record of what each harness session has
 * already been told, and the commit it started from.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { OPENLORE_DIR } from '../../constants.js';

/** The moments `openlore hook <moment>` serves. */
export const HOOK_MOMENTS = ['before-edit', 'after-tools', 'before-stop', 'after-compact', 'before-subagent', 'subagent-start'] as const;
export type HookMoment = typeof HOOK_MOMENTS[number];

/** Every agent-loop moment: the prompt-submitted moment (`openlore orient --inject`) and the hook moments. */
export const LOOP_MOMENTS = ['prompt-submitted', ...HOOK_MOMENTS] as const;
export type LoopMoment = typeof LOOP_MOMENTS[number];

const MAX_DELIVERED = 2000;

export function deliveredDir(root: string): string {
  return join(root, OPENLORE_DIR, 'session-ledger', 'hook-delivered');
}

export function deliveredPath(root: string, sessionId: string): string {
  const id = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(deliveredDir(root), `${id}.json`);
}

/** Per harness session: the facts already delivered, and the commit the session started from. */
export interface SessionRecord { keys: Set<string>; startHead?: string }

export function readSession(root: string, sessionId: string | undefined): SessionRecord {
  if (!sessionId) return { keys: new Set() };
  try {
    const v = JSON.parse(readFileSync(deliveredPath(root, sessionId), 'utf-8')) as { keys?: unknown; startHead?: unknown } | unknown[];
    // Fail-open on an older or foreign shape.
    const keys = Array.isArray(v) ? v : Array.isArray((v as { keys?: unknown }).keys) ? (v as { keys: unknown[] }).keys : [];
    const head = Array.isArray(v) ? undefined : (v as { startHead?: unknown }).startHead;
    return { keys: new Set(keys.filter((x): x is string => typeof x === 'string')), ...(typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head) ? { startHead: head } : {}) };
  } catch {
    return { keys: new Set() };
  }
}

/**
 * Write the session record, merged with what a concurrent hook of the same session wrote meanwhile
 * (the harness runs matching hooks in parallel). Records untouched for a week are removed.
 */
export async function writeSession(root: string, sessionId: string | undefined, rec: SessionRecord): Promise<void> {
  if (!sessionId) return;
  try {
    const now = readSession(root, sessionId);
    const keys = [...new Set([...now.keys, ...rec.keys])].slice(-MAX_DELIVERED);
    await atomicWriteFile(deliveredPath(root, sessionId), JSON.stringify({ startHead: now.startHead ?? rec.startHead, keys }));
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const n of readdirSync(deliveredDir(root))) {
      try { if (statSync(join(deliveredDir(root), n)).mtimeMs < cutoff) unlinkSync(join(deliveredDir(root), n)); } catch { /* raced */ }
    }
  } catch { /* dedupe is best-effort: at worst a fact is said twice */ }
}
