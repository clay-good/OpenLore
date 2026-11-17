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

/** Who a finding was shown to: the agent (hook context) or the user (the before-stop receipt). */
export type Audience = 'agent' | 'user';

/** One shown finding in the session record (change: hook-reliability, design section 3). */
export interface ShownFinding {
  code: string;
  subject: string;
  /** The moment that first showed it, and when. */
  moment: string;
  shownAt: string;
  audiences: Audience[];
  /** The check that produced it and the root-relative file it concerns, when known. */
  check?: string;
  file?: string;
  /**
   * What happened to it (design section 4): `fixed` when the same check ran again on its file after
   * an agent edit and did not report it; `open` when the last stop receipt still reported it.
   * Unset is not assessed. `decided` is joined from decisions when `openlore status` runs.
   */
  state?: FindingState;
}

export type FindingState = 'fixed' | 'open';

/**
 * The proof a finding rests on. With a cited line, its whitespace-normalized text is the proof and
 * the line NUMBER is left out, so lines added above it do not make it new. Without one, the
 * source's discriminator is (a run time, a return count, a kind).
 */
export interface FindingProof { path?: string; lineText?: string; discriminator?: string }

/**
 * A finding's identity: `sha256(code \0 subject \0 proofHash)`, and its printed id, the first 8
 * hex characters (`f:1a2b3c4d`). One finding has one identity at every moment.
 */
export function findingIdentity(code: string, subject: string, proof: FindingProof = {}): { identity: string; id: string } {
  const proofText = proof.lineText !== undefined
    ? `${proof.path ?? ''}\0line\0${proof.lineText.replace(/\s+/g, ' ').trim()}`
    : `${proof.path ?? ''}\0disc\0${proof.discriminator ?? ''}`;
  const proofHash = createHash('sha256').update(proofText).digest('hex');
  const identity = createHash('sha256').update(`${code}\0${subject}\0${proofHash}`).digest('hex');
  return { identity, id: identity.slice(0, 8) };
}

/**
 * Per harness session: the facts already delivered (`keys`, still written so an older CLI reads
 * the record), the findings shown with their identity, and the commit the session started from.
 */
export interface SessionRecord { keys: Set<string>; findings: Record<string, ShownFinding>; startHead?: string }

const MAX_FINDINGS = 2000;

function readFindings(v: unknown): Record<string, ShownFinding> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, ShownFinding> = {};
  for (const [identity, f] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/.test(identity) || !f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const audiences = Array.isArray(r.audiences) ? r.audiences.filter((a): a is Audience => a === 'agent' || a === 'user') : [];
    if (typeof r.code !== 'string' || typeof r.subject !== 'string' || !audiences.length) continue;
    out[identity] = {
      code: r.code, subject: r.subject, moment: String(r.moment ?? ''), shownAt: String(r.shownAt ?? ''), audiences,
      ...(typeof r.check === 'string' ? { check: r.check } : {}),
      ...(typeof r.file === 'string' ? { file: r.file } : {}),
      ...(r.state === 'fixed' || r.state === 'open' ? { state: r.state } : {}),
    };
  }
  return out;
}

export function readSession(root: string, sessionId: string | undefined): SessionRecord {
  if (!sessionId) return { keys: new Set(), findings: {} };
  try {
    const v = JSON.parse(readFileSync(deliveredPath(root, sessionId), 'utf-8')) as { keys?: unknown; startHead?: unknown; findings?: unknown } | unknown[];
    // Fail-open on an older or foreign shape.
    const keys = Array.isArray(v) ? v : Array.isArray((v as { keys?: unknown }).keys) ? (v as { keys: unknown[] }).keys : [];
    const head = Array.isArray(v) ? undefined : (v as { startHead?: unknown }).startHead;
    return {
      keys: new Set(keys.filter((x): x is string => typeof x === 'string')),
      findings: Array.isArray(v) ? {} : readFindings((v as { findings?: unknown }).findings),
      ...(typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head) ? { startHead: head } : {}),
    };
  } catch {
    return { keys: new Set(), findings: {} };
  }
}

/**
 * Whether this finding was already shown to `audience` in the session. A finding marked fixed that
 * is reported again counts as not shown: it came back.
 */
export function wasShown(rec: SessionRecord, identity: string, audience: Audience): boolean {
  const f = rec.findings[identity];
  return f?.audiences.includes(audience) === true && f.state !== 'fixed';
}

/** Record that a finding was shown to `audience` at `moment` (a fixed finding that came back is open again). */
export function markShown(rec: SessionRecord, identity: string, f: { code: string; subject: string; check?: string; file?: string }, moment: string, audience: Audience): void {
  const prior = rec.findings[identity];
  if (prior) {
    if (!prior.audiences.includes(audience)) prior.audiences.push(audience);
    if (prior.state === 'fixed') delete prior.state;
    return;
  }
  rec.findings[identity] = {
    code: f.code, subject: f.subject, moment, shownAt: new Date().toISOString(), audiences: [audience],
    ...(f.check ? { check: f.check } : {}), ...(f.file ? { file: f.file } : {}),
  };
}

/**
 * After `check` ran to completion on `files` (root-relative) following an agent edit: every finding
 * it showed earlier on one of those files that it did not report now (`reported` identities) is
 * fixed. A check that failed or timed out must not call this: it proves nothing.
 */
export function markFixed(rec: SessionRecord, check: string, files: readonly string[], reported: ReadonlySet<string>): void {
  for (const [identity, f] of Object.entries(rec.findings)) {
    if (f.check === check && f.file !== undefined && files.includes(f.file) && !reported.has(identity)) f.state = 'fixed';
  }
}

/** The stop receipt still reports these: they are open (unless fixed later). */
export function markOpen(rec: SessionRecord, reported: ReadonlySet<string>): void {
  for (const identity of reported) {
    const f = rec.findings[identity];
    if (f && f.state !== 'fixed') f.state = 'open';
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
    const findings: Record<string, ShownFinding> = { ...now.findings };
    for (const [identity, f] of Object.entries(rec.findings)) {
      const prior = findings[identity];
      // This hook read the record when it started, so its view of the finding (state included) is
      // the newer one; the audiences are the union. A state a parallel hook set meanwhile can be
      // lost, which reads as not assessed, never as a false "fixed".
      findings[identity] = prior ? { ...f, audiences: [...new Set([...prior.audiences, ...f.audiences])] } : f;
    }
    const kept = Object.entries(findings).slice(-MAX_FINDINGS);
    await atomicWriteFile(deliveredPath(root, sessionId), JSON.stringify({ startHead: now.startHead ?? rec.startHead, keys, findings: Object.fromEntries(kept) }));
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const n of readdirSync(deliveredDir(root))) {
      try { if (statSync(join(deliveredDir(root), n)).mtimeMs < cutoff) unlinkSync(join(deliveredDir(root), n)); } catch { /* raced */ }
    }
  } catch { /* dedupe is best-effort: at worst a fact is said twice */ }
}
