/**
 * Portable graph artifact — export/import codec (change: add-shareable-graph-artifact).
 *
 * The persisted graph index is a deterministic function of the committed source, so for a
 * given commit every machine computes the *same* index. Re-indexing it on every teammate's
 * machine and on every CI run is redundant work that scales with team size. This module
 * makes the index portable: it bundles the persisted `.openlore/analysis/` graph files
 * together with their integrity attestation (change: add-index-integrity-attestation) into a
 * single, compact, self-describing artifact, and validates that artifact on import so a
 * stale / schema-skewed / tampered bundle is never served as current.
 *
 * Trust model (validate-or-rebuild — see the CLI `import` command for the executed order):
 *   1. bundle/schema version — the bundled index schema must match this OpenLore's `SCHEMA_VERSION`.
 *   2. payload integrity — a SHA-256 over the canonical bundled bytes. Detects ANY corrupt /
 *      hand-edited / line-merged bundle (a generated artifact is regenerate-don't-merge; a
 *      hand-merge changes the bytes and is rejected here).
 *   3. graph-content digest — recomputed from the materialized store and compared to the
 *      bundled attestation's `digest` (the spec's "content digest matches its attestation").
 * Untrusted-artifact safety is enforced at parse: the decompressed size is bounded, every bundled
 * file name must be a plain basename (no path traversal), and the manifest's file list must match
 * the payload. Any failure degrades to a local rebuild; the bundle never leaves the consumer worse off
 * than having no artifact at all.
 *
 * Determinism: the artifact is a byte-stable function of the index it serializes (sorted file
 * order, no wall-clock fields, fixed gzip level) — exporting the same index twice is identical.
 * No new dependency (Node `zlib`/`crypto`), no network, no LLM.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile, writeFile, readdir, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { join, basename, isAbsolute } from 'node:path';
import {
  ARTIFACT_CALL_GRAPH_DB,
  ARTIFACT_FINGERPRINT,
  ARTIFACT_INDEX_ATTESTATION,
} from '../../constants.js';
import {
  computeAttestation,
  digestProductionGraph,
  type IndexAttestation,
} from './index-attestation.js';
import { EdgeStore } from '../services/edge-store.js';

/** Artifact format version. Bump only on a shape change of the envelope below. */
export const BUNDLE_VERSION = 1;

/** Default committed artifact path (outside `analysis/` so export never bundles itself). */
export const BUNDLE_DEFAULT_FILENAME = 'index-bundle.olbundle';

/**
 * Upper bound on the decompressed bundle size read at import. The bundle is untrusted
 * on-disk input (mcp-security: Untrusted Artifact Deserialization Safety) — bound the
 * gunzip output so a maliciously-crafted artifact cannot exhaust memory (zip bomb). A
 * generous 2 GiB cap clears any real index while failing closed on an absurd one.
 */
const BUNDLE_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Files never bundled. Transient SQLite sidecars are WAL scratch folded into the main db by a
 * checkpoint before export; a stale copy alongside an imported db would mislead the reader. The
 * LanceDB search index lives in subdirectories (`vector-index/`, `text-line-index/`, skipped
 * because `readdir` filters `isFile()`) plus `vector-index-meta.json`; it is large and a
 * deterministic function of the graph, so it is NOT bundled — instead `import` rebuilds the
 * keyword (BM25) search index from the materialized graph (offline, no API) so `orient` /
 * `search_code` work immediately. `vector-index-meta.json` is excluded so a consumer never
 * materializes metadata describing an index that isn't there.
 */
const EXCLUDED_FILES = new Set([
  `${ARTIFACT_CALL_GRAPH_DB}-wal`,
  `${ARTIFACT_CALL_GRAPH_DB}-shm`,
  'vector-index-meta.json',
]);

/**
 * Rebuildable search-index subdirectories cleared from the live analysis dir on import: they are
 * a deterministic function of the graph, so a copy left over from a PRIOR index would point search
 * at embeddings for a graph that no longer matches the imported `call-graph.db`. `import` rebuilds
 * the keyword (`vector-index/`) index fresh; `text-line-index/` is left absent (rebuilt by the next
 * `openlore analyze`; the features that use it degrade gracefully rather than serve stale results).
 */
const REBUILDABLE_INDEX_SUBDIRS = ['vector-index', 'text-line-index'];

