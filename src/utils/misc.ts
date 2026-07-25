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
 * The backslash must be escaped BEFORE the quote, or a trailing `\` in the input
 * escapes the closing `"` that follows it and corrupts the rest of the document.
 * Escaping only quotes (the obvious-looking fix) leaves exactly that hole.
 */
export function escapeDotString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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