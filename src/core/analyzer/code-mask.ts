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
 * It is one linear pass with no regex over the content, so a hostile file cannot make it quadratic.
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

/** True when a `/` at this point opens a regex literal rather than being a division operator. */
function opensRegex(tail: string): boolean {
  const prev = tail.replace(/\s+$/, '').slice(-1);
  if (prev === '') return true;
  // After a value (identifier, number, closing bracket) a slash divides; anywhere else it is a regex.
  return !/[\w$)\]]/.test(prev);
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
      let j = i + 1;
      let closed = false;
      while (j < length) {
        if (content[j] === '\\') { j += 2; continue; }
        if (content[j] === '`') { closed = true; break; }
        j++;
      }
      // The body is text; an interpolation inside it is not read either, which is the safe
      // direction: a reference the mask hides is a reference not reported.
      emitCode('`');
      blank(content.slice(i + 1, Math.min(j, length)));
      if (closed) emitCode('`');
      i = closed ? j + 1 : j;
      continue;
    }

    // ── regex literals ──────────────────────────────────────────────────────
    if (flavor === 'js' && ch === '/' && opensRegex(tail)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < length) {
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
