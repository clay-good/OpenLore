/**
 * Kotlin source helpers shared by every Kotlin parse site
 * (change: harden-kotlin-grammar-currency, issue #546).
 *
 * Dependency-free leaf. Both functions are single-pass, linear, and LENGTH-PRESERVING: an offset
 * or line number in the result is the same offset or line number in the input.
 */

/**
 * Return `content` with comments and string-literal text replaced by spaces, newlines kept.
 * Code inside a `${ … }` template expression is kept, because it is code. Nested block comments,
 * raw strings, character literals, and backtick identifiers are handled. An unterminated literal
 * or comment runs to the end of input.
 */
export function kotlinCodeMask(content: string): string {
  const n = content.length;
  const out = new Array<string>(n);
  const blank = (i: number): void => { out[i] = content[i] === '\n' ? '\n' : ' '; };
  // Each frame is a string we are inside of: its closing delimiter, and the brace depth of the
  // template expression currently open in it (0 = in string text).
  const strings: Array<{ raw: boolean; depth: number }> = [];
  let i = 0;
  const inCode = (): boolean => strings.length === 0 || strings[strings.length - 1].depth > 0;

  while (i < n) {
    const c = content[i];
    const next = content[i + 1];
    if (!inCode()) {
      const frame = strings[strings.length - 1];
      if (frame.raw ? content.startsWith('"""', i) : c === '"') {
        let end = i + (frame.raw ? 3 : 1);
        // A raw string may end with extra quotes that belong to its text (`""""`).
        if (frame.raw) while (content[end] === '"') end++;
        for (; i < end; i++) blank(i);
        strings.pop();
        continue;
      }
      if (!frame.raw && c === '\\' && i + 1 < n) { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '$' && next === '{') { blank(i); blank(i + 1); i += 2; frame.depth = 1; continue; }
      blank(i); i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && content[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 0;
      while (i < n) {
        if (content[i] === '/' && content[i + 1] === '*') { depth++; blank(i); blank(i + 1); i += 2; continue; }
        if (content[i] === '*' && content[i + 1] === '/') {
          depth--; blank(i); blank(i + 1); i += 2;
          if (depth === 0) break;
          continue;
        }
        blank(i); i++;
      }
      continue;
    }
    if (c === '"') {
      const raw = content.startsWith('"""', i);
      const width = raw ? 3 : 1;
      for (let k = 0; k < width; k++) blank(i + k);
      i += width;
      strings.push({ raw, depth: 0 });
      continue;
    }
    if (c === "'") {
      // Character literal: 'a', '\n', 'A'. Bounded so a stray quote cannot swallow the file.
      let end = i + 1;
      if (content[end] === '\\') end += 2;
      else end += 1;
      while (end < n && end < i + 8 && content[end] !== "'" && content[end] !== '\n') end++;
      if (content[end] === "'") { for (; i <= end; i++) blank(i); continue; }
      out[i] = c; i++;
      continue;
    }
    if (c === '`') {
      const end = content.indexOf('`', i + 1);
      const stop = end < 0 || content.slice(i, end).includes('\n') ? i : end;
      for (; i <= stop; i++) out[i] = content[i];
      continue;
    }
    if (strings.length > 0) {
      const frame = strings[strings.length - 1];
      if (c === '{') frame.depth++;
      else if (c === '}') {
        frame.depth--;
        if (frame.depth === 0) { blank(i); i++; continue; }
      }
    }
    out[i] = c;
    i++;
  }
  return out.join('');
}

/**
 * Stable Kotlin syntax that the pinned grammar reports as an error, rewritten to an equivalent
 * shape the grammar accepts. Each rewrite keeps the length and only touches code (never a comment
 * or a string), so every node offset still indexes the original source:
 *
 * - `fun interface X` → `    interface X`. The declaration is still an interface with the same
 *   members; only the functional-interface marker is hidden from the parser.
 * - `a..<b` → `a.. b`. The range still has the same two operands.
 * - `$$"…"` → `  "…"`. The literal is still one string with the same extent; only the
 *   multi-dollar prefix is hidden. (Its text may then show a `$name` as a template reference.
 *   No extractor reads a name out of a template reference.)
 *
 * A file that uses neither form is returned unchanged (same string instance).
 */
export function normalizeKotlinForParse(content: string): string {
  if (!content.includes('..<') && !content.includes('$$"') && !/\bfun\s+interface\b/.test(content)) return content;
  const code = kotlinCodeMask(content);
  const chars = [...content];
  let changed = false;
  if (chars.length !== content.length) return content; // astral characters: offsets would not line up
  for (const m of code.matchAll(/\bfun(?=[ \t]{1,8}interface\b)/g)) {
    for (let k = 0; k < 3; k++) chars[m.index + k] = ' ';
    changed = true;
  }
  for (let at = code.indexOf('..<'); at >= 0; at = code.indexOf('..<', at + 3)) {
    chars[at + 2] = ' ';
    changed = true;
  }
  for (const m of code.matchAll(/\$\$+/g)) {
    if (content[m.index + m[0].length] !== '"') continue;
    for (let k = 0; k < m[0].length; k++) chars[m.index + k] = ' ';
    changed = true;
  }
  return changed ? chars.join('') : content;
}
