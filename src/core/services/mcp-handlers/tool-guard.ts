/**
 * MCP tool response hardening (spec-10).
 *
 * A single set of guards every tool runs through in the CallTool handler, so the
 * whole surface has one uniform input-validation, timeout, output-cap, and
 * error-normalization path:
 *
 *   - Input validation BEFORE the handler runs, against the tool's own declared
 *     `inputSchema` (reusing the hand-written JSON-Schema-subset validator from
 *     spec-05 — no Ajv). Invalid args map to JSON-RPC -32602 (spec-12).
 *   - Per-tool timeout via Promise.race, with slow tools overridden.
 *   - Output size cap: oversized results are truncated DETERMINISTICALLY with a
 *     `truncated: true` note telling the agent how to narrow the query — never a
 *     silent drop.
 *   - Error normalization to a stable code taxonomy, distinguishing "repo not
 *     analyzed yet" (actionable) from real failures.
 */

import { validateAgainstSchema } from '../../../cli/manifest/schema-validator.js';
import { MCP_TOOL_TIMEOUT_MS, MCP_TOOL_TIMEOUT_OVERRIDES } from '../../../constants.js';
import { suggestKey } from '../config-schema.js';

/** Stable MCP tool error-code taxonomy. */
export type McpToolErrorCode = 'INVALID_ARGS' | 'NOT_ANALYZED' | 'TIMEOUT' | 'OUTPUT_TRUNCATED' | 'INTERNAL';

const MAX_UNKNOWN_KEY_DISPLAY = 80;
const MAX_SUGGESTION_KEY_LENGTH = 128;

/** Reject the first unknown own property with a bounded, deterministic hint. */
export function validateKnownProperties(value: unknown, knownKeys: readonly string[]): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const known = new Set(knownKeys);
  const key = Object.keys(value as Record<string, unknown>).find(candidate => !known.has(candidate));
  if (key === undefined) return null;
  const shown = key.length <= MAX_UNKNOWN_KEY_DISPLAY
    ? key
    : `${key.slice(0, MAX_UNKNOWN_KEY_DISPLAY - 1)}…`;
  const suggestion = key.length <= MAX_SUGGESTION_KEY_LENGTH
    ? suggestKey(key, knownKeys)
    : undefined;
  return suggestion
    ? `unknown property "${shown}"; did you mean "${suggestion}"?`
    : `unknown property "${shown}"`;
}

function schemaAtPath(schema: Record<string, unknown>, path: string): Record<string, unknown> {
  let current = schema;
  for (const rawSegment of path.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    const next = /^\d+$/.test(segment)
      ? current.items
      : (current.properties as Record<string, unknown> | undefined)?.[segment];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return {};
    current = next as Record<string, unknown>;
  }
  return current;
}

/**
 * Validate args against a tool's inputSchema. Returns a human-readable message on
 * failure, or null when valid (or when no schema is declared).
 */
export function validateToolArgs(args: unknown, inputSchema: unknown): string | null {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  const schema = inputSchema as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};

  const unknownError = validateKnownProperties(args, Object.keys(properties));
  if (unknownError) return unknownError;

  const errors = validateAgainstSchema(args ?? {}, schema);
  if (errors.length === 0) return null;
  return errors.map(error => {
    if (error.path && error.message === 'missing required property') {
      const propertySchema = schemaAtPath(schema, error.path);
      const expected = Array.isArray(propertySchema.type)
        ? propertySchema.type.join('|')
        : typeof propertySchema.type === 'string' ? propertySchema.type : 'value';
      const example = Array.isArray(propertySchema.enum) && propertySchema.enum.length > 0
        ? propertySchema.enum[0]
        : expected.includes('string') ? 'example'
          : expected.includes('number') || expected.includes('integer') ? 1
            : expected.includes('boolean') ? true
              : expected.includes('array') ? [] : {};
      return `${error.path}: missing required property; expected type ${expected}; example: ${JSON.stringify(example)}`;
    }
    return error.path ? `${error.path}: ${error.message}` : error.message;
  }).join('; ');
}

/** Thrown when a tool exceeds its timeout — classified as TIMEOUT downstream. */
export class ToolTimeoutError extends Error {
  constructor(public readonly toolName: string, public readonly ms: number) {
    super(`Tool "${toolName}" exceeded its ${ms}ms timeout. Narrow the query or run analyze_codebase first.`);
    this.name = 'ToolTimeoutError';
  }
}

/** The timeout budget for a tool (per-tool override or the default). */
export function toolTimeoutMs(toolName: string): number {
  return MCP_TOOL_TIMEOUT_OVERRIDES[toolName] ?? MCP_TOOL_TIMEOUT_MS;
}

/** Race a tool's work against its timeout. Rejects with ToolTimeoutError on expiry. */
export function withToolTimeout<T>(work: Promise<T>, toolName: string, msOverride?: number): Promise<T> {
  const ms = msOverride ?? toolTimeoutMs(toolName);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(toolName, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Deterministically cap a result string to a byte budget. When over budget, cut on
 * a UTF-8-safe boundary and append a note explaining how to narrow the query.
 */
export function capOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const note =
    '\n\n…[output truncated — exceeded the response byte budget. Narrow the query: add a filePattern, ' +
    'lower a limit/maxDepth/maxResults, or query a specific symbol/file.]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8'));
  let slice = text.slice(0, budget);
  while (slice.length > 0 && Buffer.byteLength(slice, 'utf8') > budget) slice = slice.slice(0, -1);
  return { text: slice + note, truncated: true };
}

