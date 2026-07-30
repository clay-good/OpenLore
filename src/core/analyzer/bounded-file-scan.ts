/**
 * Bounded repository-wide file scanning (change: fix-unbounded-file-scan-oom).
 *
 * This is the one way this codebase fans out a read across every file in a repository.
 *
 * Every such scan used to be written `await Promise.all(files.map(async f => { const src =
 * await readFile(f, 'utf-8'); ... }))`. That issues one read per file *simultaneously*, so at
 * the peak the entire repository is resident in the heap — and `analyze` ran five of those
 * scans concurrently. Past a few hundred megabytes of source it is a fatal OOM, not a
 * slowdown: V8 aborts inside the read-completion path with no partial result, no artifact, and
 * no indication of which phase died (issue #302).
 *
 * Two bounds, because they fail independently and either alone still admits the crash:
 *
 *  - {@link mapFilesBounded} caps how many files are in flight, so peak residency is a function
 *    of the cap rather than of the repository's file count. This is the bound that fixes a
 *    repository of many ordinary files.
 *  - {@link readSourceCapped} caps how large a single file may be, so one generated or minified
 *    blob cannot exhaust the heap however low the concurrency is.
 *
 * `mapFilesBounded` resolves results in INPUT order, exactly like `Promise.all`. That is
 * load-bearing rather than cosmetic: several callers document that they depend on input
 * ordering so the artifacts they build are byte-identical across runs of a fixed repository
 * state (change: fix-artifact-output-determinism). Ordering by completion instead would make
 * the serialized graph a function of I/O timing.
 */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { SOURCE_SCAN_CONCURRENCY, SOURCE_SCAN_MAX_CONCURRENCY, SOURCE_SCAN_MAX_FILE_BYTES } from '../../constants.js';

/**
 * Run `fn` over every path with at most `concurrency` calls in flight, returning results in
 * INPUT order — a drop-in replacement for `Promise.all(paths.map(fn))` that does not scale its
 * peak memory with `paths.length`.
 *
 * Rejection behaves as `Promise.all` does: the returned promise rejects with the first error.
 * Every caller in this codebase catches per file and returns an empty result instead, so a
 * single unreadable file never aborts a scan.
 */