/** Self-describing manifest carried with every bundle. No wall-clock field → deterministic. */
export interface BundleManifest {
  /** Envelope format version (BUNDLE_VERSION). */
  bundleVersion: number;
  /** OpenLore version that produced the bundle (informational; not a trust gate). */
  openloreVersion: string;
  /** EdgeStore SCHEMA_VERSION the bundled index was built at (== attestation.schemaVersion). */
  schemaVersion: number;
  /** The source commit the index was built from, or null when it could not be determined. */
  sourceCommit: string | null;
  /** The bundled integrity attestation — the trust stamp a consumer validates against. */
  attestation: IndexAttestation;
  /** SHA-256 over the canonical bundled file bytes (tamper / corruption evidence). */
  payloadDigest: string;
  /** Bundled files, sorted by name (the canonical order the digest is computed over). */
  files: Array<{ name: string; bytes: number }>;
}

/** The artifact envelope: manifest + base64-encoded file payload. */
export interface Bundle {
  manifest: BundleManifest;
  /** filename → base64 of the file's bytes. */
  payload: Record<string, string>;
}

/** A structured, recoverable bundle error with a stable code for the CLI to branch on. */
export class BundleError extends Error {
  constructor(public readonly code: 'no-index' | 'unreadable', message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/** Read the build commit the index was produced at from `fingerprint.json` (null if absent). */
async function readSourceCommit(analysisDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(analysisDir, ARTIFACT_FINGERPRINT), 'utf-8');
    const parsed = JSON.parse(raw) as { commit?: unknown };
    return typeof parsed.commit === 'string' && parsed.commit.length > 0 ? parsed.commit : null;
  } catch {
    return null;
  }
}

/**
 * Canonical payload digest over a stable projection of the bundled files: for each file in
 * sorted order, `name`, byte length, then the raw bytes. Order-independent of how the bundle
 * happens to be iterated, sensitive to any byte change in any file.
 */
function computePayloadDigest(files: Array<{ name: string; bytes: Buffer }>): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    h.update(f.name + '\n');
    h.update(String(f.bytes.length) + '\n');
    h.update(f.bytes);
  }
  return h.digest('hex');
}

/**
 * Re-attest the CURRENT persisted store: compute a fresh attestation (counts + content
 * digest + schema) directly from the store the bundle is about to serialize, using the same
 * canonical projection the build-time attestation uses. This is deliberate — the on-disk
 * `index-attestation.json` digest reflects the last FULL build, but the incremental watcher
 * legitimately mutates the store between full builds (the digest is documented as "not a
 * load-time driver" for exactly this reason). Re-attesting at export time makes the bundled
 * attestation describe *exactly the bytes being exported*, so the import-time digest check is
 * a true tamper detector rather than a false positive on every incrementally-updated index.
 */
function attestExportedStore(dbPath: string): IndexAttestation {
  const store = EdgeStore.open(dbPath);
  try {
    const nodes = store.getAllInternalNodes().map(n => ({ id: n.id, filePath: n.filePath }));
    const edges = store.getAllEdges().map(e => ({ callerId: e.callerId, calleeId: e.calleeId, calleeName: e.calleeName }));
    const classes = store.getAllClasses().map(c => ({ id: c.id }));
    return computeAttestation(store.getSchemaVersion(), nodes, edges, classes);
  } finally {
    store.close();
  }
}

export interface BuildBundleResult {
  buffer: Buffer;
  manifest: BundleManifest;
}

/**
 * Serialize the persisted index under `analysisDir` (plus a fresh integrity attestation) into
 * a single gzipped, self-describing artifact. Byte-stable: the same index serializes
 * identically. The caller SHOULD checkpoint the store's WAL into the main db before calling so
 * the bundled `call-graph.db` is self-contained.
 */
