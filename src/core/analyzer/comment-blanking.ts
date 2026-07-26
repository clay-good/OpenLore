/**
 * Blank comment bodies while preserving every byte offset.
 *
 * An extractor that wants to ignore comments but still report true line numbers needs
 * BLANKING (replace with spaces) rather than stripping, so an index into the result is
 * an index into the original. It also needs to be STRING-AWARE, which is the part a
 * regex cannot do: `app.use('/static/*', …)` is a glob route, not the start of a block
 * comment, and treating it as one silently erases everything up to the next block-comment terminator —
 * typically the file's next JSDoc, and with it the file's entire middleware inventory.
 *
 * So this is a single-pass character scanner, modeled on `stripComments` in
 * duplicate-detector.ts (same string/escape handling, same "unterminated runs to
 * end-of-input" degradation) but writing spaces instead of dropping characters. Being a
 * scanner rather than a regex also makes it linear by construction — no backtracking,
 * no quantifier to bound — where the regex form was quadratic until its own bound.
 *
 * KNOWN LIMIT, shared with the scanner it is modeled on: a regex literal containing
 * `/*` or `//` (e.g. `/ab\/*cd/`) is read as a comment opener. Distinguishing a regex
 * literal from division needs real parser context; the failure mode is over-blanking a
 * rare line, never mis-positioning one.
 */

/**
 * Return `text` with the contents of `//` and block comments replaced by spaces.
 * Newlines are preserved exactly, so `text.length`, every `\n` index, and therefore
 * every derived line number are identical to the input's.
 */
export function blankCommentsPreservingLayout(text: string): string {
  const n = text.length;
  const out = new Array<string>(n);
  let i = 0;

  /** Blank `[from, to)` , keeping newlines where they stand. */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = text[k] === '\n' ? '\n' : ' ';
  };

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    // Line comment: // … end of line (the newline itself is left in place).
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment: /* … */ (unterminated runs to end-of-input).
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      const end = Math.min(n, j + 2); // include the closing */
      blank(i, end);
      i = end;
      continue;
    }

    // String / template literal: copied verbatim, and — the point of the scanner —
    // NOT scanned for comment openers. Escapes are honored so `"\""` does not end early.
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out[i] = c;
      let j = i + 1;
      while (j < n) {
        const cj = text[j];
        if (cj === '\\') {
          out[j] = cj;
          if (j + 1 < n) out[j + 1] = text[j + 1];
          j += 2;
          continue;
        }
        out[j] = cj;
        j++;
        if (cj === q) break; // closing delimiter
      }
      i = j;
      continue;
    }

    out[i] = c;
    i++;
  }

  return out.join('');
}