export async function mapFilesBounded<T>(
  paths: readonly string[],
  fn: (path: string, index: number) => Promise<T>,
  concurrency: number = SOURCE_SCAN_CONCURRENCY,
): Promise<T[]> {
  const results = new Array<T>(paths.length);
  if (paths.length === 0) return results;

  // Clamp defensively, in BOTH directions. A caller-supplied 0, NaN, or negative width must
  // still make progress; a width above the work available just wastes idle workers; and a width
  // above the ceiling is the very fan-out this module exists to prevent, so it is clamped rather
  // than honoured. `Infinity` is the natural way to spell "unbounded" for someone reaching for
  // `Promise.all` semantics, and it clamps DOWN to the ceiling — never up, and never (as a bare
  // `Number.isFinite` test would) down to a serial 1.
  const requested = Math.floor(concurrency);
  const wanted = requested > 0 ? requested : 1; // covers 0, negatives, NaN (all comparisons false)
  const width = Math.min(wanted, SOURCE_SCAN_MAX_CONCURRENCY, paths.length);

  // Workers pull from a shared cursor rather than being handed fixed slices, so one slow file
  // cannot leave the remaining workers idle behind it.
  //
  // `failed` is what makes this a faithful stand-in for `Promise.all` on the failure path.
  // `Promise.all` cannot start work after a rejection — every call was already issued before the
  // first rejection could be observed. A worker pool can: without this flag the surviving workers
  // keep draining the cursor long after the caller has given up, opening files nobody will read.
  // That is not just waste — a caller that CATCHES the rejection and starts the next scan (which
  // is exactly what `analyze` does, five times in a row) would then have two live pools at once,
  // and the peak this module promises would be breached by the abandoned one.
  let cursor = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const i = cursor++;
      if (i >= paths.length) return;
      try {
        results[i] = await fn(paths[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * Is a file of this many bytes too large for a repository-wide source scan?
 *
 * Exported so the predicate exists exactly once: the scan applies it to a `stat` result, and
 * `analyze` applies it to the sizes the walker already recorded in order to DISCLOSE the
 * exclusions. Two spellings of the same threshold would let those two surfaces disagree about
 * the same repository.
 */
export function isOversizedForScan(bytes: number, maxBytes = SOURCE_SCAN_MAX_FILE_BYTES): boolean {
  return bytes > maxBytes;
}

/**
 * The union of the file extensions the enrichment extractors read — UI components, schemas,
 * routes, middleware, and environment variables.
 *
 * Used ONLY to scope the oversized-file disclosure. A repository can hold a 6 MB image or data
 * blob that no extractor would ever have opened; reporting it as "excluded from the scan" is a
 * true statement that tells the operator nothing and trains them to ignore the warning. So the
 * disclosure is narrowed to files an extractor would actually have read.
 *
 * Errs WIDE on purpose. An extension listed here that some individual extractor ignores costs at
 * most one over-reported file; an extension missing here would silently hide a genuinely dropped
 * component, route, or environment variable — the exact failure the disclosure exists to prevent.
 */
export const SCANNED_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw', '.go', '.rb', '.java',
  '.vue', '.svelte', '.prisma',
]);

/**
 * Environment-declaration files the env scan reads. Lives here, beside the extension set, because
 * these files are the reason an extension test alone is NOT a sufficient description of what the
 * enrichment scans open: `extname('.env')` is `''`, `extname('.env.local')` is `'.local'`, and
 * `extname('.env.production')` is `'.production'` — none of which is a source extension. A
 * disclosure predicate built only from extensions therefore drops an oversized `.env` silently,
 * which is precisely the failure this module claims to prevent.
 */
export const ENV_DECLARATION_FILES: ReadonlySet<string> = new Set([
  '.env', '.env.example', '.env.local', '.env.test', '.env.production',
]);

/**
 * Would an enrichment scan have opened this file at all?
 *
 * The single predicate behind the oversized-file disclosure. It exists so that "what the scans
 * read" and "what we tell the operator we skipped" cannot drift apart: a file this returns `false`
 * for was never going to contribute, so reporting it as excluded is noise; a file it returns
 * `true` for and that exceeds the cap MUST be reported.
 */
export function isScannedByEnrichment(filePath: string): boolean {
  const name = basename(filePath);
  if (ENV_DECLARATION_FILES.has(name)) return true;
  return SCANNED_SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Read a source file as UTF-8, or return `null` if it is unreadable or exceeds the scan's
 * per-file size cap.
 *
 * The size is measured BEFORE the read, which is the whole point: reading first and measuring
 * after would already have materialized the buffer and the string that the cap exists to prevent.
 *
 * Two things are required to make that actually true, and it is worth being precise about which
 * does what, because getting one of them is easy to mistake for getting both:
 *
 *  - The measurement and the read go through ONE open file handle, never a `stat(path)` followed
 *    by a `readFile(path)`. Those are two independent resolutions of the same NAME, so a path
 *    that was replaced or re-symlinked in between would be read at a size belonging to a
 *    different file.
 *  - The read is bounded to the size that was checked. This is the part a single handle does NOT
 *    give you: `handle.readFile()` reads to CURRENT end-of-file, so a file appended to after the
 *    `stat` is read in full — measured, a 1 KB file that grew to 20 MB during the await window
 *    came back as 20 MB through a 4 MB cap. Reading exactly `size` bytes into a buffer allocated
 *    at `size` bounds the allocation by construction, whatever the file does afterwards.
 *
 * For a tool that analyzes untrusted repositories — and that re-analyzes while a watcher is
 * rewriting files — this is a real boundary, not a theoretical one.
 *
 * A file that GREW is therefore truncated to the prefix that was measured. That costs nothing in
 * practice: for a file nobody is writing (every real scan) `size` IS the whole file, so the read
 * is exact and no character can be split.
 *
 * `null` deliberately does not distinguish "too large" from "unreadable" — a scan callback can
 * do nothing different about either. The user-facing distinction is made by the caller, which
 * reports oversized files from the sizes the walker recorded, so the exclusion is disclosed
 * rather than silent.
 */
export async function readSourceCapped(
  path: string,
  maxBytes = SOURCE_SCAN_MAX_FILE_BYTES,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    const s = await handle.stat();
    if (!s.isFile() || isOversizedForScan(s.size, maxBytes)) return null;

    // Read at most the bytes we just checked for. NOT `handle.readFile()`, which reads to EOF and
    // would hand back whatever the file has become since (see the docblock above).
    const buf = Buffer.allocUnsafe(s.size);
    let read = 0;
    while (read < s.size) {
      const { bytesRead } = await handle.read(buf, read, s.size - read, read);
      if (bytesRead === 0) break; // the file shrank under us; keep the prefix we did get
      read += bytesRead;
    }
    return buf.subarray(0, read).toString('utf-8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => { /* closing a handle we are done with cannot fail usefully */ });
  }
}
