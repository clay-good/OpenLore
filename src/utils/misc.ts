/**
 * Miscellaneous utilities
 * Shared helpers that don't belong in other specific modules.
 */

/**
 * Escape a string for literal use inside a `RegExp`.
 *
 * Needed wherever a caller-supplied identifier is interpolated into a pattern: an
 * unescaped `.` or `(` silently changes what the pattern matches, and a crafted
 * value can produce catastrophic backtracking. Callers are not always trusted —
 * MCP tool arguments reach some of these paths.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Quote a value for use inside a double-quoted Graphviz DOT string.
 *
 * Three things have to happen, in this order:
 *
 *  1. `\` first. Escaping quotes first would leave a trailing `\` escaping the
 *     closing `"` that follows it, swallowing the rest of the document.
 *  2. `"`, so the value cannot terminate its own string.
 *  3. Control characters. The emitter is line-oriented (statements are joined with
 *     `\n`), and a file name may legally contain a newline on Linux and macOS — so
 *     an unescaped one splits the statement in two and the tail is parsed as new
 *     DOT. Escaping quotes alone does not prevent that, which is why this is done
 *     here rather than left to the caller.
 *
 * Newline/CR/tab become their DOT escape sequences (the backslash is emitted after
 * step 1, so it stays a real escape). Any other control character has no DOT
 * representation and is dropped; two names differing only by such a character would
 * collide, which is accepted as strictly better than emitting a corrupt graph.
 */
export function escapeDotString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex -- deliberately matching C0/C7F controls
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Neutralize terminal control sequences in a value that came from an analyzed
 * repository, before it is printed.
 *
 * OpenLore's job is to read repositories it does not trust and report on them, and
 * SECURITY.md scopes exactly that. A file name may legally contain ESC on Linux and
 * macOS, so a hostile repository can smuggle cursor-movement, screen-clear or OSC
 * sequences through any path/symbol OpenLore echoes back. Printed raw, those let the
 * repository being analyzed overwrite OpenLore's own output — for a tool whose value
 * is a trustworthy verdict, a forged "[ok] all checks passed" line is the attack,
 * not a cosmetic glitch.
 *
 * Everything in C0, DEL and C1 is removed, which includes ESC and therefore every
 * sequence introduced by it (CSI, OSC, DCS) without needing to parse them. Newline
 * and tab go too: these are single-line display values (a path, a symbol name), so a
 * newline in one is itself a way to forge an extra output line.
 *
 * Four classes of NON-C0 Unicode formatting characters go with them, because C0 alone
 * is not the whole attack surface:
 *   - bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069) and the marks
 *     U+061C / U+200E / U+200F reverse rendered text, so a decision title or symbol
 *     name can display as the opposite of the bytes OpenLore actually verified;
 *   - the line/paragraph separators U+2028 / U+2029 start a new line in many
 *     terminals and editors — the same forged-extra-line attack as `\n`;
 *   - the zero-width characters U+200B-U+200D, the word joiner U+2060 and U+FEFF are
 *     invisible: they let two different symbol names, paths or decision titles render
 *     identically, so a report can name one thing while OpenLore verified another.
 * These also matter on the MCP/JSON path, which C0 stripping does not need to cover:
 * `JSON.stringify` escapes control characters to `\uXXXX` but passes every one of
 * these through verbatim. This is the same class `sanitizeReviewValue` neutralizes
 * before repository text reaches a PR comment; keep the two in step.
 *
 * The WHOLE escape sequence goes, not just its ESC introducer (see
 * {@link stripTerminalEscapeSequences}). Dropping ESC alone left `[31mIGNORE…`: harmless
 * to a terminal, but it reads as prose to a model AND welds the leftover `m` onto the
 * next word, which is exactly how an escape prefix walked past the instruction-shape
 * screen in `served-content.ts`. A screen that runs after sanitizing must see the text
 * the model will see, with nothing stuck to it.
 *
 * This is for UNTRUSTED values only. OpenLore's own color codes are applied by the
 * shared color layer AFTER this runs, so they are unaffected.
 */
export function sanitizeForTerminal(
  value: string,
  opts: { keepNewlines?: boolean } = {},
): string {
  // Two shapes, because the caller knows what it is holding:
  //   - a single VALUE (a path, a symbol name): a newline in it is itself a way to
  //     forge an extra output line, so it goes too. This is the default.
  //   - an assembled MESSAGE built from an OpenLore-authored template: its newlines
  //     are the template's own formatting, so they are kept. ESC is removed either
  //     way, which is what blocks the cursor/screen/OSC attacks.
  const pattern = opts.keepNewlines
    // eslint-disable-next-line no-control-regex -- C0 except \n, plus DEL, C1, bidi, separators, zero-width
    ? /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g
    // eslint-disable-next-line no-control-regex -- all of C0, plus DEL, C1, bidi, separators, zero-width
    : /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g;
  return stripTerminalEscapeSequences(value).replace(pattern, '');
}

