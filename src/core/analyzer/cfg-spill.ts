/**
 * Off-heap hand-off for the CFG/def-use overlay (change: bound-cfg-overlay-residency; issue #304),
 * with an in-memory fast path (change: buffer-cfg-overlay-before-spill; issue #306).
 *
 * The overlay is pure write-through: built per function during extraction, accumulated for the
 * WHOLE repository, serialized into the `cfg_overlay` table, and then stripped before
 * `llm-context.json` is written. Nothing computes on it in memory — yet it was held for the entire
 * build, across every later pass, making its footprint a function of total analyzed source.
 *
 * It cannot simply be inserted into SQLite as it is produced. `writeEdgesToSQLite` opens the store
 * and calls `clearAll()` only AFTER the build completes — deliberately, so a build that fails
 * cannot leave a wiped index behind (change: harden-index-store-lifecycle). Rows written during
 * the build would be erased by that clear.
 *
 * So the overlay is buffered until the drain. On the repositories people actually have the whole
 * overlay is small — 5.5 MB on OpenLore, 34 MB on microsoft/TypeScript — and fits in memory with
 * room to spare, so it stays there and no file is ever touched: issue #304's bound only matters on
 * a repository whose overlay is genuinely large, and #306 measured a ~14% analyze-wall-clock cost
 * from paying a disk round-trip on every repository to buy a bound almost none of them need. Past a
 * threshold the buffer OVERFLOWS to a file, and the drain streams the file back instead — so peak
 * residency is `min(overlay, threshold)` plus one write batch, and the bound issue #304 needs is
 * preserved exactly where it is needed.
 *
 * The format is one JSON-framed record per line. Both the id and the path are `JSON.stringify`d,
 * so a tab or newline in either is escaped by construction and the framing cannot be broken by a
 * repository-controlled path. The CFG itself is stored ALREADY SERIALIZED, exactly as
 * `insertCfgs` would have serialized it, so the drain binds a string straight into SQLite — no
 * parse, no re-stringify, and no chance of the round-trip altering the persisted bytes. The
 * in-memory and the overflowed path frame each row identically and drain it through the same
 * parser, so `cfg_overlay` is byte-identical whichever path a build takes.
 */
import { openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { FunctionCfg } from './cfg.js';

/** One persisted overlay row, with its CFG already in the exact form the table stores. */
export interface CfgSpillRow {
  functionId: string;
  filePath: string;
  cfgJson: string;
}

/**
 * How many buffered rows a single on-disk write drains at once, once overflowed. Bounds the
 * transient string/Buffer built for the write — including the first drain of the whole in-memory
 * buffer at the overflow moment — without paying a syscall per function.
 */
const WRITE_BUFFER_ROWS = 512;

/**
 * How many bytes of overlay may accumulate in memory before the buffer overflows to a file.
 *
 * Sized above every overlay measured on a real repository (34 MB on microsoft/TypeScript, its
 * 65,971 functions) so that in practice the overlay never leaves memory and no disk round-trip is
 * paid (issue #306); a genuinely larger repository crosses it and gets issue #304's bound. Override
 * with `OPENLORE_CFG_OVERLAY_MEMORY_BYTES` on a memory-constrained machine to force the spill
 * sooner.
 */
const DEFAULT_OVERFLOW_THRESHOLD_BYTES = 64 * 1024 * 1024;
let OVERFLOW_THRESHOLD_BYTES = ((): number => {
  const raw = Number(process.env.OPENLORE_CFG_OVERLAY_MEMORY_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OVERFLOW_THRESHOLD_BYTES;
})();

/**
 * Test-only: lower the overflow threshold so a small fixture crosses it, exercising the on-disk
 * path without a multi-megabyte overlay. Returns the previous value so callers can restore it.
 */
export function _setOverflowThresholdBytesForTesting(n: number): number {
  const previous = OVERFLOW_THRESHOLD_BYTES;
  OVERFLOW_THRESHOLD_BYTES = n;
  return previous;
}

/**
 * Filename prefix for a spill. Exported so the bundle exporter can refuse to ship one and the
 * sweep can recognise a leaked one: a build killed mid-flight (an OOM-kill, a Ctrl-C) leaves the
 * file behind, and it holds the entire overlay.
 */
export const CFG_SPILL_PREFIX = '.cfg-spill-';

/** How many bytes of the spill file are read at a time when draining. */
let DRAIN_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Test-only: shrink the drain chunk so a small fixture straddles it.
 *
 * Without this, exercising the partial-line carry — the only subtle part of the reader — needs a
 * spill larger than 4 MB, which is slow enough to destabilize neighbouring tests. Returns the
 * previous value so callers can restore it.
 */
export function _setDrainChunkBytesForTesting(n: number): number {
  const previous = DRAIN_CHUNK_BYTES;
  DRAIN_CHUNK_BYTES = n;
  return previous;
}

/** Where the overlay currently lives. `failed` latches: once set, no further write is attempted. */
type SpillMode = 'memory' | 'disk' | 'failed';

/**
 * Write the whole string to `fd`, looping until every byte lands. `writeSync` may write fewer bytes
 * than requested for a large payload; a single call would silently truncate the spill (issue #306).
 */
function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf-8');
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

export class CfgSpill {
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private mode: SpillMode = 'memory';
  private fd: number | undefined;
  private fileCreated = false;
  private rows = 0;
  private disposed = false;

  private constructor(readonly path: string) {}

  /**
   * Bind a spill to its output directory. No file is created here — the overlay starts in memory
   * and a file is opened lazily only if it overflows, so a repository whose overlay fits the
   * threshold never touches the disk. Never fails: an unwritable directory surfaces at overflow,
   * where it degrades to a disclosed missing overlay rather than a failed analysis.
   */
  static async open(outputDir: string): Promise<CfgSpill> {
    // Inside the analysis directory, not the OS temp dir: this is the one place the run has
    // already proven it can write, and `rm -rf .openlore` / `analyze --force` clean it up with
    // everything else. The pid keeps concurrent analyses from colliding.
    return new CfgSpill(join(outputDir, `${CFG_SPILL_PREFIX}${process.pid}.ndjson`));
  }

  /**
   * Did a write fail? A failed spill must be discarded whole, never persisted in part — the
   * consumer skips it and the overlay degrades to a disclosed function-granularity answer.
   */
  get failed(): boolean { return this.mode === 'failed'; }

  /** How many rows have been accepted. */
  get count(): number { return this.rows; }

  /**
   * Record one file's overlay. Serializes here, at the point the CFGs are still warm, so the CFG
   * objects become collectable as soon as the caller drops its reference to them — the in-memory
   * buffer holds the compact serialized form, not the live object graph (issue #304).
   */
  write(filePath: string, cfgs: Iterable<[string, FunctionCfg]>): void {
    if (this.mode === 'failed') return;
    for (const [functionId, cfg] of cfgs) {
      let cfgJson: string;
      try {
        cfgJson = JSON.stringify(cfg);
      } catch {
        continue; // an unserializable overlay is dropped, exactly as a failed insert would be
      }
      this.buffer.push(`${JSON.stringify(functionId)}\t${JSON.stringify(filePath)}\t${cfgJson}\n`);
      this.bufferedBytes += this.buffer[this.buffer.length - 1].length;
      this.rows++;
    }
    if (this.mode === 'memory') {
      if (this.bufferedBytes >= OVERFLOW_THRESHOLD_BYTES) this.overflow();
    } else if (this.buffer.length >= WRITE_BUFFER_ROWS) {
      this.flushToDisk();
    }
  }

  /**
   * Move the accumulated buffer to a file and switch to streaming subsequent rows there. Attempted
   * AT MOST ONCE: if it fails the spill latches `failed` and no later write reopens the file. A
   * per-write retry reopened and rewrote the whole buffer for every function past the threshold —
   * measured 5× slower on a large repository (issue #306).
   */
  private overflow(): void {
    let fd: number;
    try {
      fd = openSync(this.path, 'w');
    } catch {
      this.latchFailed();
      return;
    }
    this.fd = fd;
    this.fileCreated = true;
    this.mode = 'disk';
    this.flushToDisk(); // drain the in-memory buffer that tripped the threshold
  }

  /** Write the pending buffer to the open file in bounded sub-batches, then clear it. */
  private flushToDisk(): void {
    if (this.buffer.length === 0) return;
    const frames = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    try {
      for (let i = 0; i < frames.length; i += WRITE_BUFFER_ROWS) {
        writeAllSync(this.fd!, frames.slice(i, i + WRITE_BUFFER_ROWS).join(''));
      }
    } catch {
      this.latchFailed();
    }
  }

  /**
   * Latch the failed state: drop the buffer, close and remove any partial file so a truncated spill
   * is never left for the drain or the bundle exporter to find.
   */
  private latchFailed(): void {
    this.mode = 'failed';
    this.buffer = [];
    this.bufferedBytes = 0;
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* already closed */ }
      this.fd = undefined;
    }
    if (this.fileCreated) {
      try { unlinkSync(this.path); } catch { /* already gone */ }
      this.fileCreated = false;
    }
  }

  /** Flush and close. Must be awaited before {@link drain}. A no-op while the overlay is in memory. */
  async finish(): Promise<void> {
    if (this.mode !== 'disk') return;
    this.flushToDisk();
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* already closed */ }
      this.fd = undefined;
    }
  }

  /**
   * Read the spilled rows back, one at a time. From memory when the overlay never overflowed;
   * otherwise from the file, never holding more than one chunk plus the partial line straddling it.
   */
  async *drain(): AsyncGenerator<CfgSpillRow> {
    if (this.mode === 'failed') return;
    if (this.mode === 'memory') {
      for (const frame of this.buffer) {
        // Frames carry the trailing newline they are written with; the on-disk reader splits it off
        // before parsing, so strip it here too or it would corrupt the final field's bytes.
        const row = parseRow(frame.endsWith('\n') ? frame.slice(0, -1) : frame);
        if (row) yield row;
      }
      return;
    }
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch {
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(DRAIN_CHUNK_BYTES);
      let carry = '';
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buf, 0, DRAIN_CHUNK_BYTES, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const text = carry + buf.subarray(0, bytesRead).toString('utf-8');
        const lines = text.split('\n');
        carry = lines.pop() ?? ''; // the last piece may be a partial line
        for (const line of lines) {
          const row = parseRow(line);
          if (row) yield row;
        }
      }
      const last = parseRow(carry);
      if (last) yield last;
    } finally {
      await handle.close().catch(() => { /* closing a handle we are done with cannot fail usefully */ });
    }
  }

  /** Remove the spill file, if one was ever created. Idempotent, and never throws. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* already closed */ }
      this.fd = undefined;
    }
    if (this.fileCreated) {
      await unlink(this.path).catch(() => { /* already gone */ });
    }
  }
}

