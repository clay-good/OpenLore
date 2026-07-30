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
import { readFile, stat } from 'node:fs/promises';

import { SOURCE_SCAN_CONCURRENCY, SOURCE_SCAN_MAX_FILE_BYTES } from '../../constants.js';

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

  // Clamp defensively: a caller-supplied 0, NaN, or negative width must still make progress,
  // and a width above the work available just wastes idle workers.
  const requested = Math.floor(concurrency);
  const width = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : 1,
    paths.length,
  );

  // Workers pull from a shared cursor rather than being handed fixed slices, so one slow file
  // cannot leave the remaining workers idle behind it.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= paths.length) return;
      results[i] = await fn(paths[i], i);
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
 * Read a source file as UTF-8, or return `null` if it is unreadable or exceeds the scan's
 * per-file size cap.
 *
 * The size is checked with `stat` BEFORE the read, which is the whole point: reading first and
 * measuring after would already have materialized the buffer and the string that the cap exists
 * to prevent.
 *
 * `null` deliberately does not distinguish "too large" from "unreadable" — a scan callback can
 * do nothing different about either. The user-facing distinction is made by `analyze`, which
 * reports oversized files from the sizes the walker recorded, so the exclusion is disclosed
 * rather than silent.
 */
export async function readSourceCapped(
  path: string,
  maxBytes = SOURCE_SCAN_MAX_FILE_BYTES,
): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || isOversizedForScan(s.size, maxBytes)) return null;
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}
