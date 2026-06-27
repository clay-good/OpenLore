/**
 * Docstring & declaration-signature extraction helpers — extracted from
 * `call-graph.ts` (change: modularize-call-graph-builder; analyzer:
 * StableCallGraphBarrel).
 *
 * Two pure string-scanning functions over source text + AST byte offsets, with no
 * dependency on the rest of the analyzer (no tree-sitter, no module state). They
 * were file-internal helpers in `call-graph.ts` (never on its public surface), so
 * they are exported here and imported back by the extractors — the public import
 * surface of `call-graph.ts` is unchanged. Moving them cannot alter graph output.
 */

/**
 * Scan backward from `startIndex` in `source` to find the doc comment
 * immediately preceding the function declaration. Skip blank lines.
 *
 * For Python, docstrings are INSIDE the function body — scan forward from
 * `startIndex` past the `def name(...):` colon to find the triple-quoted string.
 *
 * Returns the first meaningful (non-empty, non-decorator) line of the comment.
 */
export function extractDocstringBefore(
  source: string,
  startIndex: number,
  language: string
): string | undefined {
  // ── Python: scan forward past the colon into the function body ──────────
  if (language === 'Python') {
    // Find the colon that ends the `def` line. Track bracket depth so a colon
    // inside a parameter annotation (`def f(x: int) -> T:`) doesn't end the scan
    // prematurely — mirrors the depth handling in extractDeclaration below.
    let i = startIndex;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) break;
      i++;
    }
    // Skip past the colon
    i++;
    // Skip whitespace / newline
    while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r')) i++;
    // Check for triple-quoted docstring
    const tripleDouble = source.startsWith('"""', i);
    const tripleSingle = source.startsWith("'''", i);
    if (tripleDouble || tripleSingle) {
      const quote = tripleDouble ? '"""' : "'''";
      const bodyStart = i + 3;
      const closeIdx = source.indexOf(quote, bodyStart);
      if (closeIdx === -1) return undefined;
      const inner = source.slice(bodyStart, closeIdx);
      const firstLine = inner.split('\n').map(l => l.trim()).find(l => l.length > 0);
      return firstLine ?? undefined;
    }
    return undefined;
  }

  // ── All other languages: scan backward from startIndex ─────────────────
  // Move to the character just before startIndex
  let pos = startIndex - 1;

  // Skip trailing whitespace / newlines before the declaration
  while (pos >= 0 && (source[pos] === ' ' || source[pos] === '\t' || source[pos] === '\n' || source[pos] === '\r')) {
    pos--;
  }

  if (pos < 0) return undefined;

  // ── TypeScript / JavaScript / Java / C++: JSDoc block /** ... */ ────────
  if (
    language === 'TypeScript' || language === 'JavaScript' ||
    language === 'Java' || language === 'C++'
  ) {
    // Expect closing */ of a JSDoc block
    if (source[pos] === '/' && pos > 0 && source[pos - 1] === '*') {
      const closePos = pos - 1; // points at '*' of closing '*/'
      // Find opening /**
      const openIdx = source.lastIndexOf('/**', closePos);
      if (openIdx === -1) return undefined;
      const inner = source.slice(openIdx + 3, closePos - 0);
      // Remove leading * on each line, find first non-empty, non-@ line
      const firstLine = inner
        .split('\n')
        .map(l => l.replace(/^\s*\*\s?/, '').trim())
        .find(l => l.length > 0 && !l.startsWith('@'));
      return firstLine ?? undefined;
    }
    return undefined;
  }

  // ── Go: // comment lines immediately before ──────────────────────────────
  if (language === 'Go') {
    const lines: string[] = [];
    // Walk backward line by line
    let lineEnd = pos;
    while (lineEnd >= 0) {
      // Find start of this line
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        lines.unshift(trimmed.slice(2).trim());
        lineEnd = lineStart - 1;
        // Skip over the newline
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  // ── Rust / Swift: /// doc comment lines immediately before ─────────────
  if (language === 'Rust' || language === 'Swift') {
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('///')) {
        lines.unshift(trimmed.slice(3).trim());
        lineEnd = lineStart - 1;
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  // ── Ruby: # comment lines immediately before ─────────────────────────────
  if (language === 'Ruby') {
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const line = source.slice(lineStart, lineEnd + 1).trimEnd();
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        lines.unshift(trimmed.slice(1).trim());
        lineEnd = lineStart - 1;
        while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
      } else {
        break;
      }
    }
    return lines.find(l => l.length > 0) ?? undefined;
  }

  return undefined;
}

/**
 * Extract the function declaration (signature without body) from
 * `source.slice(startIndex, endIndex)`.
 *
 * Strategy:
 * - TS/JS/Java/C++/Go/Rust/Ruby: take everything up to the first `{` at depth 0
 * - Python: take everything up to the first `:` that ends the `def` line
 *
 * Whitespace is normalized (multiple spaces/newlines → single space).
 * Limited to 300 characters max.
 */
export function extractDeclaration(
  source: string,
  startIndex: number,
  endIndex: number,
  language: string
): string {
  const slice = source.slice(startIndex, Math.min(endIndex, startIndex + 1500));

  let decl: string;

  if (language === 'Python') {
    // Take up to (not including) the first `:` that ends the def line
    // We scan for `:` while tracking parenthesis depth to avoid matching
    // colons inside type annotations (e.g., def f(x: int) -> dict[str, int]:)
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ':' && depth === 0) {
        end = i;
        break;
      }
    }
    decl = end !== -1 ? slice.slice(0, end) : slice.slice(0, 300);
  } else {
    // Find first `{` at brace depth 0
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      if (ch === '{') {
        if (depth === 0) { end = i; break; }
        depth++;
      } else if (ch === '}') {
        depth--;
      }
    }
    decl = end !== -1 ? slice.slice(0, end) : slice.slice(0, 300);
  }

  // Normalize whitespace
  return decl.replace(/\s+/g, ' ').trim().slice(0, 300);
}
