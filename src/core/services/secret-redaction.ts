/**
 * Secret redaction — the single source of truth for scrubbing provider API keys
 * and other credentials out of EVERY server output channel.
 *
 * mcp-security "Secret Confinement Across All Output Paths" requires that a key
 * read for an LLM call never appears in a tool result, telemetry event, log line,
 * or written artifact — extending mcp-quality's error-text sanitization to all
 * channels. This module backs both `sanitizeMcpError` (error text) and the deep
 * `redactSecrets` walker used on structured payloads (telemetry, echoed config).
 *
 * Kept dependency-free so any layer (utils, telemetry, logger) can import it
 * without an import cycle.
 */

/**
 * Object KEY names whose string value is a secret and must be replaced wholesale.
 * Matches the name as a whole token, with optional prefixes/suffixes joined by
 * `-`/`_`/`.` (e.g. `anthropicApiKey`, `x-openlore-token`, `client_secret`).
 */
const SECRET_KEY_NAME =
  /(^|[._-])(api[._-]?key|apikey|token|secret|password|passwd|authorization|credential|client[._-]?secret|access[._-]?key|private[._-]?key|session[._-]?key)([._-]|$)/i;

/** Substring patterns that look like a credential VALUE wherever they appear in text. */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9\-_]{10,}/g, '[REDACTED]'],
  [/sk-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]'],
  [/Bearer\s+\S{10,}/g, 'Bearer [REDACTED]'],
  // Consume the ENTIRE header value — scheme plus credential — to end of line/value, so
  // Basic/Digest/any spaced-credential scheme redacts as fully as Bearer. `\S+` would keep
  // only the scheme and leave the credential behind. The Bearer-specific pattern above still
  // covers bare `Bearer <token>` occurrences outside a header context.
  [/Authorization:[^\n\r]*/gi, 'Authorization: [REDACTED]'],
  [/api[_-]?key["']?\s*[=:]\s*["']?\S{8,}/gi, 'api_key=[REDACTED]'],
  // Provider header forms that carry the raw key. Anthropic sends `x-api-key`, Google
  // sends `x-goog-api-key`; a proxy that echoes the inbound request in its error body
  // puts the header (name and value) verbatim into text we then log.
  [/x-api-key:[^\n\r]*/gi, 'x-api-key: [REDACTED]'],
  [/x-goog-api-key:[^\n\r]*/gi, 'x-goog-api-key: [REDACTED]'],
  // Google API keys are self-identifying by prefix, so they can be caught free-standing
  // (e.g. embedded in a URL that has already been reshaped by a proxy).
  [/AIza[0-9A-Za-z\-_]{35}/g, '[REDACTED]'],
  // Google-style `?key=...` in a provider URL (e.g. Gemini generateContent).
  [/([?&]key=)[A-Za-z0-9\-_]{8,}/gi, '$1[REDACTED]'],
];

/** Redact credential-shaped substrings from a single string. */
export function redactSecretString(s: string): string {
  let out = s;
  for (const [re, replacement] of SECRET_VALUE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Deep-redact a value before it leaves the server on a non-error channel:
 * - strings → credential-shaped substrings replaced;
 * - object fields whose KEY name denotes a secret → value replaced with `[REDACTED]`;
 * - arrays/objects → walked recursively.
 * Returns a redacted copy; the input is not mutated. Cycle-safe: a back-reference resolves
 * to the already-created redacted twin of the visited node, never to the original — so the
 * output graph never embeds an un-scrubbed subtree.
 */
export function redactSecrets<T>(value: T, _seen?: WeakMap<object, unknown>): T {
  if (typeof value === 'string') return redactSecretString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  // original → redacted twin, registered BEFORE recursing so a cycle closing on this node
  // resolves to the (in-progress) redacted copy, not the unredacted original.
  const seen = _seen ?? new WeakMap<object, unknown>();
  if (seen.has(value as object)) return seen.get(value as object) as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value as object, copy);
    for (const v of value) copy.push(redactSecrets(v, seen));
    return copy as unknown as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && SECRET_KEY_NAME.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSecrets(v, seen);
    }
  }
  return out as T;
}