/** Largest n (0..len) for which pred(n) holds, found by binary search. pred must be monotone. */
function largestFitting(len: number, pred: (n: number) => boolean): number {
  let lo = 0, hi = len, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * Cap a tool RESULT to a byte budget while keeping it parseable.
 *
 * Tool results are serialized to JSON before being sent to the agent. Naively
 * byte-truncating that JSON (what capOutput does to a raw string) cuts mid-string-
 * literal and yields UNPARSEABLE JSON — the agent can't use any of it (this is how
 * get_spec on a >256 KB spec broke). Instead:
 *   - string results (raw-text tools) → capOutput, unchanged;
 *   - object results → re-serialize with the single largest top-level string field
 *     truncated to fit (shape preserved, valid JSON, marked `truncated: true`);
 *   - anything else over budget → a valid JSON envelope wrapping the partial.
 * Binary search keeps the result within the byte budget despite JSON-escaping overhead.
 */
export function capStructuredResult(result: unknown, maxBytes: number): { text: string; truncated: boolean } {
  if (typeof result === 'string') return capOutput(result, maxBytes);

  const full = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return { text: full, truncated: false };

  // Truncate the dominant top-level string field and re-serialize — keeps the shape.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    let key: string | null = null;
    let keyLen = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > keyLen) { keyLen = v.length; key = k; }
    }
    if (key) {
      const field = obj[key] as string;
      const marker = '\n\n…[truncated — this field exceeded the response byte budget; narrow the query]';
      const within = (n: number): boolean =>
        Buffer.byteLength(JSON.stringify({ ...obj, [key!]: field.slice(0, n) + marker, truncated: true }, null, 2), 'utf8') <= maxBytes;
      const best = largestFitting(field.length, within);
      const capped = { ...obj, [key]: field.slice(0, best) + marker, truncated: true };
      const text = JSON.stringify(capped, null, 2);
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: true };
    }
  }

  // Fallback (arrays / no dominant string field): a valid JSON envelope around the partial.
  const note =
    'output exceeded the response byte budget; narrow the query (add a filePattern, lower a ' +
    'limit/maxDepth/maxResults, or query a specific symbol/file).';
  const redactions = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).redactions
    : undefined;
  const indexStaleness = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).indexStaleness
    : undefined;
  const truncatedAtDepth = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).truncatedAtDepth
    : undefined;
  const soundness = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).soundness
    : undefined;
  let preservedIndexStaleness = indexStaleness;
  const envelopeWith = (partial: string, staleness: unknown): Record<string, unknown> => ({
    truncated: true,
    note,
    ...(redactions === undefined ? {} : { redactions }),
    ...(staleness === undefined ? {} : { indexStaleness: staleness }),
    ...(truncatedAtDepth === undefined ? {} : { truncatedAtDepth }),
    ...(soundness === undefined ? {} : { soundness }),
    partial,
  });

  // An untrusted artifact can cite many very long paths. Keeping that machine
  // list verbatim would make the "capped" envelope itself exceed maxBytes even
  // with an empty partial. Compact only when necessary, retaining the factual
  // boundary, count, one bounded example, and repair status.
  if (
    indexStaleness !== undefined
    && Buffer.byteLength(JSON.stringify(envelopeWith('', indexStaleness), null, 2), 'utf8') > maxBytes
  ) {
    const stale = indexStaleness && typeof indexStaleness === 'object' && !Array.isArray(indexStaleness)
      ? indexStaleness as Record<string, unknown>
      : {};
    const files = Array.isArray(stale.staleFiles)
      ? stale.staleFiles.filter((file): file is string => typeof file === 'string')
      : [];
    const first = files[0]?.slice(0, 256);
    preservedIndexStaleness = {
      staleFiles: first ? [first] : [],
      staleFileCount: files.length,
      ...(files.length > (first ? 1 : 0) ? { staleFilesOmitted: files.length - (first ? 1 : 0) } : {}),
      note: 'The index is behind the working tree; results may omit recent edits. Stale-file details were bounded to fit the response.',
      ...(stale.repairScheduled === true ? { repairScheduled: true } : {}),
      ...(stale.uncheckedCitations === true ? { uncheckedCitations: true } : {}),
    };
  }
  const envelope = (partial: string): Record<string, unknown> => ({
    // Freshness is a mandatory factual boundary, not optional detail. Preserve
    // a bounded form even when the structured payload falls back to a
    // truncation envelope (change: disclose-stale-serving-on-cold-reads).
    ...envelopeWith(partial, preservedIndexStaleness),
  });
  const best = largestFitting(full.length, (n) =>
    Buffer.byteLength(JSON.stringify(envelope(full.slice(0, n)), null, 2), 'utf8') <= maxBytes);
  return { text: JSON.stringify(envelope(full.slice(0, best)), null, 2), truncated: true };
}

/** Map an error to the stable taxonomy code (actionable vs real failure). */
export function classifyToolError(err: unknown): McpToolErrorCode {
  if (err instanceof ToolTimeoutError) return 'TIMEOUT';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/no analysis found|run analyze_codebase|not available.*re-run|re-run analyze_codebase|call graph (db )?not available/.test(msg)) {
    return 'NOT_ANALYZED';
  }
  return 'INTERNAL';
}
