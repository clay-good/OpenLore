/**
 * HTML inline-script extractor.
 *
 * Produces an "offset-preserving blank" of an HTML file: a string of the SAME
 * length as the input in which every character outside an inline `<script>` body
 * is replaced by a space (newlines preserved), and the inline JavaScript bodies
 * are kept verbatim at their exact positions.
 *
 * Feeding this blanked string to the existing JavaScript call-graph extractor
 * makes tree-sitter parse only the script islands, at their true offsets, so the
 * resulting nodes' start/end offsets and line numbers map back to the HTML file
 * without the extractor needing any HTML awareness (decision 5b38bad2).
 *
 * Only inline scripts that are JavaScript are kept: `text/javascript`,
 * `application/javascript`, `module`, ecmascript, or no `type`. `application/json`,
 * `importmap`, templating types, and external (`src=`) scripts are blanked out.
 *
 * Parsing is a linear open-tag scan plus an `indexOf` for the close tag — NOT a
 * single backtracking regex — so a file full of unterminated `<script` tags
 * cannot drive the matcher into quadratic blow-up (the previous combined regex
 * scanned to EOF per open tag → O(N²) on malformed input).
 */

// Matches just the OPENING `<script ...>` tag. `[^>]*` stops at the first `>`,
// which is a known limitation when an attribute value itself contains `>`
// (rare; documented). Case-insensitive, global.
const OPEN_SCRIPT_RE = /<script\b([^>]*)>/gi;
const CLOSE_TAG = '</script';

/** JS `type` values (besides "no type") that we treat as executable JavaScript. */
const JS_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'module',
  'text/ecmascript',
  'application/ecmascript',
]);

/** True if a `<script>`'s attribute string denotes inline JavaScript we should index. */
export function isInlineJsScript(attrs: string): boolean {
  // External scripts have no inline body. Anchor the attribute name on the left
  // (start-or-whitespace) so `data-src` / `data-type` don't false-match.
  if (/(?:^|\s)src\s*=/i.test(attrs)) return false;
  const typeMatch = /(?:^|\s)type\s*=\s*["']?\s*([^"'\s>]+)/i.exec(attrs);
  if (!typeMatch) return true; // no type → classic inline JS
  let type = typeMatch[1].toLowerCase();
  const semi = type.indexOf(';'); // strip a `; charset=…` suffix
  if (semi !== -1) type = type.slice(0, semi);
  return JS_TYPES.has(type);
}

/**
 * Return an offset-preserving blank of `content` exposing only inline JS bodies,
 * or `null` when the file contains no qualifying inline script (so callers can
 * skip it cheaply).
 *
 * The returned string has the same length as `content`; every position outside a
 * kept script body is a space, except `\n` which is preserved so line numbers
 * align with the original file.
 */
export function extractHtmlScripts(content: string): string | null {
  // Base: same length, all spaces, newlines preserved.
  const out = content.replace(/[^\n]/g, ' ').split('');
  const lower = content.toLowerCase(); // one pass; case-insensitive close-tag search
  let found = false;

  OPEN_SCRIPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_SCRIPT_RE.exec(content)) !== null) {
    const attrs = m[1];
    const bodyStart = m.index + m[0].length;

    // Linear search for the matching close tag — no regex backtracking.
    const closeIdx = lower.indexOf(CLOSE_TAG, bodyStart);
    if (closeIdx === -1) {
      // No close tag from here to EOF. `bodyStart` only increases across iterations,
      // so no LATER open tag can have a close tag either — stop. (A `continue` here
      // re-scans to EOF for every remaining open tag → O(N²) on a file full of
      // unterminated `<script` tags; `break` keeps the whole pass O(N).)
      break;
    }

    if (closeIdx > bodyStart && isInlineJsScript(attrs)) {
      for (let i = bodyStart; i < closeIdx; i++) out[i] = content[i];
      found = true;
    }

    // Resume after the close tag so a `<script` appearing inside one body is not
    // re-matched, and so lastIndex advances monotonically.
    OPEN_SCRIPT_RE.lastIndex = closeIdx + CLOSE_TAG.length;
  }

  return found ? out.join('') : null;
}
