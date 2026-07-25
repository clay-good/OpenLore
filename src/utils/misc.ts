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
    // eslint-disable-next-line no-control-regex -- C0 except \n, plus DEL and C1
    ? /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g
    // eslint-disable-next-line no-control-regex -- all of C0, plus DEL and C1
    : /[\x00-\x1f\x7f-\x9f]/g;
  return value.replace(pattern, '');
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