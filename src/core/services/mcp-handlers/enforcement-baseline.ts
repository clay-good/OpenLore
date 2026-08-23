/**
 * Frozen enforcement baseline (change: add-enforcement-baseline-ratchet).
 *
 * The file is deterministic JSON Lines. Code markers distinguish "this code was
 * initialized with zero findings" from "this code has never been frozen"; finding
 * lines preserve arbitrary subjects without a delimiter or line-number dependency.
 */

import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ENFORCEMENT_BASELINE_FILENAME, ENFORCEMENT_BASELINE_REL_PATH, OPENLORE_DIR } from '../../../constants.js';
import { atomicWriteFile } from '../../decisions/atomic-store.js';
import { acquireLockAt } from '../../runtime/advisory-lock.js';
import type {
  ClassifiedFinding,
  EnforcementPolicy,
  GateResult,
  GovernanceFinding,
} from './enforcement-policy.js';

type CodeRecord = ['code', string];
type FindingRecord = ['finding', string, string, string];
type BaselineRecord = CodeRecord | FindingRecord;

const GITIGNORE_MARKER = '# openlore-enforcement-baseline';
const GITIGNORE_END_MARKER = '# end-openlore-enforcement-baseline';
const GITIGNORE_BLOCK = `${GITIGNORE_MARKER}
!.openlore/
.openlore/*
!.openlore/config.json
!.openlore/${ENFORCEMENT_BASELINE_FILENAME}
${GITIGNORE_END_MARKER}`;
const BASELINE_HEADER = '# OpenLore frozen enforcement baseline v1';
const MAX_BASELINE_BYTES = 1_048_576;
const MAX_GITIGNORE_BYTES = 1_048_576;
const MAX_GIT_OUTPUT_BYTES = 4_096;
const execFileAsync = promisify(execFile);

export interface EnforcementBaselineSummary {
  path: string;
  initialized: string[];
  frozen: number;
  new: number;
  removed: number;
  written: boolean;
  requiresInitialization?: string[];
  integrityError?: boolean;
  caveat?: string;
}

export interface BaselineGateResult {
  gate: GateResult;
  baseline: EnforcementBaselineSummary;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable, line-number-insensitive identity for a governance finding. */
export function enforcementFindingIdentity(finding: GovernanceFinding): FindingRecord {
  return ['finding', finding.code, finding.subject, finding.discriminator ?? ''];
}

function recordKey(record: BaselineRecord): string {
  // JSON.stringify already escapes JSON controls. Escape every remaining non-ASCII
  // UTF-16 code unit as well so bidi/isolate controls and look-alike Unicode cannot
  // visually reorder or disguise a VCS-reviewed baseline line.
  return JSON.stringify(record).replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function parseBaseline(text: string): BaselineRecord[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_BASELINE_BYTES) {
    throw new Error(`baseline exceeds the ${MAX_BASELINE_BYTES} byte safety limit`);
  }
  const lines = text.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== BASELINE_HEADER) {
    throw new Error(`unrecognized baseline header (expected "${BASELINE_HEADER}")`);
  }
  const records: BaselineRecord[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of lines.slice(1).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) throw new Error(`unexpected baseline comment on line ${index + 2}`);
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch {
      throw new Error(`invalid JSON on line ${index + 2}`);
    }
    if (!Array.isArray(parsed) ||
        (parsed[0] === 'code' && (parsed.length !== 2 || typeof parsed[1] !== 'string')) ||
        (parsed[0] === 'finding' && (parsed.length !== 4 || parsed.slice(1).some((v) => typeof v !== 'string'))) ||
        (parsed[0] !== 'code' && parsed[0] !== 'finding')) {
      throw new Error(`invalid baseline record on line ${index + 2}`);
    }
    const record = parsed as BaselineRecord;
    const key = recordKey(record);
    if (keys.has(key)) throw new Error(`duplicate baseline record on line ${index + 2}`);
    keys.add(key);
    records.push(record);
  }
  const initializedCodes = new Set(
    records.filter((record): record is CodeRecord => record[0] === 'code').map((record) => record[1]),
  );
  const markerless = records.find((record) => record[0] === 'finding' && !initializedCodes.has(record[1]));
  if (markerless) throw new Error(`finding record for code "${markerless[1]}" has no initialized code marker`);
  return records;
}

function serializeBaseline(records: readonly BaselineRecord[]): string {
  const unique = [...new Map(records.map((record) => [recordKey(record), record])).values()]
    .sort((a, b) => compare(recordKey(a), recordKey(b)));
  return BASELINE_HEADER + '\n' + unique.map(recordKey).join('\n') + '\n';
}

