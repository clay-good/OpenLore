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