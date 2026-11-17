/**
 * Hook health: one line per hook run in `.openlore/session-ledger/hook-runs.jsonl`, read back by
 * `openlore status` (change: hook-reliability, task 6.1; design section 4).
 *
 * Append-only lines survive hooks that run in parallel. The file is cut to its newest half past
 * 1 MB. Local only: nothing here is sent anywhere. Recording never throws and never changes what a
 * hook prints.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { OPENLORE_DIR } from '../../constants.js';
import { LOOP_MOMENTS, deliveredDir } from './hook-session.js';
import { sanitizeForTerminal } from '../../utils/misc.js';

export type HookOutcome = 'ok' | 'error' | 'overrun';

/**
 * One recorded run: time, moment, whole-process milliseconds, outcome, findings shown, and for an
 * `error`, what failed: without it a failed run cannot be diagnosed afterwards.
 */
export interface HookRun { t: string; moment: string; ms: number; outcome: HookOutcome; shown: number; reason?: string }

/** Longest `reason` kept in a record. */
const MAX_REASON_CHARS = 160;

/** A thrown value as one bounded line: `TypeError: x is not a function`. */
export function errorReason(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return boundedReason(text);
}

function boundedReason(text: string): string {
  return sanitizeForTerminal(text.split('\n')[0]).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
}

export interface MomentHealth {
  moment: string;
  runs: number;
  lastRun: string;
  p95Ms: number;
  errors: number;
  overruns: number;
  shown: number;
  /** The most recent failed run's reason, when one was recorded. */
  lastError?: { t: string; reason: string };
}

const MAX_BYTES = 1024 * 1024;
const WINDOW_MS = 7 * 24 * 3600 * 1000;

export function hookRunsPath(root: string): string {
  return join(root, OPENLORE_DIR, 'session-ledger', 'hook-runs.jsonl');
}

/** Append one run. Never throws: a record that cannot be written changes nothing. */
export async function recordHookRun(root: string, run: Omit<HookRun, 't'> & { t?: string }): Promise<void> {
  try {
    // Never the first writer of `.openlore/`: a repository without one gets no record.
    if (!existsSync(join(root, OPENLORE_DIR))) return;
    const path = hookRunsPath(root);
    mkdirSync(join(root, OPENLORE_DIR, 'session-ledger'), { recursive: true });
    const reason = run.outcome === 'error' && run.reason ? boundedReason(run.reason) : undefined;
    const line = JSON.stringify({ t: run.t ?? new Date().toISOString(), moment: run.moment, ms: Math.round(run.ms), outcome: run.outcome, shown: run.shown, ...(reason ? { reason } : {}) });
    // One descriptor for the append, the size, and the read: no check-then-use on the path.
    const fd = openSync(path, 'a+');
    let text: string | undefined;
    try {
      writeSync(fd, `${line}\n`);
      const size = fstatSync(fd).size;
      if (size > MAX_BYTES) {
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, 0);
        text = buf.toString('utf8');
      }
    } finally {
      closeSync(fd);
    }
    if (text !== undefined) {
      const lines = text.split('\n').filter(Boolean);
      await atomicWriteFile(path, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    }
  } catch { /* health is best-effort */ }
}

function parseRun(line: string): HookRun | undefined {
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    if (typeof r.t !== 'string' || typeof r.moment !== 'string' || typeof r.ms !== 'number') return undefined;
    if (r.outcome !== 'ok' && r.outcome !== 'error' && r.outcome !== 'overrun') return undefined;
    return {
      t: r.t, moment: r.moment, ms: r.ms, outcome: r.outcome, shown: typeof r.shown === 'number' ? r.shown : 0,
      ...(typeof r.reason === 'string' && r.reason ? { reason: boundedReason(r.reason) } : {}),
    };
  } catch {
    return undefined;
  }
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
}

/** Per moment, over the last 7 days: runs, last run, p95, errors, overruns, findings shown. */
export function readHookHealth(root: string, now = Date.now()): MomentHealth[] {
  let text: string;
  try { text = readFileSync(hookRunsPath(root), 'utf8'); } catch { return []; }
  const byMoment = new Map<string, HookRun[]>();
  for (const line of text.split('\n')) {
    const r = line.trim() ? parseRun(line) : undefined;
    if (!r) continue;
    const at = Date.parse(r.t);
    if (!Number.isFinite(at) || now - at > WINDOW_MS) continue;
    byMoment.set(r.moment, [...(byMoment.get(r.moment) ?? []), r]);
  }
  const order = (m: string) => { const i = (LOOP_MOMENTS as readonly string[]).indexOf(m); return i < 0 ? LOOP_MOMENTS.length : i; };
  return [...byMoment.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([moment, runs]) => {
      const failed = runs.filter(r => r.outcome === 'error' && r.reason).sort((a, b) => a.t.localeCompare(b.t)).at(-1);
      return {
      moment,
      runs: runs.length,
      lastRun: runs.map(r => r.t).sort().at(-1)!,
      p95Ms: p95(runs.map(r => r.ms)),
      errors: runs.filter(r => r.outcome === 'error').length,
      overruns: runs.filter(r => r.outcome === 'overrun').length,
      shown: runs.reduce((n, r) => n + r.shown, 0),
      ...(failed ? { lastError: { t: failed.t, reason: failed.reason! } } : {}),
      };
    });
}

/** What happened to the findings the hooks showed (design section 4); the four counts sum to `total`. */
export interface FindingOutcomes { total: number; fixed: number; decided: number; open: number; notAssessed: number }

/**
 * Over the session records touched in the last 7 days: each distinct finding shown, counted once,
 * as fixed, decided (a decision's title, rationale, or consequences cites its id, `f:1a2b3c4d`),
 * open (still in the last stop receipt), or not assessed. Precedence in that order. Read-only.
 */
export async function readFindingOutcomes(root: string, now = Date.now()): Promise<FindingOutcomes> {
  const out: FindingOutcomes = { total: 0, fixed: 0, decided: 0, open: 0, notAssessed: 0 };
  const dir = deliveredDir(root);
  let names: string[];
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return out; }
  const findings = new Map<string, { state?: string }>();
  for (const n of names) {
    try {
      // One descriptor for the age check and the read: no check-then-use on the path.
      const fd = openSync(join(dir, n), 'r');
      let text: string;
      try {
        if (now - fstatSync(fd).mtimeMs > WINDOW_MS) continue;
        text = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
      const rec = JSON.parse(text) as { findings?: Record<string, { state?: unknown }> };
      for (const [identity, f] of Object.entries(rec.findings ?? {})) {
        if (!/^[0-9a-f]{64}$/.test(identity) || !f || typeof f !== 'object') continue;
        const prior = findings.get(identity);
        const state = typeof f.state === 'string' ? f.state : undefined;
        // One finding in two sessions: its best outcome counts.
        if (!prior || (state === 'fixed') || (state === 'open' && !prior.state)) findings.set(identity, { state });
      }
    } catch { /* an unreadable record counts nothing */ }
  }
  let decisionText = '';
  try {
    const { loadDecisionStore } = await import('../decisions/store.js');
    const store = await loadDecisionStore(root, { readOnly: true });
    decisionText = store.decisions.map(d => `${d.title}\n${d.rationale}\n${d.consequences}`).join('\n');
  } catch { /* no decisions to join */ }
  for (const [identity, f] of findings) {
    out.total++;
    if (f.state === 'fixed') out.fixed++;
    else if (decisionText.includes(`f:${identity.slice(0, 8)}`)) out.decided++;
    else if (f.state === 'open') out.open++;
    else out.notAssessed++;
  }
  return out;
}