/**
 * Remove spill files left by builds that died before they could clean up.
 *
 * Only files whose owning process is gone are removed: a spill belongs to a live analysis until
 * that analysis ends, and a long build on a large repository can legitimately run for hours, so
 * age alone is not a safe signal. `kill(pid, 0)` tests liveness without signalling.
 *
 * Best effort throughout — a sweep that cannot run must never stop an analysis.
 */
export async function sweepLeakedCfgSpills(outputDir: string): Promise<void> {
  try {
    for (const name of await readdir(outputDir)) {
      if (!name.startsWith(CFG_SPILL_PREFIX) || !name.endsWith('.ndjson')) continue;
      const pid = Number(name.slice(CFG_SPILL_PREFIX.length, -'.ndjson'.length));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          continue; // still running — not ours to remove
        } catch {
          /* no such process: the owner is gone */
        }
      } else if (pid === process.pid) {
        continue;
      }
      await unlink(join(outputDir, name)).catch(() => { /* raced with another sweep */ });
    }
  } catch {
    /* unreadable output dir — nothing to sweep */
  }
}

/** Parse one framed line, or `null` for a blank or malformed one (a truncated final write). */
function parseRow(line: string): CfgSpillRow | null {
  if (line.length === 0) return null;
  const firstTab = line.indexOf('\t');
  if (firstTab < 0) return null;
  const secondTab = line.indexOf('\t', firstTab + 1);
  if (secondTab < 0) return null;
  try {
    return {
      functionId: JSON.parse(line.slice(0, firstTab)) as string,
      filePath: JSON.parse(line.slice(firstTab + 1, secondTab)) as string,
      cfgJson: line.slice(secondTab + 1),
    };
  } catch {
    return null;
  }
}
