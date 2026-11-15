/**
 * Index build progress, for the user and never for the agent (change: hook-reliability, group 9;
 * design section 7).
 *
 * `openlore analyze` opens a sink; Pass-1 extraction reports each file it finishes; the sink writes
 * `.openlore/build-progress.json` — `{ phase, filesDone, filesTotal, startedAt, updatedAt, pid }` —
 * atomically, at most once per second (a phase change is written at once), and removes it when the
 * build ends. `openlore statusline` and `openlore status` read it. A record whose `pid` is gone, or
 * that has not been updated for 2 minutes, means "not building".
 *
 * Reporting is a no-op when no sink is open (MCP, tests, the library API), and never throws.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';

export interface BuildProgress {
  phase: string;
  filesDone: number;
  filesTotal: number;
  startedAt: string;
  updatedAt: string;
  pid: number;
}

const WRITE_EVERY_MS = 1000;
const STALE_MS = 2 * 60 * 1000;

export function buildProgressPath(root: string): string {
  return join(root, OPENLORE_DIR, 'build-progress.json');
}

interface Sink { root: string; record: BuildProgress; lastWrite: number }
let sink: Sink | undefined;

function write(force: boolean): void {
  if (!sink) return;
  const now = Date.now();
  if (!force && now - sink.lastWrite < WRITE_EVERY_MS) return;
  sink.lastWrite = now;
  sink.record.updatedAt = new Date(now).toISOString();
  // Synchronous temp-file-and-rename: a reader never sees half a record, and two writes cannot
  // land out of order (an async write could).
  const path = buildProgressPath(sink.root);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(sink.record));
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
  }
}

/** Open the sink for a build of `root`. Returns the function that closes it and removes the record. */
export function openBuildProgress(root: string): () => void {
  const at = new Date().toISOString();
  sink = { root, record: { phase: 'scanning', filesDone: 0, filesTotal: 0, startedAt: at, updatedAt: at, pid: process.pid }, lastWrite: 0 };
  write(true);
  return () => {
    sink = undefined;
    try { rmSync(buildProgressPath(root), { force: true }); } catch { /* gone already */ }
  };
}

/** A new phase. `filesTotal` starts a counted phase (parsing). */
export function reportBuildPhase(phase: string, filesTotal?: number): void {
  if (!sink) return;
  sink.record.phase = phase;
  if (filesTotal !== undefined) { sink.record.filesTotal = filesTotal; sink.record.filesDone = 0; }
  write(true);
}

/** One more file finished in the counted phase. */
export function reportFileDone(): void {
  if (!sink) return;
  sink.record.filesDone = Math.min(sink.record.filesDone + 1, sink.record.filesTotal || Number.MAX_SAFE_INTEGER);
  write(false);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The build in progress for `root`, or undefined when none is (no record, a dead pid, or a stale record). */
export function readBuildProgress(root: string, now = Date.now()): BuildProgress | undefined {
  try {
    const r = JSON.parse(readFileSync(buildProgressPath(root), 'utf8')) as Partial<BuildProgress>;
    if (typeof r.phase !== 'string' || typeof r.pid !== 'number' || typeof r.updatedAt !== 'string') return undefined;
    if (now - Date.parse(r.updatedAt) > STALE_MS || !alive(r.pid)) return undefined;
    return {
      phase: r.phase, pid: r.pid, updatedAt: r.updatedAt, startedAt: String(r.startedAt ?? r.updatedAt),
      filesDone: Number.isFinite(r.filesDone) ? Number(r.filesDone) : 0,
      filesTotal: Number.isFinite(r.filesTotal) ? Number(r.filesTotal) : 0,
    };
  } catch {
    return undefined;
  }
}

/** `indexing 45% (1,310/2,900 files)` while files are counted, else `indexing: <phase>`. */
export function formatBuildProgress(p: BuildProgress): string {
  if (p.phase === 'parsing' && p.filesTotal > 0) {
    const pct = Math.floor((p.filesDone / p.filesTotal) * 100);
    return `indexing ${pct}% (${p.filesDone.toLocaleString('en-US')}/${p.filesTotal.toLocaleString('en-US')} files)`;
  }
  return `indexing: ${p.phase}`;
}
