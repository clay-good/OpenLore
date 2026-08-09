/**
 * Secret redaction — the single source of truth for scrubbing provider API keys
 * and other credentials out of EVERY server output channel.
 * change: add-secret-redaction-boundary
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

export type SecretKind =
  | 'api-key'
  | 'authorization'
  | 'cloud-credential'
  | 'connection-string'
  | 'jwt'
  | 'private-key'
  | 'secret-field';

export interface RedactionDisclosure {
  count: number;
  kinds: SecretKind[];
}

export interface RedactionResult<T> {
  value: T;
  redactions: RedactionDisclosure;
}

interface SecretPattern {
  pattern: RegExp;
  kind: SecretKind;
  replacement?: string;
}

/** Fixed, deterministic credential patterns, ordered broadest-first to avoid double counting. */
const SECRET_VALUE_PATTERNS: readonly SecretPattern[] = [
  // Consume the ENTIRE header value — scheme plus credential — to end of line/value, so
  // Basic/Digest/any spaced-credential scheme redacts as fully as Bearer. `\S+` would keep
  // only the scheme and leave the credential behind. The Bearer-specific pattern above still
  // covers bare `Bearer <token>` occurrences outside a header context.
  { pattern: /Authorization:[^\n\r]*/gi, kind: 'authorization', replacement: 'Authorization: $MARKER' },
  { pattern: /Bearer\s+\S{10,}/gi, kind: 'authorization', replacement: 'Bearer $MARKER' },
  { pattern: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, kind: 'private-key' },
  { pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/]+:[^\s@/]+@[^\s'"`]+/gi, kind: 'connection-string' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, kind: 'jwt' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, kind: 'cloud-credential' },
  // Provider header forms that carry the raw key. Anthropic sends `x-api-key`, Google
  // sends `x-goog-api-key`; a proxy that echoes the inbound request in its error body
  // puts the header (name and value) verbatim into text we then log.
  { pattern: /x-api-key:[^\n\r]*/gi, kind: 'api-key', replacement: 'x-api-key: $MARKER' },
  { pattern: /x-goog-api-key:[^\n\r]*/gi, kind: 'api-key', replacement: 'x-goog-api-key: $MARKER' },
  {
    pattern: /((?:api[_-]?key|password|passwd|secret|token)["']?\s*[=:]\s*)["']?(?!\[REDACTED(?::[a-z-]+)?\])[^\s'";,]{8,}["']?/gi,
    kind: 'secret-field',
    replacement: '$1$MARKER',
  },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, kind: 'api-key' },
  { pattern: /sk-ant-[A-Za-z0-9\-_]{10,}/g, kind: 'api-key' },
  { pattern: /sk-[A-Za-z0-9\-_]{20,}/g, kind: 'api-key' },
  // Google API keys are self-identifying by prefix, so they can be caught free-standing
  // (e.g. embedded in a URL that has already been reshaped by a proxy).
  { pattern: /AIza[0-9A-Za-z\-_]{35}/g, kind: 'api-key' },
  // Google-style `?key=...` in a provider URL (e.g. Gemini generateContent).
  { pattern: /([?&]key=)[A-Za-z0-9\-_]{8,}/gi, kind: 'api-key', replacement: '$1$MARKER' },
];

function marker(kind: SecretKind, typed: boolean): string {
  return typed ? `[REDACTED:${kind}]` : '[REDACTED]';
}

function redactStringWithReport(s: string, typed: boolean): RedactionResult<string> {
  let value = s;
  let count = 0;
  const kinds = new Set<SecretKind>();
  for (const { pattern, kind, replacement } of SECRET_VALUE_PATTERNS) {
    value = value.replace(pattern, (...args: unknown[]) => {
      count++;
      kinds.add(kind);
      const replacementText = replacement ?? '$MARKER';
      const groups = args.slice(1, -2) as string[];
      return replacementText
        .replace('$MARKER', marker(kind, typed))
        .replace(/\$(\d+)/g, (_match, index: string) => groups[Number(index) - 1] ?? '');
    });
  }
  return { value, redactions: { count, kinds: [...kinds].sort() } };
}

/** Redact credential-shaped substrings from a single string. */
export function redactSecretString(s: string): string {
  return redactStringWithReport(s, false).value;
}

/** Redact credential-shaped spans and return a typed, deterministic disclosure receipt. */
export function redactSecretText(s: string): RedactionResult<string> {
  return redactStringWithReport(s, true);
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

/**
 * Deep-redact a structured value while counting every replaced span. This is used at
 * disclosure-bearing boundaries; the compatibility `redactSecrets` API above intentionally
 * retains its historical untyped marker and return shape for telemetry and error callers.
 */
export function redactSecretsWithReport<T>(value: T, typed = true): RedactionResult<T> {
  const seen = new WeakMap<object, unknown>();
  const kinds = new Set<SecretKind>();
  let count = 0;

  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      const result = redactStringWithReport(current, typed);
      count += result.redactions.count;
      for (const kind of result.redactions.kinds) kinds.add(kind);
      return result.value;
    }
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return seen.get(current);

    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      seen.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }

    const copy: Record<string, unknown> = {};
    seen.set(current, copy);
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (typeof child === 'string' && SECRET_KEY_NAME.test(key)) {
        copy[key] = marker('secret-field', typed);
        count++;
        kinds.add('secret-field');
      } else {
        copy[key] = visit(child);
      }
    }
    return copy;
  };

  return {
    value: visit(value) as T,
    redactions: { count, kinds: [...kinds].sort() },
  };
}
