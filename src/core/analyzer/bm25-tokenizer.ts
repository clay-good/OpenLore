/**
 * Version of the `tokenize` contract. Bump whenever the token set produced for a
 * given text changes, so persisted indexes are rebuilt before incremental use.
 *   v1 — lowercase + split on non-alphanumeric only.
 *   v2 — identifier-aware: also split camelCase/PascalCase and retain the compound.
 */
export const TOKENIZER_VERSION = 2;

/** Split one alphanumeric chunk on camelCase / PascalCase boundaries. */
function splitCompound(chunk: string): string[] {
  return chunk
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
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
