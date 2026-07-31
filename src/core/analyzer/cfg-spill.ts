/**
 * Off-heap hand-off for the CFG/def-use overlay (change: bound-cfg-overlay-residency; issue #304).
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
 * So the overlay goes to a file instead, and is drained into the table after the clear. Peak
 * residency becomes one write buffer rather than the repository.
 *
 * The format is one JSON-framed record per line. Both the id and the path are `JSON.stringify`d,
 * so a tab or newline in either is escaped by construction and the framing cannot be broken by a
 * repository-controlled path. The CFG itself is stored ALREADY SERIALIZED, exactly as
 * `insertCfgs` would have serialized it, so the drain binds a string straight into SQLite — no
 * parse, no re-stringify, and no chance of the round-trip altering the persisted bytes.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { FunctionCfg } from './cfg.js';

/** One persisted overlay row, with its CFG already in the exact form the table stores. */
export interface CfgSpillRow {
  functionId: string;
  filePath: string;
  cfgJson: string;
}

/**
 * How many rows buffer before a write is issued. Bounds the transient array without paying a
 * syscall per function.
 */
const WRITE_BUFFER_ROWS = 512;

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

export class CfgSpill {
  private readonly stream: WriteStream;
  private buffer: string[] = [];
  private rows = 0;
  private _failed = false;
  private disposed = false;

  private constructor(readonly path: string, stream: WriteStream) {
    this.stream = stream;
    // A spill failure must never fail the build — the overlay is an optional precision refinement,
    // and a missing row already degrades to a disclosed function-granularity answer.
    this.stream.on('error', () => { this._failed = true; });
  }

  /**
   * Open a spill file, or return `null` if one cannot be created — a read-only or full filesystem
   * then simply keeps the previous in-memory behaviour rather than failing the analysis.
   */
  static async open(outputDir: string): Promise<CfgSpill | null> {
    // Inside the analysis directory, not the OS temp dir: this is the one place the run has
    // already proven it can write, and `rm -rf .openlore` / `analyze --force` clean it up with
    // everything else. The pid keeps concurrent analyses from colliding.
    const path = join(outputDir, `.cfg-spill-${process.pid}.ndjson`);
    try {
      const handle = await open(path, 'w');
      await handle.close();
      return new CfgSpill(path, createWriteStream(path, { flags: 'w' }));
    } catch {
      return null;
    }
  }

  /** Did any write fail? A failed spill must be discarded whole, never persisted in part. */
  get failed(): boolean { return this._failed; }

  /** How many rows have been accepted. */
  get count(): number { return this.rows; }

  /**
   * Record one file's overlay. Serializes here, at the point the CFGs are still warm, so the
   * objects become collectable as soon as the caller drops its reference to them.
   */
  write(filePath: string, cfgs: Iterable<[string, FunctionCfg]>): void {
    if (this._failed) return;
    for (const [functionId, cfg] of cfgs) {
      let cfgJson: string;
      try {
        cfgJson = JSON.stringify(cfg);
      } catch {
        continue; // an unserializable overlay is dropped, exactly as a failed insert would be
      }
      this.buffer.push(`${JSON.stringify(functionId)}\t${JSON.stringify(filePath)}\t${cfgJson}\n`);
      this.rows++;
    }
    if (this.buffer.length >= WRITE_BUFFER_ROWS) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    if (!this.stream.write(chunk)) {
      // Backpressure is not awaited: the stream buffers, and the total is bounded by the spill
      // file's own size rather than by the heap. `finish()` waits for the drain.
    }
  }

  /** Flush and close. Must be awaited before {@link drain}. */
  async finish(): Promise<void> {
    this.flush();
    await new Promise<void>(resolve => {
      this.stream.end(() => resolve());
      this.stream.on('error', () => resolve());
    });
  }

  /**
   * Read the spilled rows back, one at a time. Never holds more than one chunk plus the partial
   * line that straddles it.
   */
  async *drain(): AsyncGenerator<CfgSpillRow> {
    if (this._failed) return;
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

  /** Remove the spill file. Idempotent, and never throws. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.stream.destroy();
    } catch { /* already closed */ }
    await unlink(this.path).catch(() => { /* already gone */ });
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
