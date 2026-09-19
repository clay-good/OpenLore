/**
 * Accepted public-surface breakages (change: add-public-surface-acceptance-baseline).
 *
 * A checked-in, deterministic JSON Lines file under `.openlore/` that records breaking
 * `certify_public_surface` findings an operator intentionally shipped. Each entry names the rule
 * code, subject, and discriminator (the same `code` + `subject` + `discriminator` identity the
 * enforcement ratchet uses — the discriminator pins WHICH break, so accepting one narrowing never
 * covers a later, different one), a REQUIRED justification, and optionally a decision id. A
 * decision-anchored acceptance is honored only while that decision is current: a superseded, rejected, or unknown decision makes the entry
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
import { GITIGNORE_MARKER as ENFORCEMENT_GITIGNORE_MARKER, readFileBoundedNoFollow } from './enforcement-baseline.js';
import { atomicWriteFile } from '../../decisions/atomic-store.js';
import { execFileGit } from '../../../utils/git-exec.js';
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
  /** The finding's discriminator (which break); absent for a break the code and subject pin fully. */
  discriminator?: string;
  justification: string;
  decision?: string;
}

type AcceptRecord = ['accept', string, string, string, string, string];

const GITIGNORE_MARKER = '# openlore-public-surface-baseline';
const GITIGNORE_END_MARKER = '# end-openlore-public-surface-baseline';
/**
 * Placed after the enforcement ratchet's block, which already un-ignores `.openlore/` and re-ignores
 * its contents: one exception is enough, and it re-ignores nothing the ratchet exposed.
 */
const GITIGNORE_SHORT_BLOCK = `${GITIGNORE_MARKER}
!.openlore/${PUBLIC_SURFACE_BASELINE_FILENAME}
${GITIGNORE_END_MARKER}`;
/** Without the ratchet's block: expose only this file. `.openlore/config.json` stays ignored. */
const GITIGNORE_FULL_BLOCK = `${GITIGNORE_MARKER}
!.openlore/
.openlore/*
!.openlore/${PUBLIC_SURFACE_BASELINE_FILENAME}
${GITIGNORE_END_MARKER}`;
const MAX_GITIGNORE_BYTES = 1_048_576;

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
  unmatched: Array<{ code: string; subject: string; discriminator?: string }>;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function identity(code: string, subject: string, discriminator: string | undefined): string {
  return JSON.stringify([code, subject, discriminator ?? '']);
}

const entryIdentity = (e: AcceptedBreakage): string => identity(e.code, e.subject, e.discriminator);
const findingIdentity = (f: GovernanceFinding): string => identity(f.code, f.subject, f.discriminator);

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
  return ['accept', entry.code, entry.subject, entry.discriminator ?? '', entry.justification, entry.decision ?? ''];
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
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== 'accept' ||
        parsed.slice(1).some((value) => typeof value !== 'string')) {
      throw new Error(`invalid baseline record on line ${lineNo}`);
    }
    const [, code, subject, discriminator, justification, decision] = parsed as AcceptRecord;
    // Bounded and quoted: the file is repository content, and this message is printed.
    if (!BREAKING_CODES.has(code)) throw new Error(`line ${lineNo} accepts ${JSON.stringify(code.slice(0, 80))}, which is not a breaking public-surface rule code`);
    if (subject.length === 0) throw new Error(`line ${lineNo} has an empty subject`);
    const invalid = justificationError(justification);
    if (invalid !== null || justification !== justification.trim()) {
      throw new Error(`line ${lineNo} has an invalid justification: ${invalid ?? 'surrounding whitespace'}`);
    }
    if (decision !== '' && !DECISION_ID_RE.test(decision)) throw new Error(`line ${lineNo} has an invalid decision id (expected 8 lowercase hex characters)`);
    const key = identity(code, subject, discriminator);
    if (seen.has(key)) throw new Error(`duplicate acceptance for ${code} on line ${lineNo}`);
    seen.add(key);
    entries.push({ code, subject, ...(discriminator ? { discriminator } : {}), justification, ...(decision ? { decision } : {}) });
  }
  return entries;
}