export async function buildBundle(analysisDir: string, openloreVersion: string): Promise<BuildBundleResult> {
  const dbPath = join(analysisDir, ARTIFACT_CALL_GRAPH_DB);
  if (!existsSync(dbPath)) {
    throw new BundleError(
      'no-index',
      `No "${ARTIFACT_CALL_GRAPH_DB}" found in ${analysisDir}. Run "openlore analyze" before exporting.`,
    );
  }

  const attestation = attestExportedStore(dbPath);
  const sourceCommit = await readSourceCommit(analysisDir);

  const entries = await readdir(analysisDir, { withFileTypes: true });
  const names = entries
    .filter(e => e.isFile() && !EXCLUDED_FILES.has(e.name))
    .map(e => e.name)
    .sort();

  // The bundled attestation file is overridden with the freshly-computed one so the on-disk
  // copy a consumer materializes is self-consistent with the exported db. Synthesize it if
  // the source dir had none (e.g. a legacy index).
  const freshAttestationBytes = Buffer.from(JSON.stringify(attestation, null, 2));
  if (!names.includes(ARTIFACT_INDEX_ATTESTATION)) names.push(ARTIFACT_INDEX_ATTESTATION);
  names.sort();

  const payload: Record<string, string> = {};
  const manifestFiles: Array<{ name: string; bytes: number }> = [];
  const rawFiles: Array<{ name: string; bytes: Buffer }> = [];
  for (const name of names) {
    const bytes = name === ARTIFACT_INDEX_ATTESTATION
      ? freshAttestationBytes
      : await readFile(join(analysisDir, name));
    payload[name] = bytes.toString('base64');
    manifestFiles.push({ name, bytes: bytes.length });
    rawFiles.push({ name, bytes });
  }

  const manifest: BundleManifest = {
    bundleVersion: BUNDLE_VERSION,
    openloreVersion,
    schemaVersion: attestation.schemaVersion,
    sourceCommit,
    attestation,
    payloadDigest: computePayloadDigest(rawFiles),
    files: manifestFiles,
  };

  // Fixed key order + sorted payload keys + fixed gzip level → byte-stable output.
  const json = JSON.stringify({ manifest, payload });
  const buffer = gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
  return { buffer, manifest };
}