/**
 * Remove complete terminal escape sequences — introducer AND payload — from an
 * untrusted value. The companion of {@link sanitizeForTerminal}, which calls it first.
 *
 * Why not just "remove ESC": the payload that survives (`[2J`, `[31m`, an OSC string)
 * is both visual noise and an evasion. Removing the whole sequence restores the word
 * boundary a downstream lexical screen needs, instead of leaving `m` glued to the next
 * word.
 *
 * Deliberately simple and strictly LINEAR: one alternation of flat character classes,
 * each with a single unnested quantifier, so hostile input has no path to catastrophic
 * backtracking (this repository has closed three quadratic ReDoS defects). Only
 * ESC-introduced sequences match, so a literal `[31m` in a legitimate file name is left
 * exactly as it is. Anything ESC-introduced that this does not recognize still loses its
 * ESC to the C0 class in {@link sanitizeForTerminal}, so no escape reaches a terminal.
 */
export function stripTerminalEscapeSequences(value: string): string {
  // The overwhelmingly common case is a value with no ESC at all.
  if (!value.includes('\x1b')) return value;
  return value.replace(
    // CSI (`ESC [` params intermediates final), the string-introducer families
    // (OSC/DCS/SOS/PM/APC, terminated by BEL or ST), a two-byte `ESC <intermediate> <final>`
    // escape — in that order, longest first. A bare `ESC <letter>` is NOT matched: there the
    // ESC alone goes (to the C0 class) and the letter is kept, because deleting a byte of a
    // name is a loss and a lone ESC cannot drive a terminal. The string payload is BOUNDED:
    // an unterminated OSC must not swallow the rest of the value.
    // eslint-disable-next-line no-control-regex -- ESC-introduced sequences are the subject
    /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|[\]PX^_][^\x07\x1b]{0,1024}(?:\x07|\x1b\\)?|[\x20-\x2f][\x30-\x7e]?)?/g,
    '',
  );
}

/**
 * JSON for an agent or a wrapper to parse, screened at the VALUES rather than at the
 * serialized document.
 *
 * Screening the finished document is not enough on this face: `JSON.stringify` turns a real
 * ESC into the six characters `\\u001b`, so there is no ESC byte left for a text pass to
 * remove — and the consumer that parses the document gets the control character BACK. A
 * replacer screens each string before it is escaped, so what a consumer parses is inert.
 *
 * KNOWN LIMIT, named rather than implied away: object KEYS are not screened here (a replacer
 * cannot rewrite them). Bidi and zero-width characters in a key are removed by the text pass
 * in `writeStdout`/`sendJson`; a C0 control in a key survives as its `\\uXXXX` escape. OpenLore
 * authors its own keys; the only repository-derived keys are paths and symbol names in map-shaped
 * payloads, and there the value beside the key carries the same text screened.
 */
export function stringifyScreened(value: unknown, indent?: number): string {
  return JSON.stringify(value, screenJsonString, indent);
}

function screenJsonString(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? sanitizeForTerminal(value, { keepNewlines: true }) : value;
}

/**
 * The same screening applied to a value that is about to be re-serialized by someone else
 * (the MCP response capper re-serializes with its own truncation), so the screening cannot be
 * undone downstream. A round trip, because that is exactly the transform the value is headed
 * for: anything `JSON.stringify` would drop is already absent from the output.
 */
export function screenJsonValue<T>(value: T): T {
  const json = stringifyScreened(value);
  return json === undefined ? value : (JSON.parse(json) as T);
}

/** {@link stringifyScreened} over an already-serialized document; non-JSON text falls back to the text pass. */
export function screenJsonText(json: string): string {
  try {
    return stringifyScreened(JSON.parse(json) as unknown);
  } catch {
    return sanitizeForTerminal(json, { keepNewlines: true });
  }
}

/**
 * Keys that must never be written through a caller-supplied path, because
 * assigning them mutates the prototype chain rather than the target object.
 */
const PROTO_POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when a path segment would escape the target object into its prototype. */
export function isProtoPollutingKey(key: string): boolean {
  return PROTO_POLLUTING_KEYS.has(key);
}

/**
 * Parse JSON from LLM output, handling markdown code fences.
 * Strips ``` fences, extracts JSON array or object, returns fallback on failure.
 */
export function parseJSON<T>(text: string, fallback: T): T {
  const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
  const match = stripped.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}