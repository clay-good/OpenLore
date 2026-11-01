/**
 * Blank everything in a source file that is not code, keeping module specifiers
 * (change: add-phantom-reference-findings).
 *
 * The import scanners in this codebase are regex passes over text. That is fine for building a call
 * graph, where a stray match costs a spurious edge, but the phantom-reference check turns a match
 * into a finding an agent is told to act on — so an `import` written inside a test fixture's
 * template literal, a documentation snippet, or a Python docstring must not be read as an import at
 * all.
 *
 * `sanitizeForRegex` almost does this, but it blanks every string body, and a module specifier IS a
 * string body: `import x from './y'` would lose `./y`. This mask keeps exactly the string bodies
 * that sit in specifier position — directly after `from`, `import(`, or `require(` — and blanks the
 * rest. Every character offset and line break is preserved, so the scanners' reported positions
 * still refer to the original text.
 *
 * It is one pass with no regex over the content, and every lookahead is bounded by a constant, so a
 * hostile file cannot make it quadratic.
 *
 * Deliberately NOT a parser: it recognizes comments, strings, template literals, and regex
 * literals, which is what it takes to tell code from text. JSX is not parsed; the rule that a
 * single- or double-quoted string cannot span a line (which is true in both JavaScript and Python)
 * is what keeps an apostrophe in JSX prose from swallowing the rest of the file.
 */

/** Which comment and string syntax a file uses. */
export type MaskFlavor = 'js' | 'python';

/** The code context in which a quote opens a module specifier rather than an ordinary string. */
const SPECIFIER_POSITION = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/;
/** How much preceding code is kept to decide specifier position. */
const TAIL = 32;
/** Longest regex literal recognized; past this the slash is read as division, which blanks nothing. */
const MAX_REGEX_LITERAL = 1_024;
/** How deep template interpolation is followed before the simple "next backtick" rule is used. */
const MAX_TEMPLATE_DEPTH = 16;

/** Keywords after which a `/` can only begin a regex literal, never divide. */
const REGEX_AFTER_KEYWORD = /(?<![.\w$])(?:return|typeof|case|in|of|new|delete|void|yield|do|else|instanceof|throw|await)$/;

/** True when a `/` at this point opens a regex literal rather than being a division operator. */
function opensRegex(tail: string): boolean {
  const code = tail.replace(/\s+$/, '');
  if (code === '') return true;
  // `return /re/` divides nothing: the last character is a keyword's, not a value's.
  if (REGEX_AFTER_KEYWORD.test(code)) return true;
  // After a value (identifier, number, closing bracket) a slash divides; anywhere else it is a regex.
  return !/[\w$)\]]/.test(code.slice(-1));
}

/** Index just past a single-line quoted string opening at `start`; `start + 1` when it never closes. */
function skipQuoted(content: string, start: number): number {
  const quote = content[start];
  let i = start + 1;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return start + 1; // unterminated on its line: not a string at all
    if (c === quote) return i + 1;
    i++;
  }
  return start + 1;
}

/**
 * Index just past the template literal whose opening backtick is at `start`. Interpolations are
 * followed, so a template nested inside `${…}` is consumed as part of the outer one rather than
 * ending it early — the shape that would otherwise leak a fixture's body as code.
 */