async function readFileBoundedNoFollow(path: string, maxBytes: number, label: string): Promise<string> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} is not a regular file`);
    if (info.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte safety limit`);
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, maxBytes + 1 - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`${label} exceeds the ${maxBytes} byte safety limit`);
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

function markerCount(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

async function verifyGitTrackability(rootPath: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: rootPath,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    if (stdout.trim() !== 'true') return;
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure.code === 128 && /not a git repository/i.test(typeof failure.stderr === 'string' ? failure.stderr : '')) return;
    throw new Error(`Git repository status unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  for (const path of ['.openlore/config.json', ENFORCEMENT_BASELINE_REL_PATH]) {
    try {
      await execFileAsync('git', ['check-ignore', '--no-index', '-q', '--', path], {
        cwd: rootPath,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      });
      throw new Error(`${path} remains ignored by a higher-precedence Git ignore rule`);
    } catch (error) {
      const failure = error as { code?: unknown };
      if (failure.code === 1) continue;
      throw error;
    }
  }
}

/** Keep all runtime state ignored while making the one reviewable baseline trackable. */
async function ensureBaselineTrackable(rootPath: string): Promise<void> {
  const path = join(rootPath, '.gitignore');
  let existing = '';
  try {
    existing = await readFileBoundedNoFollow(path, MAX_GITIGNORE_BYTES, '.gitignore');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const starts = markerCount(existing, GITIGNORE_MARKER);
  const ends = markerCount(existing, GITIGNORE_END_MARKER);
  if (starts > 0 || ends > 0) {
    if (starts !== 1 || ends !== 1 || !existing.includes(GITIGNORE_BLOCK)) {
      throw new Error('managed .gitignore enforcement-baseline block is malformed or duplicated');
    }
  } else {
    await atomicWriteFile(path, `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${GITIGNORE_BLOCK}\n`);
  }
  await verifyGitTrackability(rootPath);
}

function validateCandidateAgainstTrusted(
  candidate: readonly BaselineRecord[],
  trusted: readonly BaselineRecord[],
  activeCodes: ReadonlySet<string>,
): void {
  const candidateKeys = new Set(candidate.map(recordKey));
  const trustedKeys = new Set(trusted.map(recordKey));
  const candidateCodes = new Set(candidate.filter((record): record is CodeRecord => record[0] === 'code').map((record) => record[1]));
  const trustedCodes = new Set(trusted.filter((record): record is CodeRecord => record[0] === 'code').map((record) => record[1]));
  const trustedFindings = new Set(trusted.filter((record) => record[0] === 'finding').map(recordKey));
  const allCodes = new Set([...candidate.map((record) => record[1]), ...trusted.map((record) => record[1])]);
  for (const code of allCodes) {
    if (!activeCodes.has(code)) {
      const candidateRecords = candidate.filter((record) => record[1] === code).map(recordKey);
      const trustedRecords = trusted.filter((record) => record[1] === code).map(recordKey);
      if (candidateRecords.some((key) => !trustedKeys.has(key)) || trustedRecords.some((key) => !candidateKeys.has(key))) {
        throw new Error(`baseline records changed for unassessed or non-frozen code "${code}"`);
      }
      continue;
    }
    if (!trustedCodes.has(code)) continue;
    if (!candidateCodes.has(code)) throw new Error(`initialized code marker removed for "${code}"`);
    for (const record of candidate) {
      if (record[0] === 'finding' && record[1] === code && !trustedFindings.has(recordKey(record))) {
        throw new Error(`frozen baseline grew for already-initialized code "${code}"`);
      }
    }
  }
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
  resolvedPath: string;
}

async function captureDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error('.openlore is a symbolic link');
  if (!before.isDirectory()) throw new Error('.openlore is not a directory');
  const resolvedPath = await realpath(path);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('.openlore changed while its identity was inspected');
  }
  return { dev: after.dev, ino: after.ino, resolvedPath };
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity | null): Promise<void> {
  try {
    const current = await captureDirectoryIdentity(path);
    if (expected === null || current.dev !== expected.dev || current.ino !== expected.ino || current.resolvedPath !== expected.resolvedPath) {
      throw new Error('.openlore directory identity changed during frozen baseline processing');
    }
  } catch (error) {
    if (expected === null && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function ambiguousUndiscriminatedCode(findings: readonly ClassifiedFinding[], activeCodes: ReadonlySet<string>): string | null {
  const seen = new Map<string, { source: string; message: string }>();
  for (const finding of findings) {
    if (finding.enforcementClass !== 'frozen' || !activeCodes.has(finding.code) || finding.discriminator) continue;
    const key = recordKey(['finding', finding.code, finding.subject, '']);
    const prior = seen.get(key);
    if (prior && (prior.source !== finding.source || prior.message !== finding.message)) return finding.code;
    seen.set(key, { source: finding.source, message: finding.message });
  }
  return null;
}

function rebuildGate(classified: ClassifiedFinding[]): GateResult {
  const blocking = classified.filter((finding) =>
    finding.enforcementClass === 'blocking' || finding.baselineState === 'new');
  return {
    classified,
    blocking,
    advisory: classified.filter((finding) => finding.enforcementClass === 'advisory'),
    frozen: classified.filter((finding) =>
      finding.enforcementClass === 'frozen' && finding.baselineState === 'frozen'),
    off: classified.filter((finding) => finding.enforcementClass === 'off'),
    gated: blocking.length > 0,
  };
}

function integrityGate(gate: GateResult): GateResult {
  return { ...gate, frozen: [], gated: true };
}

/**
 * Initialize and ratchet the frozen codes this caller actually evaluates.
 * A read/parse failure is fail-closed for the affected frozen policy: the corrupt
 * baseline is never overwritten, and a failed first write cannot pretend a durable
 * baseline exists.
 */
export async function applyEnforcementBaseline(
  rootPath: string,
  gate: GateResult,
  policy: EnforcementPolicy,
  managedCodes: ReadonlySet<string>,
  mode: 'bootstrap' | 'gate' | 'read-only' = 'bootstrap',
  trustedBaselineText?: string | null,
): Promise<BaselineGateResult> {
  const path = join(rootPath, ENFORCEMENT_BASELINE_REL_PATH);
  const activeCodes = Object.entries(policy)
    .filter(([code, enforcementClass]) => enforcementClass === 'frozen' && managedCodes.has(code))
    .map(([code]) => code)
    .sort(compare);
  const emptySummary = { path: ENFORCEMENT_BASELINE_REL_PATH, initialized: [], frozen: 0, new: 0, removed: 0, written: false };
  if (activeCodes.length === 0 && trustedBaselineText === undefined) return { gate, baseline: emptySummary };
  const activeSet = new Set(activeCodes);
  const ambiguousCode = ambiguousUndiscriminatedCode(gate.classified, activeSet);
  if (ambiguousCode) {
    return {
      gate: integrityGate(gate),
      baseline: {
        ...emptySummary,
        integrityError: true,
        caveat: `frozen finding identity collision for code "${ambiguousCode}": the source must provide a stable discriminator`,
      },
    };
  }

  const openlorePath = join(rootPath, OPENLORE_DIR);
  let pinnedDirectory: DirectoryIdentity | null = null;
  try {
    pinnedDirectory = await captureDirectoryIdentity(openlorePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        gate: integrityGate(gate),
        baseline: { ...emptySummary, integrityError: true, caveat: `frozen baseline path unavailable: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
  }

  let lock;
  try {
    lock = mode === 'read-only'
      ? null
      : await acquireLockAt(openlorePath, `.${ENFORCEMENT_BASELINE_FILENAME}.lock`, { maxWaitMs: 5_000, onContended: 'report' });
  } catch (error) {
    return {
      gate: integrityGate(gate),
      baseline: { ...emptySummary, integrityError: true, caveat: `frozen baseline lock unavailable: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
  if (lock && !('release' in lock)) {
    return {
      gate: integrityGate(gate),
      baseline: { ...emptySummary, integrityError: true, caveat: 'frozen baseline is being updated by another process; retry the gate' },
    };
  }

  try {
  if (pinnedDirectory !== null || mode !== 'read-only') {
    try {
      const lockedDirectory = await captureDirectoryIdentity(openlorePath);
      if (pinnedDirectory !== null &&
          (lockedDirectory.dev !== pinnedDirectory.dev || lockedDirectory.ino !== pinnedDirectory.ino || lockedDirectory.resolvedPath !== pinnedDirectory.resolvedPath)) {
        throw new Error('.openlore directory identity changed while acquiring the frozen baseline lock');
      }
      pinnedDirectory = lockedDirectory;
    } catch (error) {
      return { gate: integrityGate(gate), baseline: { ...emptySummary, integrityError: true, caveat: `frozen baseline path changed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }
  let existingText = '';
  let existed = true;
  try {
    await assertDirectoryIdentity(openlorePath, pinnedDirectory);
    try {
      existingText = await readFileBoundedNoFollow(path, MAX_BASELINE_BYTES, 'baseline');
    } finally {
      await assertDirectoryIdentity(openlorePath, pinnedDirectory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') existed = false;
    else return { gate: integrityGate(gate), baseline: { ...emptySummary, integrityError: true, caveat: `frozen baseline unavailable: ${error instanceof Error ? error.message : String(error)}` } };
  }

  let records: BaselineRecord[];
  try { records = existed ? parseBaseline(existingText) : []; } catch (error) {
    return { gate: integrityGate(gate), baseline: { ...emptySummary, integrityError: true, caveat: `frozen baseline ignored: ${error instanceof Error ? error.message : String(error)}` } };
  }
  if (trustedBaselineText !== undefined) {
    try {
      const trustedRecords = trustedBaselineText === null ? [] : parseBaseline(trustedBaselineText);
      validateCandidateAgainstTrusted(records, trustedRecords, activeSet);
    } catch (error) {
      return { gate: integrityGate(gate), baseline: { ...emptySummary, integrityError: true, caveat: `frozen baseline integrity check failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }
  if (activeCodes.length === 0) return { gate, baseline: emptySummary };

  const initializedBefore = new Set(records.filter((record): record is CodeRecord => record[0] === 'code').map((record) => record[1]));
  const initializedNow = activeCodes.filter((code) => !initializedBefore.has(code));
  const currentKeys = new Set(
    gate.frozen.filter((finding) => activeSet.has(finding.code)).map((finding) => recordKey(enforcementFindingIdentity(finding))),
  );
  const beforeKeys = new Set(records.map(recordKey));
  let removed = 0;

  const mayMutate = mode !== 'read-only';
  records = records.filter((record) => {
    if (record[0] !== 'finding' || !activeSet.has(record[1])) return true;
    if (currentKeys.has(recordKey(record))) return true;
    removed += 1;
    if (!mayMutate) return true;
    return false;
  });
  if (mode === 'bootstrap') {
    for (const code of initializedNow) records.push(['code', code]);
    for (const finding of gate.frozen) {
      if (initializedNow.includes(finding.code)) records.push(enforcementFindingIdentity(finding));
    }
  }

  const newKeys = new Set<string>();
  const classified = gate.classified.map((finding) => {
    if (finding.enforcementClass !== 'frozen' || !activeSet.has(finding.code)) return finding;
    const initialized = initializedBefore.has(finding.code);
    const wasFrozen = beforeKeys.has(recordKey(enforcementFindingIdentity(finding)));
    if (!initialized && mode !== 'bootstrap') {
      newKeys.add(recordKey(enforcementFindingIdentity(finding)));
      return { ...finding, baselineState: 'new' as const };
    }
    if (initialized && !wasFrozen) {
      newKeys.add(recordKey(enforcementFindingIdentity(finding)));
      return { ...finding, baselineState: 'new' as const };
    }
    return { ...finding, baselineState: 'frozen' as const };
  });
  const newCount = newKeys.size;

  const nextText = serializeBaseline(records);
  if (Buffer.byteLength(nextText, 'utf8') > MAX_BASELINE_BYTES) {
    return {
      gate: integrityGate(rebuildGate(classified)),
      baseline: { ...emptySummary, new: newCount, removed, integrityError: true, caveat: `frozen baseline output exceeds the ${MAX_BASELINE_BYTES} byte safety limit` },
    };
  }
  const changed = mayMutate && (mode === 'bootstrap' || initializedNow.length === 0) && (!existed || nextText !== existingText);
  if (mode === 'bootstrap') {
    try {
      await ensureBaselineTrackable(rootPath);
    } catch (error) {
      return {
        gate: integrityGate(rebuildGate(classified)),
        baseline: { ...emptySummary, new: newCount, removed, integrityError: true, caveat: `frozen baseline could not be made trackable: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
  }
  if (changed) {
    try {
      await assertDirectoryIdentity(openlorePath, pinnedDirectory);
      try {
        await atomicWriteFile(path, nextText);
      } finally {
        await assertDirectoryIdentity(openlorePath, pinnedDirectory);
      }
    } catch (error) {
      const caveat = `frozen baseline could not be written: ${error instanceof Error ? error.message : String(error)}`;
      return { gate: integrityGate(rebuildGate(classified)), baseline: { ...emptySummary, new: newCount, removed, integrityError: true, caveat } };
    }
  }

  const reconciled = rebuildGate(classified);
  if (mode !== 'bootstrap' && initializedNow.length > 0) reconciled.gated = true;
  return {
    gate: reconciled,
    baseline: {
      path: ENFORCEMENT_BASELINE_REL_PATH,
      initialized: initializedNow,
      frozen: new Set(reconciled.frozen
        .filter((finding) => finding.baselineState === 'frozen')
        .map((finding) => recordKey(enforcementFindingIdentity(finding)))).size,
      new: newCount,
      removed,
      written: changed,
      ...(mode !== 'bootstrap' && initializedNow.length > 0 ? { requiresInitialization: initializedNow } : {}),
    },
  };
  } finally {
    if (lock && 'release' in lock) await lock.release();
  }
}
