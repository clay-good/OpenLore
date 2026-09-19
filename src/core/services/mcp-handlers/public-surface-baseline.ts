/**
 * Accepted public-surface breakages (change: add-public-surface-acceptance-baseline).
 *
 * A checked-in, deterministic JSON Lines file under `.openlore/` that records breaking
 * `certify_public_surface` findings an operator intentionally shipped. Each entry names the rule
 * code and subject (the same `code` + `subject` identity the enforcement ratchet uses), a REQUIRED
 * justification, and optionally a decision id. A decision-anchored acceptance is honored only
 * while that decision is current: a superseded, rejected, or unknown decision makes the entry
 * stale, and the finding reports again.
 *
 * Reading is fail-closed: a file that cannot be read or parsed honors nothing, so a corrupt
 * baseline can never hide a breaking change. Only the CLI writes the file.
 */

import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import { OPENLORE_DIR, PUBLIC_SURFACE_BASELINE_FILENAME, PUBLIC_SURFACE_BASELINE_REL_PATH } from '../../../constants.js';
import { confinedAtomicWriteFile, readFileConfinedWithStat } from '../../../utils/path-confinement.js';
import { acquireLockAt } from '../../runtime/advisory-lock.js';
import { BREAKING_SURFACE_RULE_CODES } from '../../analyzer/public-surface.js';
import { ensureOpenloreFilesTrackable } from './enforcement-baseline.js';
import type { GovernanceFinding } from './enforcement-policy.js';

const BASELINE_HEADER = '# OpenLore accepted public-surface breakages v1';
const MAX_BASELINE_BYTES = 1_048_576;
/** Upper bound on one justification, so a baseline line stays reviewable. */
export const MAX_JUSTIFICATION_LENGTH = 1_000;
const DECISION_ID_RE = /^[0-9a-f]{8}$/;
const BREAKING_CODES: ReadonlySet<string> = new Set(BREAKING_SURFACE_RULE_CODES);

/** One accepted breakage. `decision` is an 8-character decision id, or absent. */
export interface AcceptedBreakage {
  code: string;
  subject: string;
  justification: string;
  decision?: string;
}

type AcceptRecord = ['accept', string, string, string, string];

/** Whether an anchored decision is still current, from the decision store. */
export type DecisionCurrency =
  | { current: true }
  | { current: false; reason: string; supersededBy?: string };

export interface BaselineApplication {
  /** Findings the baseline does not honor: these still report and can block. */
  findings: GovernanceFinding[];
  /** Findings matched by an honored entry: reported, never blocking. */
  accepted: Array<AcceptedBreakage & { finding: GovernanceFinding }>;
  /** Entries that match a current finding but are not honored because their decision is not current. */
  stale: Array<AcceptedBreakage & { reason: string; supersededBy?: string }>;
  /** Entries that match no current finding. */
  unmatched: Array<{ code: string; subject: string }>;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function identity(code: string, subject: string): string {
  return JSON.stringify([code, subject]);
}

/** Can this finding be accepted? Only breaking-classed public-surface findings can. */
export function isAcceptableFinding(finding: GovernanceFinding): boolean {
  return finding.source === 'public-surface' && BREAKING_CODES.has(finding.code);
}

/** Validate a justification; returns an error message, or null when it is acceptable. */
export function justificationError(justification: string | undefined): string | null {
  const text = (justification ?? '').trim();
  if (text.length === 0) return 'an acceptance requires a justification (--justification "<why this break is intended>")';
  if (text.length > MAX_JUSTIFICATION_LENGTH) return `the justification exceeds ${MAX_JUSTIFICATION_LENGTH} characters`;
  // Control characters (newlines, escapes, bidi controls) would let a reviewed baseline line hide
  // or disguise its content when printed; the serializer escapes them, but refuse them up front.
  // eslint-disable-next-line no-control-regex -- the justification is operator- or repo-controlled text
  if (/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text)) return 'the justification must not contain control characters';
  return null;
}

function toRecord(entry: AcceptedBreakage): AcceptRecord {
  return ['accept', entry.code, entry.subject, entry.justification, entry.decision ?? ''];
}