function skipTemplate(content: string, start: number, depth = 0): number {
  const scan = (followInterpolations: boolean): number => {
    let i = start + 1;
    while (i < content.length) {
      const c = content[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') return i + 1;
      if (followInterpolations && c === '$' && content[i + 1] === '{' && depth < MAX_TEMPLATE_DEPTH) {
        i = skipInterpolation(content, i + 2, depth + 1);
        continue;
      }
      i++;
    }
    return content.length;
  };
  const end = scan(true);
  // A brace inside a regex or a string the interpolation scan does not model (`${s.replace(/[{]/g,'')}`)
  // never balances, and the scan then runs to the end of the file. Falling back to the simple
  // "ends at the next backtick" rule keeps the rest of the file readable as code.
  return end >= content.length && content[content.length - 1] !== '`' ? scan(false) : end;
}

/** Index just past the `}` that closes an interpolation whose body starts at `start`. */
function skipInterpolation(content: string, start: number, depth: number): number {
  let i = start;
  let braces = 1;
  while (i < content.length && braces > 0) {
    const c = content[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { i = skipTemplate(content, i, depth); continue; }
    if (c === '"' || c === "'") { i = skipQuoted(content, i); continue; }
    if (c === '{') braces++;
    else if (c === '}') braces--;
    i++;
  }
  return i;
}

/**
 * `content` with comment, string, template, and regex bodies replaced by spaces — except a string
 * body in module-specifier position, which is kept verbatim. Same length, same line breaks.
 */
export function maskNonCode(content: string, flavor: MaskFlavor): string {
  const out: string[] = [];
  /** The code emitted so far, trimmed to its tail, for the specifier-position test. */
  let tail = '';
  const emitCode = (text: string): void => {
    out.push(text);
    tail = (tail + text).slice(-TAIL);
  };
  /** Blank a run, keeping line breaks so positions and line numbers survive. */
  const blank = (text: string): void => {
    out.push(text.replace(/[^\n]/g, ' '));
  };

  const length = content.length;
  let i = 0;
  while (i < length) {
    const ch = content[i];
    const next = content[i + 1];

    // ── comments ────────────────────────────────────────────────────────────
    if (flavor === 'js' && ch === '/' && next === '/') {
      const end = content.indexOf('\n', i);
      const stop = end === -1 ? length : end;
      blank(content.slice(i, stop));
      i = stop;
      continue;
    }
    if (flavor === 'js' && ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end === -1 ? length : end + 2;
      blank(content.slice(i, stop));
      i = stop;
      continue;
    }
    if (flavor === 'python' && ch === '#') {
      const end = content.indexOf('\n', i);
      const stop = end === -1 ? length : end;
      blank(content.slice(i, stop));
      i = stop;
      continue;
    }

    // ── triple-quoted strings (Python docstrings) ───────────────────────────
    if (flavor === 'python' && (ch === '"' || ch === "'") && content.startsWith(ch.repeat(3), i)) {
      const quote = ch.repeat(3);
      const end = content.indexOf(quote, i + 3);
      const stop = end === -1 ? length : end + 3;
      blank(content.slice(i, stop));
      i = stop;
      continue;
    }

    // ── template literals ───────────────────────────────────────────────────
    if (flavor === 'js' && ch === '`') {
      // The body is text, interpolations included: a reference the mask hides is a reference not
      // reported, which is the safe direction.
      const end = skipTemplate(content, i);
      const closed = end <= length && content[end - 1] === '`';
      emitCode('`');
      blank(content.slice(i + 1, closed ? end - 1 : end));
      if (closed) emitCode('`');
      i = end;
      continue;
    }

    // ── regex literals ──────────────────────────────────────────────────────
    if (flavor === 'js' && ch === '/' && opensRegex(tail)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      // Bounded: an unterminated character class would otherwise make every later slash on the line
      // re-scan to its end, which is quadratic over a file of them.
      const limit = Math.min(length, i + MAX_REGEX_LITERAL);
      while (j < limit) {
        const c = content[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break; // a regex literal cannot span a line: it was a division after all
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        emitCode('/');
        blank(content.slice(i + 1, j - 1));
        emitCode('/');
        i = j;
        continue;
      }
      if (j >= limit && limit < length) {
        // Longer than any real literal and still open: blank the rest of the line rather than
        // re-reading the slash as code, where a `/*` inside it would open a comment to EOF.
        const nl = content.indexOf('\n', i);
        const stop = nl === -1 ? length : nl;
        blank(content.slice(i, stop));
        i = stop;
        continue;
      }
      // Not a regex after all; fall through and treat the slash as code.
    }

    // ── quoted strings ──────────────────────────────────────────────────────
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < length) {
        const c = content[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break; // unterminated on its line: not a string (JSX prose, an odd comment)
        if (c === ch) { closed = true; break; }
        j++;
      }
      if (closed) {
        const body = content.slice(i + 1, j);
        const isSpecifier = SPECIFIER_POSITION.test(tail);
        emitCode(ch);
        if (isSpecifier) emitCode(body);
        else blank(body);
        emitCode(ch);
        i = j + 1;
        continue;
      }
      // Unterminated: the quote is prose, so keep it as code and move on by one character.
    }

    emitCode(ch);
    i++;
  }
  return out.join('');
}

/** The mask flavor for a language name, or null when the language is not masked. */
export function maskFlavorFor(language: string): MaskFlavor | null {
  switch (language) {
    case 'TypeScript':
    case 'JavaScript':
      return 'js';
    case 'Python':
      return 'python';
    default:
      return null;
  }
}
