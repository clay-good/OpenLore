/**
 * Byte offset → line number, without re-scanning the file for every lookup.
 *
 * The naive form of this — `content.substring(0, position).split('\n').length` — is the single
 * most expensive thing OpenLore did on a large file. It copies the whole prefix AND allocates an
 * array of every line in it, per lookup, so a file with many matches pays its own length once per
 * match: Σ(matches × file length), quadratic in exactly the wrong variable.
 *
 * Measured on a 2 MB single-file fixture (33,116 functions), that one expression was 50% of the
 * entire `analyze` run. It is why analyze went from 9s at 1 MB to 589s at 5 MB — 5× the input for
 * 65× the time, on a file shape (one big generated or vendored module) that is completely ordinary.
 *
 * Build the index once per file, then binary-search it.
 */

/** Offsets of every `\n` in `content`. Build once per file. */
export function buildLineIndex(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i);
  }
  return offsets;
}

/**
 * 1-based line number for `byteOffset`.
 *
 * Exactly the count of newlines strictly before the offset, plus one — the same value
 * `content.substring(0, byteOffset).split('\n').length` produces, including at offset 0 (line 1)
 * and for an offset that lands on a newline itself (the line that newline terminates).
 */
export function lineFromIndex(lineIndex: number[], byteOffset: number): number {
  let lo = 0;
  let hi = lineIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineIndex[mid] < byteOffset) lo = mid + 1; else hi = mid;
  }
  return lo + 1;
}