function recordLine(record: AcceptRecord): string {
  // JSON.stringify escapes JSON controls; escape every other non-ASCII code unit as well so bidi
  // controls and look-alike characters cannot disguise a VCS-reviewed line (same as the ratchet).
  return JSON.stringify(record).replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Parse a baseline file. Throws on any malformed content: the caller must honor nothing. */
export function parseAcceptedBaseline(text: string): AcceptedBreakage[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_BASELINE_BYTES) {
    throw new Error(`baseline exceeds the ${MAX_BASELINE_BYTES} byte safety limit`);
  }
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== BASELINE_HEADER) {
    throw new Error(`unrecognized baseline header (expected "${BASELINE_HEADER}")`);
  }
  const entries: AcceptedBreakage[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of lines.slice(1).entries()) {
    const line = raw.trim();
    const lineNo = index + 2;
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      throw new Error(`invalid JSON on line ${lineNo}`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== 'accept' ||
        parsed.slice(1).some((value) => typeof value !== 'string')) {
      throw new Error(`invalid baseline record on line ${lineNo}`);
    }
    const [, code, subject, justification, decision] = parsed as AcceptRecord;
    if (!BREAKING_CODES.has(code)) throw new Error(`line ${lineNo} accepts "${code}", which is not a breaking public-surface rule code`);
    if (subject.length === 0) throw new Error(`line ${lineNo} has an empty subject`);
    const invalid = justificationError(justification);
    if (invalid !== null || justification !== justification.trim()) {
      throw new Error(`line ${lineNo} has an invalid justification: ${invalid ?? 'surrounding whitespace'}`);
    }
    if (decision !== '' && !DECISION_ID_RE.test(decision)) throw new Error(`line ${lineNo} has an invalid decision id (expected 8 lowercase hex characters)`);
    const key = identity(code, subject);
    if (seen.has(key)) throw new Error(`duplicate acceptance for ${code} on line ${lineNo}`);
    seen.add(key);
    entries.push({ code, subject, justification, ...(decision ? { decision } : {}) });
  }
  return entries;
}

/** Serialize entries deterministically: one sorted record per line. */
export function serializeAcceptedBaseline(entries: readonly AcceptedBreakage[]): string {
  const lines = entries
    .map((entry) => ({ key: identity(entry.code, entry.subject), line: recordLine(toRecord(entry)) }))
    .sort((a, b) => compare(a.key, b.key))
    .map((row) => row.line);
  return BASELINE_HEADER + '\n' + lines.map((line) => line + '\n').join('');
}

/**
 * Apply the baseline to a diff's findings. Pure. An entry is honored when it matches an acceptable
 * finding's `code` + `subject` and carries no decision or a current one. Everything else still
 * reports: a stale entry is listed with the reason, and the finding stays in `findings`.
 */
export function applyAcceptedBaseline(
  findings: readonly GovernanceFinding[],
  entries: readonly AcceptedBreakage[],
  decisionCurrency: ReadonlyMap<string, DecisionCurrency>,
): BaselineApplication {
  const byIdentity = new Map(entries.map((entry) => [identity(entry.code, entry.subject), entry]));
  const matched = new Set<string>();
  const staleKeys = new Set<string>();
  const remaining: GovernanceFinding[] = [];
  const accepted: BaselineApplication['accepted'] = [];
  const stale: BaselineApplication['stale'] = [];
  for (const finding of findings) {
    const key = identity(finding.code, finding.subject);
    const entry = isAcceptableFinding(finding) ? byIdentity.get(key) : undefined;
    if (!entry) { remaining.push(finding); continue; }
    matched.add(key);
    const currency: DecisionCurrency = entry.decision
      ? decisionCurrency.get(entry.decision) ?? { current: false, reason: `decision ${entry.decision} could not be checked` }
      : { current: true };
    if (currency.current) {
      accepted.push({ ...entry, finding });
      continue;
    }
    remaining.push(finding);
    if (!staleKeys.has(key)) {
      staleKeys.add(key);
      stale.push({ ...entry, reason: currency.reason, ...(currency.supersededBy ? { supersededBy: currency.supersededBy } : {}) });
    }
  }
  const unmatched = entries
    .filter((entry) => !matched.has(identity(entry.code, entry.subject)))
    .map((entry) => ({ code: entry.code, subject: entry.subject }));
  return { findings: remaining, accepted, stale, unmatched };
}

