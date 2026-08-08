/**
 * Streaming, atomic JSON artifact writer (change: bulletproof-background-index).
 *
 * `JSON.stringify` must materialize its entire result as one JavaScript string, and V8 caps a
 * string at 536,870,888 characters. Past that it throws `RangeError: Invalid string length` — a
 * hard ceiling, not memory pressure, so a bigger `--max-old-space-size` cannot move it.
 *
 * Analyze wrote its two whole-repository artifacts (`llm-context.json`, `dependency-graph.json`)
 * with an unguarded `JSON.stringify`, and the throw propagates to analyze's top-level catch. The
 * user-visible result on a large repository is the worst possible shape: every file parsed, every
 * pass run — potentially hours — and then `[error] Analysis failed: Invalid string length`, exit 1,
 * nothing written, and a message that names neither the cause nor a remedy.
 *
 * How close is real code? Measured on OpenLore's own source, `llm-context.json` is ~3,842
 * characters per indexed function, which puts the ceiling at roughly 140,000 functions.
 * microsoft/TypeScript indexes 152,046. This is reachable by ordinary large repositories, and the
 * amplification is per-symbol rather than per-byte, so a function-dense repository gets there well
 * below TypeScript's size on disk.
 *
 * This writer emits the same bytes without ever holding them all at once, and returns the SHA-256
 * of what it wrote so a caller can fingerprint the artifact without re-reading it.
 *
 * The output is byte-identical to `JSON.stringify(value, null, 2)`. That is load-bearing for
 * artifact reproducibility: two analyze runs over the same inputs must produce byte-identical
 * output (see the determinism e2e), so a single differing space would break that guarantee. It
 * comes from delegating: any subtree the writer
 * chooses not to split is serialized by `JSON.stringify` itself and re-indented, so every leaf rule
 * — `toJSON`, omitted `undefined` object values, `null` for `undefined` array holes, `NaN` as
 * `null`, key escaping — is inherited rather than reimplemented. Which subtrees get split is purely
 * a memory decision and cannot affect the output; `json-stream.test.ts` checks that against
 * `JSON.stringify` directly, including at a split threshold low enough to split nearly everything.
 */
import { createHash } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/**
 * Buffered bytes before a write is issued. Bounds transient memory without paying a syscall per
 * fragment.
 */
const FLUSH_BYTES = 4 * 1024 * 1024;

/**
 * The buffer is measured in UTF-16 code units but encoded as UTF-8 at each flush, so a flush that
 * landed between a surrogate pair would emit two replacement characters and corrupt the artifact.
 * It cannot: the buffer is only ever flushed after a whole chunk has been appended, and every chunk
 * is a complete token or a complete `JSON.stringify` result. A chunk boundary is therefore always a
 * valid string boundary. Anything that starts flushing mid-chunk must encode incrementally instead.
 */

/**
 * Split arrays longer than this, and objects, rather than inlining them.
 *
 * Only a memory knob: a subtree that is split and one that is inlined produce identical bytes, so
 * this value cannot change an artifact. It exists so a small fixture can exercise the split path.
 */
let SPLIT_MIN_ARRAY_ITEMS = 32;

/** Test-only: force splitting at a small size so a fixture exercises it. Returns the previous. */
export function _setSplitMinArrayItemsForTesting(n: number): number {
  const previous = SPLIT_MIN_ARRAY_ITEMS;
  SPLIT_MIN_ARRAY_ITEMS = n;
  return previous;
}

/** How deep to keep splitting containers. Below this, subtrees are inlined whole. */
const MAX_SPLIT_DEPTH = 3;

