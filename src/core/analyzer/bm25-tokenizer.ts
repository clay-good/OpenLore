/**
 * Version of the `tokenize` contract. Bump whenever the token set produced for a
 * given text changes, so persisted indexes are rebuilt before incremental use.
 *   v1 — lowercase + split on non-alphanumeric only.
 *   v2 — identifier-aware: also split camelCase/PascalCase and retain the compound.
 */
export const TOKENIZER_VERSION = 2;

/**
 * Split one alphanumeric chunk on camelCase / PascalCase boundaries.
 *
 * The acronym rule captures ONE capital, not `([A-Z]+)`. The `+` was pure waste and it
 * was quadratic: it ate the whole run of capitals, then required `[A-Z][a-z]`, then gave
 * the run back one character at a time — from every start offset. `tokenize` splits on
 * `[^A-Za-z0-9]+`, so an all-capitals identifier arrives here as ONE unbounded chunk
 * (`buildText` appends a function's skeleton body straight out of the source), and a
 * 200,000-character uppercase identifier is legal JavaScript. Measured on the real
 * `tokenize`: 7.5 s at 50 KB of `A`, 129 s at 200 KB — paid over the whole indexed corpus.
 *
 * Byte-identical output, not merely equivalent: both forms insert the space in the same
 * place and end the match at the same offset, so the `/g` scan continues identically.
 * Old `([A-Z]+)` matched the maximal capital run and backtracked so the last capital fell
 * into group 2; the space therefore landed immediately before that last capital, which is
 * exactly where matching a single capital puts it. The leading capitals old consumed are
 * copied through unchanged either way. Hence `TOKENIZER_VERSION` does NOT need bumping —
 * no persisted index becomes stale. (Checked on `HTTPServer`, `XMLHttpRequest`, `ABCd`,
 * `parseJSONData`, `ABc`, `ABCDe`, `A`, `AB`, and every line of every TS file in the repo.)
 */
function splitCompound(chunk: string): string[] {
  return chunk
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

/**
 * Identifier-aware tokenizer shared by BM25 indexing, querying, and the
 * task-scoped injection relevance gate. This module intentionally has no
 * runtime dependencies so lightweight hosts can reuse the exact contract.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    const compound = chunk.toLowerCase();
    if (compound.length > 1) out.push(compound);
    const subs = splitCompound(chunk);
    if (subs.length > 1) {
      for (const s of subs) {
        const lowered = s.toLowerCase();
        if (lowered.length > 1) out.push(lowered);
      }
    }
  }
  return out;
}