export interface BaselineRead {
  entries: AcceptedBreakage[];
  present: boolean;
  /** Exact bytes and identity read, for a compare-and-swap write. */
  text?: string;
  stat?: Stats;
}

/**
 * Read the baseline from `rootPath`. Absent → `present: false`. Throws when the file exists but
 * cannot be read safely or parsed (a symlinked path, an oversized or non-UTF-8 file, bad records).
 */
export async function readAcceptedBaseline(rootPath: string): Promise<BaselineRead> {
  const canonicalRoot = await realpath(rootPath);
  let read: { content: string; stat: Stats };
  try {
    read = await readFileConfinedWithStat(canonicalRoot, PUBLIC_SURFACE_BASELINE_REL_PATH, MAX_BASELINE_BYTES, true, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], present: false };
    throw error;
  }
  return { entries: parseAcceptedBaseline(read.content), present: true, text: read.content, stat: read.stat };
}

export interface AcceptResult {
  path: string;
  added: AcceptedBreakage[];
  /** Existing entries replaced because they were re-accepted (for example a stale decision anchor). */
  replaced: number;
  written: boolean;
}

/**
 * Record `findings` as accepted with one justification (and optional decision id). Only acceptable
 * findings are recorded; an existing entry for the same identity is replaced. Serialized under an
 * advisory lock and written with compare-and-swap against the bytes read, so a concurrent edit is
 * refused instead of lost. Makes the file trackable by Git under the managed `.gitignore` block.
 */
export async function writeAcceptedBreakages(
  rootPath: string,
  findings: readonly GovernanceFinding[],
  justification: string,
  decision?: string,
): Promise<AcceptResult> {
  const invalid = justificationError(justification);
  if (invalid !== null) throw new Error(invalid);
  if (decision !== undefined && !DECISION_ID_RE.test(decision)) throw new Error('the decision id must be 8 lowercase hex characters');
  const reason = justification.trim();
  const canonicalRoot = await realpath(rootPath);
  const openloreDir = join(canonicalRoot, OPENLORE_DIR);
  const lock = await acquireLockAt(openloreDir, `.${PUBLIC_SURFACE_BASELINE_FILENAME}.lock`, { maxWaitMs: 5_000, onContended: 'report' });
  if (!('release' in lock)) throw new Error('the public-surface baseline is being updated by another process; retry');
  try {
    const existing = await readAcceptedBaseline(canonicalRoot);
    const byIdentity = new Map(existing.entries.map((entry) => [identity(entry.code, entry.subject), entry]));
    const added: AcceptedBreakage[] = [];
    let replaced = 0;
    for (const finding of findings) {
      if (!isAcceptableFinding(finding)) continue;
      const key = identity(finding.code, finding.subject);
      const entry: AcceptedBreakage = { code: finding.code, subject: finding.subject, justification: reason, ...(decision ? { decision } : {}) };
      const prior = byIdentity.get(key);
      if (prior && prior.justification === entry.justification && prior.decision === entry.decision) continue;
      if (prior) replaced += 1;
      else added.push(entry);
      byIdentity.set(key, entry);
    }
    if (added.length === 0 && replaced === 0) {
      return { path: PUBLIC_SURFACE_BASELINE_REL_PATH, added, replaced, written: false };
    }
    const next = serializeAcceptedBaseline([...byIdentity.values()]);
    if (Buffer.byteLength(next, 'utf8') > MAX_BASELINE_BYTES) {
      throw new Error(`the baseline would exceed the ${MAX_BASELINE_BYTES} byte safety limit`);
    }
    await ensureOpenloreFilesTrackable(canonicalRoot, [PUBLIC_SURFACE_BASELINE_REL_PATH]);
    await confinedAtomicWriteFile(canonicalRoot, join(canonicalRoot, PUBLIC_SURFACE_BASELINE_REL_PATH), next, {
      expectedIdentity: existing.present ? existing.stat : null,
      ...(existing.present ? { expectedContent: existing.text } : {}),
    });
    return { path: PUBLIC_SURFACE_BASELINE_REL_PATH, added, replaced, written: true };
  } finally {
    await lock.release();
  }
}