/** Serialize entries deterministically: one sorted record per line. */
export function serializeAcceptedBaseline(entries: readonly AcceptedBreakage[]): string {
  const lines = entries
    .map((entry) => ({ key: entryIdentity(entry), line: recordLine(toRecord(entry)) }))
    .sort((a, b) => compare(a.key, b.key))
    .map((row) => row.line);
  return BASELINE_HEADER + '\n' + lines.map((line) => line + '\n').join('');
}

/**
 * Apply the baseline to a diff's findings. Pure. An entry is honored when it matches an acceptable
 * finding's `code` + `subject` + `discriminator` and carries no decision or a current one. Everything else still
 * reports: a stale entry is listed with the reason, and the finding stays in `findings`.
 */
export function applyAcceptedBaseline(
  findings: readonly GovernanceFinding[],
  entries: readonly AcceptedBreakage[],
  decisionCurrency: ReadonlyMap<string, DecisionCurrency>,
): BaselineApplication {
  const byIdentity = new Map(entries.map((entry) => [entryIdentity(entry), entry]));
  const matched = new Set<string>();
  const staleKeys = new Set<string>();
  const remaining: GovernanceFinding[] = [];
  const accepted: BaselineApplication['accepted'] = [];
  const stale: BaselineApplication['stale'] = [];
  for (const finding of findings) {
    const key = findingIdentity(finding);
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
    .filter((entry) => !matched.has(entryIdentity(entry)))
    .map((entry) => ({ code: entry.code, subject: entry.subject, ...(entry.discriminator ? { discriminator: entry.discriminator } : {}) }));
  return { findings: remaining, accepted, stale, unmatched };
}

/** Decision ids of the entries that match one of `findings` — the only anchors worth checking. */
export function anchorsToCheck(findings: readonly GovernanceFinding[], entries: readonly AcceptedBreakage[]): string[] {
  const wanted = new Set(findings.filter(isAcceptableFinding).map(findingIdentity));
  return [...new Set(entries.filter((e) => e.decision && wanted.has(entryIdentity(e))).map((e) => e.decision!))].sort();
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
  /** Existing entries re-accepted with a new justification or decision, with what they were before. */
  replaced: Array<{ before: AcceptedBreakage; after: AcceptedBreakage }>;
  written: boolean;
}

/**
 * Record `findings` as accepted with one justification (and optional decision id). Only acceptable
 * findings are recorded. An existing entry for the same identity is replaced — but an entry that is
 * anchored to a decision is replaced only by another decision-anchored acceptance, so re-accepting
 * never silently turns an expiring acceptance into a permanent one. Serialized under an advisory
 * lock and written with compare-and-swap against the bytes read, so a concurrent edit is refused
 * instead of lost. Makes the file trackable by Git under the managed `.gitignore` block.
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
    const byIdentity = new Map(existing.entries.map((entry) => [entryIdentity(entry), entry]));
    const added: AcceptedBreakage[] = [];
    const replaced: AcceptResult['replaced'] = [];
    const unanchoring: AcceptedBreakage[] = [];
    for (const finding of findings) {
      if (!isAcceptableFinding(finding)) continue;
      const entry: AcceptedBreakage = {
        code: finding.code,
        subject: finding.subject,
        ...(finding.discriminator ? { discriminator: finding.discriminator } : {}),
        justification: reason,
        ...(decision ? { decision } : {}),
      };
      const key = entryIdentity(entry);
      const prior = byIdentity.get(key);
      if (prior && prior.justification === entry.justification && prior.decision === entry.decision) continue;
      if (prior?.decision && !decision) { unanchoring.push(prior); continue; }
      if (prior) replaced.push({ before: prior, after: entry });
      else added.push(entry);
      byIdentity.set(key, entry);
    }
    if (unanchoring.length > 0) {
      throw new Error(
        `${unanchoring.length} finding(s) already have an acceptance anchored to a decision that is no longer current ` +
        `(${unanchoring.map((e) => `${e.code} ${e.subject} → decision ${e.decision}`).join('; ')}). ` +
        'Re-accept them with --decision <a current decision id>, or edit the baseline by hand; nothing was written.',
      );
    }
    if (added.length === 0 && replaced.length === 0) {
      return { path: PUBLIC_SURFACE_BASELINE_REL_PATH, added, replaced, written: false };
    }
    const next = serializeAcceptedBaseline([...byIdentity.values()]);
    if (Buffer.byteLength(next, 'utf8') > MAX_BASELINE_BYTES) {
      throw new Error(`the baseline would exceed the ${MAX_BASELINE_BYTES} byte safety limit`);
    }
    await ensureBaselineTrackable(canonicalRoot);
    await confinedAtomicWriteFile(canonicalRoot, join(canonicalRoot, PUBLIC_SURFACE_BASELINE_REL_PATH), next, {
      expectedIdentity: existing.present ? existing.stat : null,
      ...(existing.present ? { expectedContent: existing.text } : {}),
    });
    return { path: PUBLIC_SURFACE_BASELINE_REL_PATH, added, replaced, written: true };
  } finally {
    await lock.release();
  }
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/**
 * Keep the rest of `.openlore/` ignored while making this one file trackable, with a managed block
 * of its own. The enforcement ratchet's block is never edited (older OpenLore versions check it
 * byte for byte). Git applies the last matching rule, so this block must come AFTER the ratchet's:
 * a ratchet block appended later would re-ignore this file, and the next accept moves this block
 * back to the end. Once the baseline is committed, ignore rules no longer affect it.
 */
async function ensureBaselineTrackable(rootPath: string): Promise<void> {
  const path = join(rootPath, '.gitignore');
  let existing = '';
  try {
    existing = await readFileBoundedNoFollow(path, MAX_GITIGNORE_BYTES, '.gitignore');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const starts = occurrences(existing, GITIGNORE_MARKER);
  const ends = occurrences(existing, GITIGNORE_END_MARKER);
  let current: string | null = null;
  if (starts > 0 || ends > 0) {
    current = [GITIGNORE_SHORT_BLOCK, GITIGNORE_FULL_BLOCK].find((block) => existing.includes(block)) ?? null;
    if (starts !== 1 || ends !== 1 || current === null) {
      throw new Error('managed .gitignore public-surface-baseline block is malformed or duplicated');
    }
  }
  const rest = current === null
    ? existing
    : existing.replace(existing.includes(`${current}\n`) ? `${current}\n` : current, () => '');
  const ratchetAt = rest.lastIndexOf(ENFORCEMENT_GITIGNORE_MARKER);
  const wanted = ratchetAt >= 0 ? GITIGNORE_SHORT_BLOCK : GITIGNORE_FULL_BLOCK;
  const inPlace = current === wanted && (ratchetAt < 0 || existing.indexOf(current) > existing.lastIndexOf(ENFORCEMENT_GITIGNORE_MARKER));
  if (!inPlace) {
    const kept = rest.trimEnd();
    await atomicWriteFile(path, `${kept}${kept ? '\n\n' : ''}${wanted}\n`);
  }
  await verifyTrackable(rootPath);
}

/** Fail when a higher-precedence ignore rule (a nested `.gitignore`, `info/exclude`) still hides the file. */
async function verifyTrackable(rootPath: string): Promise<void> {
  try {
    const { stdout } = await execFileGit('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootPath, maxBuffer: 4_096 });
    if (stdout.trim() !== 'true') return;
  } catch {
    return; // not a Git work tree: nothing to make trackable
  }
  try {
    await execFileGit('git', ['check-ignore', '--no-index', '-q', '--', PUBLIC_SURFACE_BASELINE_REL_PATH], { cwd: rootPath, maxBuffer: 4_096 });
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return;
    throw error;
  }
  throw new Error(`${PUBLIC_SURFACE_BASELINE_REL_PATH} remains ignored by a higher-precedence Git ignore rule`);
}