function isPlainContainer(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A value `JSON.stringify` drops: omitted entirely as an object value, rendered `null` in an array.
 */
function isDropped(v: unknown): boolean {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

/**
 * Apply `toJSON` once, as `JSON.stringify` does before deciding anything about a value.
 *
 * The distinction matters for the drop rules: `{ x: { toJSON: () => undefined } }` serializes to
 * `{}`, not `{ "x": null }`. Testing the raw value would keep the key and emit `null` — which is
 * what a first draft did, caught by the oracle.
 */
function resolveToJSON(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return (v as { toJSON: () => unknown }).toJSON();
  }
  return v;
}

/** Re-indent a `JSON.stringify(x, null, 2)` result so it sits at `depth`. */
function reindent(json: string, depth: number): string {
  if (depth === 0) return json;
  const pad = '  '.repeat(depth);
  // Only lines AFTER the first: the first is already positioned by the caller.
  return json.replace(/\n/g, `\n${pad}`);
}

/**
 * Should this value be split rather than inlined? Memory-only; see {@link SPLIT_MIN_ARRAY_ITEMS}.
 */
function shouldSplit(v: unknown, depth: number): boolean {
  if (depth >= MAX_SPLIT_DEPTH) return false;
  if (Array.isArray(v)) return v.length >= SPLIT_MIN_ARRAY_ITEMS;
  return isPlainContainer(v) && Object.keys(v).length > 0;
}

/**
 * Yield the fragments of `JSON.stringify(value, null, 2)`.
 *
 * Honors `toJSON` before inspecting a value, exactly as `JSON.stringify` does, so a value that
 * presents itself as something else is split (or not) on what it actually serializes to.
 */
function* emit(value: unknown, depth: number): Generator<string> {
  const v = resolveToJSON(value);

  if (!shouldSplit(v, depth)) {
    // Delegated: every leaf rule comes from `JSON.stringify` itself.
    const inlined = JSON.stringify(v, null, 2);
    yield inlined === undefined ? 'null' : reindent(inlined, depth);
    return;
  }

  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);

  if (Array.isArray(v)) {
    yield '[\n';
    for (let i = 0; i < v.length; i++) {
      yield inner;
      // An array hole or dropped value renders as `null`, never omitted — positions must be
      // preserved. No special case is needed: `JSON.stringify` returns `undefined` for such a
      // value, which `emit` already turns into `null`. An explicit check here was dead code, and a
      // mutation removing it changed nothing.
      yield* emit(v[i], depth + 1);
      yield i < v.length - 1 ? ',\n' : '\n';
    }
    yield `${pad}]`;
    return;
  }

  const obj = v as Record<string, unknown>;
  // Dropped values are omitted entirely, so the surviving keys decide where commas go.
  const keys = Object.keys(obj).filter(k => !isDropped(resolveToJSON(obj[k])));
  if (keys.length === 0) { yield '{}'; return; }
  yield '{\n';
  for (let i = 0; i < keys.length; i++) {
    yield `${inner}${JSON.stringify(keys[i])}: `;
    yield* emit(obj[keys[i]], depth + 1);
    yield i < keys.length - 1 ? ',\n' : '\n';
  }
  yield `${pad}}`;
}

/**
 * Produce the same string `JSON.stringify(value, null, 2)` would.
 *
 * Only for tests and small values — it defeats the entire purpose on a large one. The streaming
 * writer is {@link writeJsonAtomicStreaming}.
 */
export function stringifyStreamingForTesting(value: unknown): string {
  let out = '';
  for (const chunk of emit(value, 0)) out += chunk;
  return out;
}

/**
 * Write `value` as pretty-printed JSON to `path`, atomically, without ever materializing the whole
 * string; return the SHA-256 hex digest of the bytes written.
 *
 * Atomicity matches `atomicWriteFile`: a sibling temp file, fsync'd, then renamed into place, so a
 * crash leaves the previously committed artifact untouched rather than a truncated one. The digest
 * is computed over the same bytes as they stream past, so a caller that must stamp another artifact
 * with it (the traversal index) never needs the string either.
 */
export async function writeJsonAtomicStreaming(path: string, value: unknown): Promise<string> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${_counter++}`);
  const hash = createHash('sha256');
  let renamed = false;

  try {
    const fh = await open(tmp, 'w');
    try {
      let buffer = '';
      for (const chunk of emit(value, 0)) {
        buffer += chunk;
        if (buffer.length >= FLUSH_BYTES) {
          const bytes = Buffer.from(buffer, 'utf-8');
          hash.update(bytes);
          await fh.write(bytes);
          buffer = '';
        }
      }
      if (buffer.length > 0) {
        const bytes = Buffer.from(buffer, 'utf-8');
        hash.update(bytes);
        await fh.write(bytes);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tmp).catch(() => { /* nothing to clean up */ });
  }

  try {
    const dh = await open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync unsupported — the data fsync above already bounds the loss */ }

  return hash.digest('hex');
}

let _counter = 0;
