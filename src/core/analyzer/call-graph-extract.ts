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

/** Longest deprecation hint kept: a replacement pointer, not documentation. */
export const MAX_DEPRECATION_HINT = 200;

function boundHint(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DEPRECATION_HINT ? `${flat.slice(0, MAX_DEPRECATION_HINT - 1)}…` : flat;
}

/**
 * Languages whose standard deprecation marker {@link extractDeprecation} reads (change:
 * add-deprecation-propagation). The language-support registry derives `deprecationMarkers`
 * from this set, so the matrix cannot claim a language this function does not read.
 */
export const DEPRECATION_MARKER_LANGUAGES: ReadonlySet<string> = new Set(['TypeScript', 'JavaScript', 'Go', 'Python']);

/**
 * The language's standard deprecation marker on the declaration at `startIndex`, or undefined
 * (change: add-deprecation-propagation). Only the structural conventions are read, never the
 * word "deprecated" in prose:
 *   - TypeScript / JavaScript: a JSDoc `@deprecated` tag at the start of a line of the
 *     `/** … *\/` block immediately before the declaration;
 *   - Go: a `// Deprecated:` paragraph in the comment immediately before (staticcheck SA1019);
 *   - Python: a `@deprecated(…)`, `@warnings.deprecated(…)`, or `@typing_extensions.deprecated(…)`
 *     decorator (PEP 702). The node's start already includes its decorators.
 * `hint` is the marker's remaining text (the replacement pointer), whitespace-collapsed and
 * bounded; empty when the marker carries none.
 */
/** Modifiers and a simple `const name: T =` binding between a JSDoc block and the node start. */
const TS_DECLARATION_PREFIX =
  /(?:\b(?:export|default|declare|async|public|private|protected|static|readonly|abstract|override)\s+)*(?:\b(?:const|let|var)\s+[\w$]+\s*(?::[^=;{}()]*)?=\s*)?$/;

export function extractDeprecation(
  source: string,
  startIndex: number,
  language: string,
): { hint: string } | undefined {
  if (!DEPRECATION_MARKER_LANGUAGES.has(language)) return undefined;

  if (language === 'Python') {
    // Decorators run from the node start to its `def` line; look no further than that.
    const head = source.slice(startIndex, Math.min(source.length, startIndex + 2000));
    const def = /^[ \t]*(?:async[ \t]+)?def[ \t]/m.exec(head);
    const decorators = def ? head.slice(0, def.index) : '';
    const m = /^[ \t]*@(?:(?:warnings|typing_extensions)\.)?deprecated\b[ \t]*(\()?/m.exec(decorators);
    if (!m) return undefined;
    if (!m[1]) return { hint: '' };
    const arg = /^\s*(?:reason\s*=\s*)?(?:[rRuU]?)(["'])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(decorators.slice(m.index + m[0].length));
    return { hint: arg ? boundHint(arg[2]) : '' };
  }

  let pos = startIndex - 1;
  if (language !== 'Go') {
    // A TS/JS node can start after `export` / modifiers, or be the value of `const name =`; the
    // JSDoc block sits before all of that. Bounded window, end-anchored: no backtracking blow-up.
    const windowStart = Math.max(0, startIndex - 300);
    const prefix = TS_DECLARATION_PREFIX.exec(source.slice(windowStart, startIndex));
    if (prefix) pos = windowStart + prefix.index - 1;
  }
  while (pos >= 0 && /\s/.test(source[pos])) pos--;
  if (pos < 0) return undefined;

  if (language === 'Go') {
    // Contiguous `//` lines immediately before the declaration, top to bottom.
    const lines: string[] = [];
    let lineEnd = pos;
    while (lineEnd >= 0) {
      let lineStart = lineEnd;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      const trimmed = source.slice(lineStart, lineEnd + 1).trim();
      if (!trimmed.startsWith('//')) break;
      lines.unshift(trimmed.slice(2).trim());
      lineEnd = lineStart - 1;
      while (lineEnd >= 0 && (source[lineEnd] === '\n' || source[lineEnd] === '\r')) lineEnd--;
    }
    for (let i = 0; i < lines.length; i++) {
      // A paragraph starts the comment or follows a blank `//` line.
      if (!lines[i].startsWith('Deprecated:') || (i > 0 && lines[i - 1] !== '')) continue;
      const para = [lines[i].slice('Deprecated:'.length)];
      for (let j = i + 1; j < lines.length && lines[j] !== ''; j++) para.push(lines[j]);
      return { hint: boundHint(para.join(' ')) };
    }
    return undefined;
  }

  // TypeScript / JavaScript: the JSDoc block that ends right before the declaration.
  if (source[pos] !== '/' || source[pos - 1] !== '*') return undefined;
  const openIdx = source.lastIndexOf('/**', pos - 1);
  if (openIdx === -1 || source.indexOf('*/', openIdx + 3) !== pos - 1) return undefined;
  const lines = source.slice(openIdx + 3, pos - 1).split('\n').map(l => l.replace(/^\s*\*?\s?/, '').trim());
  const at = lines.findIndex(l => /^@deprecated\b/.test(l));
  if (at === -1) return undefined;
  const text = [lines[at].slice('@deprecated'.length)];
  for (let j = at + 1; j < lines.length && !lines[j].startsWith('@'); j++) text.push(lines[j]);
  return { hint: boundHint(text.join(' ')) };
}

/** `{ deprecation }` when the declaration is marked deprecated, else nothing (add-deprecation-propagation). */
export function deprecationOf(content: string, startIndex: number, language: string): { deprecation?: string } {
  const d = extractDeprecation(content, startIndex, language);
  return d ? { deprecation: d.hint } : {};
}