/** True iff every required numeric count is present and finite (mirrors the attestation guard). */
function hasAttestationCounts(c: unknown): boolean {
  if (c === null || typeof c !== 'object') return false;
  const r = c as Record<string, unknown>;
  return (['files', 'functions', 'edges', 'classes'] as const)
    .every(k => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

/** True iff `v` is a structurally-valid bundle envelope (defensive parse of untrusted input). */
function isBundleShape(v: unknown): v is Bundle {
  if (v === null || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  const m = b.manifest as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object') return false;
  if (typeof m.bundleVersion !== 'number') return false;
  if (typeof m.schemaVersion !== 'number') return false;
  if (typeof m.payloadDigest !== 'string') return false;
  if (!Array.isArray(m.files)) return false;
  // Validate the attestation's inner fields at the boundary rather than relying on a
  // downstream fail-closed (a missing digest/counts must not depend on later check ordering).
  const att = m.attestation as Record<string, unknown> | null;
  if (att === null || typeof att !== 'object') return false;
  if (typeof att.digest !== 'string' || typeof att.schemaVersion !== 'number' || !hasAttestationCounts(att.committed)) return false;
  if (b.payload === null || typeof b.payload !== 'object') return false;
  return Object.values(b.payload as Record<string, unknown>).every(x => typeof x === 'string');
}

/**
 * A payload file name is safe to materialize iff it is a plain basename — no directory
 * separator, no `..`, not absolute, not `.`/empty. A legitimate bundle only ever contains
 * flat basenames (readdir of `.openlore/analysis/`); rejecting anything else closes a
 * path-traversal arbitrary-write on import of an untrusted/hand-crafted artifact
 * (mcp-security: Untrusted Artifact Deserialization Safety). `join(targetDir, name)` with a
 * name like `../../x` or `/etc/x` would otherwise escape the target directory.
 */
export function isSafeBundleFileName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !isAbsolute(name) &&
    basename(name) === name
  );
}

/**
 * Decompress and structurally validate an artifact buffer. Throws `BundleError('unreadable')`
 * when the input is not an OpenLore bundle at all (bad gzip / JSON / shape) — a distinct
 * failure from an artifact that parses but fails trust validation (which degrades to rebuild).
 */
export function parseBundle(raw: Buffer): Bundle {
  let json: string;
  try {
    json = gunzipSync(raw, { maxOutputLength: BUNDLE_MAX_DECOMPRESSED_BYTES }).toString('utf-8');
  } catch {
    throw new BundleError('unreadable', 'Not an OpenLore bundle: gzip decompression failed (or it exceeds the size cap).');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new BundleError('unreadable', 'Not an OpenLore bundle: payload is not valid JSON.');
  }
  if (!isBundleShape(parsed)) {
    throw new BundleError('unreadable', 'Not an OpenLore bundle: envelope shape is invalid.');
  }
  // Reject path-traversal / absolute payload names BEFORE any file is written (untrusted input).
  const unsafe = Object.keys(parsed.payload).find(name => !isSafeBundleFileName(name));
  if (unsafe !== undefined) {
    throw new BundleError('unreadable', `Refusing artifact with an unsafe bundled file name: ${JSON.stringify(unsafe)}.`);
  }
  // The manifest's file list MUST exactly match the payload it describes (no silently-extra or
  // omitted files riding along). Catches corruption/truncation and keeps the manifest authoritative.
  const payloadNames = Object.keys(parsed.payload).sort();
  const manifestNames = [...parsed.manifest.files.map(f => f.name)].sort();
  if (payloadNames.length !== manifestNames.length || payloadNames.some((n, i) => n !== manifestNames[i])) {
    throw new BundleError('unreadable', 'Bundle manifest file list does not match its payload.');
  }
  return parsed;
}

/** Recompute the payload digest from a parsed bundle and compare to the manifest (tamper check). */
export function verifyPayloadIntegrity(bundle: Bundle): boolean {
  const rawFiles = Object.entries(bundle.payload).map(([name, b64]) => ({
    name,
    bytes: Buffer.from(b64, 'base64'),
  }));
  return computePayloadDigest(rawFiles) === bundle.manifest.payloadDigest;
}

/**
 * Recompute the production-graph content digest from a (materialized) store, using the same
 * canonical projection the build-time attestation used (internal nodes, all edges, all
 * classes). Equality with the bundled attestation's `digest` proves the materialized graph
 * IS the one that was attested — the spec's "content digest matches its attestation".
 */
export function recomputeProductionDigest(store: EdgeStore): string {
  const nodes = store.getAllInternalNodes().map(n => ({ id: n.id, filePath: n.filePath }));
  const edges = store.getAllEdges().map(e => ({ callerId: e.callerId, calleeId: e.calleeId, calleeName: e.calleeName }));
  const classes = store.getAllClasses().map(c => ({ id: c.id }));
  return digestProductionGraph(store.getSchemaVersion(), nodes, edges, classes);
}

/** Materialize a parsed bundle's files into `targetDir` (created if needed). Overwrites by name. */
export async function materializeBundle(bundle: Bundle, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const [name, b64] of Object.entries(bundle.payload)) {
    // Defense in depth: parseBundle already rejects unsafe names, but never write outside the
    // target dir even if a caller hands us an unvalidated bundle.
    if (!isSafeBundleFileName(name)) throw new BundleError('unreadable', `Unsafe bundled file name: ${JSON.stringify(name)}.`);
    // Safe names are flat basenames (validated above), so no parent-dir creation is needed.
    await writeFile(join(targetDir, name), Buffer.from(b64, 'base64'));
  }
}

/**
 * Copy the bundled files from a staging dir into the live analysis dir. Clears stale WAL sidecars,
 * the excluded vector-index metadata, and any rebuildable search-index subdirectory left over from
 * a PRIOR index (whose embeddings would now mismatch the imported graph) before promoting.
 */
export async function promoteStagedIndex(bundle: Bundle, stagingDir: string, analysisDir: string): Promise<void> {
  await mkdir(analysisDir, { recursive: true });
  // A stale -wal/-shm next to the freshly-copied call-graph.db would corrupt the reader's view,
  // and a stale vector-index-meta.json would describe an index that isn't here; remove them.
  for (const sidecar of EXCLUDED_FILES) {
    await rm(join(analysisDir, sidecar), { force: true });
  }
  // Drop orphaned search-index subdirs from a prior index — they describe a different graph.
  for (const sub of REBUILDABLE_INDEX_SUBDIRS) {
    await rm(join(analysisDir, sub), { recursive: true, force: true });
  }
  for (const name of Object.keys(bundle.payload)) {
    if (!isSafeBundleFileName(name)) throw new BundleError('unreadable', `Unsafe bundled file name: ${JSON.stringify(name)}.`);
    await copyFile(join(stagingDir, name), join(analysisDir, name));
  }
}

/** Best-effort directory removal (staging cleanup). */
export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** True if `path` exists (file or dir). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
