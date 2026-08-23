import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore, SCHEMA_VERSION } from '../services/edge-store.js';
import { ARTIFACT_CALL_GRAPH_DB, ARTIFACT_FINGERPRINT, OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { runBundleExport } from '../../cli/export/bundle.js';
import { computeAttestation, writeAttestation, reconcile } from './index-attestation.js';
import type { FunctionNode, CallEdge, ClassNode } from './call-graph.js';
import {
  buildBundle,
  parseBundle,
  verifyPayloadIntegrity,
  recomputeProductionDigest,
  materializeBundle,
  promoteStagedIndex,
  isSafeBundleFileName,
  BundleError,
  BUNDLE_VERSION,
  BUNDLE_MAX_COMPRESSED_BYTES,
  BUNDLE_MAX_DECOMPRESSED_BYTES,
  verifyBundleSignature,
  verifyBundledSourceIdentity,
} from './index-bundle.js';
import { createGzip, gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  publishGeneration,
  readCurrentGeneration,
  REQUIRED_ANALYSIS_ARTIFACTS,
} from '../runtime/analysis-generation.js';
import {
  preMaterializeRebuildReason,
  currencyDecision,
  readBundledSignatures,
  runImport,
} from '../../cli/commands/import.js';
import { ANALYSIS_LOCK_FILE } from '../runtime/advisory-lock.js';
import { logger } from '../../utils/logger.js';
import { getDefaultConfig } from '../services/config-manager.js';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { semanticAnswerBytes } from './derived-artifact-equivalence.js';
import { handleAnalyzeImpact, handleGetSubgraph } from '../services/mcp-handlers/graph.js';
import { _resetContextCacheForTesting } from '../services/mcp-handlers/utils.js';

const VERSION = '9.9.9-test';

/** A small but real production graph: 3 functions across 2 files, a 2-edge chain, 1 class. */
function makeNodes(): FunctionNode[] {
  return [
    { id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts', isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 1 },
    { id: 'src/a.ts::bar', name: 'bar', filePath: 'src/a.ts', isAsync: false, language: 'TypeScript', startIndex: 11, endIndex: 20, fanIn: 1, fanOut: 1 },
    { id: 'src/b.ts::baz', name: 'baz', filePath: 'src/b.ts', isAsync: true, language: 'TypeScript', startIndex: 0, endIndex: 30, fanIn: 1, fanOut: 0 },
  ];
}
function makeEdges(): CallEdge[] {
  return [
    { callerId: 'src/a.ts::foo', calleeId: 'src/a.ts::bar', calleeName: 'bar', confidence: 'same_file' },
    { callerId: 'src/a.ts::bar', calleeId: 'src/b.ts::baz', calleeName: 'baz', confidence: 'import' },
  ];
}
function makeClasses(): ClassNode[] {
  return [
    { id: 'src/b.ts::Svc', name: 'Svc', filePath: 'src/b.ts', language: 'TypeScript', parentClasses: [], interfaces: [], methodIds: [], fanIn: 0, fanOut: 0, isModule: false },
  ];
}

/** Build a realistic analysis dir: a populated call-graph.db + matching attestation + fingerprint. */
async function buildAnalysisDir(
  dir: string,
  commit: string | null,
  sourceTreeState: 'clean' | 'dirty' | 'unknown' = 'clean',
): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const nodes = makeNodes();
  const edges = makeEdges();
  const classes = makeClasses();
  const store = EdgeStore.open(join(dir, ARTIFACT_CALL_GRAPH_DB));
  store.insertNodes(nodes);
  store.insertEdges(edges);
  store.insertClasses(classes);
  store.checkpoint();
  store.close();

  const attestation = computeAttestation(
    SCHEMA_VERSION,
    nodes.map(n => ({ id: n.id, filePath: n.filePath })),
    edges.map(e => ({ callerId: e.callerId, calleeId: e.calleeId, calleeName: e.calleeName })),
    classes.map(c => ({ id: c.id })),
  );
  await writeAttestation(dir, attestation);
  await writeFile(
    join(dir, ARTIFACT_FINGERPRINT),
    JSON.stringify({ hash: 'h', commit, sourceTreeState, computedAt: 'x', fileCount: 2 }),
  );
  // A non-graph JSON artifact, to prove the whole index travels (not just the db).
  await writeFile(join(dir, 'repo-structure.json'), JSON.stringify({ layers: ['core'] }));
  await writeFile(join(dir, 'llm-context.json'), JSON.stringify({ callGraph: { nodes: [] }, signatures: [] }));
  await writeFile(join(dir, 'dependency-graph.json'), JSON.stringify({ nodes: [], edges: [] }));
}

/** Persist the real graph produced from source in the same artifacts structural MCP handlers read. */
async function buildStructuralAnalysis(
  projectRoot: string,
  files: Readonly<Record<string, string>>,
  commit: string,
): Promise<string> {
  const analysisDir = join(projectRoot, OPENLORE_ANALYSIS_REL_PATH);
  await mkdir(analysisDir, { recursive: true });
  const built = await new CallGraphBuilder().build(Object.entries(files).map(([path, content]) => ({
    path,
    content,
    language: 'TypeScript',
  })));
  const graph = serializeCallGraph(built);

  const store = EdgeStore.open(join(analysisDir, ARTIFACT_CALL_GRAPH_DB));
  try {
    store.insertNodes(graph.nodes);
    store.insertEdges(graph.edges);
    store.insertClasses(graph.classes);
    for (const [path, content] of Object.entries(files)) {
      store.setFileHash(path, createHash('sha256').update(content).digest('hex'));
    }
    store.checkpoint();
  } finally {
    store.close();
  }

  const attestation = computeAttestation(
    SCHEMA_VERSION,
    graph.nodes.map(node => ({ id: node.id, filePath: node.filePath })),
    graph.edges.map(edge => ({
      callerId: edge.callerId,
      calleeId: edge.calleeId,
      calleeName: edge.calleeName,
    })),
    graph.classes.map(node => ({ id: node.id })),
  );
  await writeAttestation(analysisDir, attestation);
  await writeFile(
    join(analysisDir, ARTIFACT_FINGERPRINT),
    JSON.stringify({ hash: 'structural-fixture-v1', commit, sourceTreeState: 'clean', computedAt: 'fixture', fileCount: Object.keys(files).length }),
  );
  await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({ callGraph: graph, signatures: [] }));
  await writeFile(join(analysisDir, 'repo-structure.json'), JSON.stringify({ layers: ['src'] }));
  await writeFile(join(analysisDir, 'dependency-graph.json'), JSON.stringify({ nodes: [], edges: [] }));
  await publishGeneration(analysisDir, [
    ...REQUIRED_ANALYSIS_ARTIFACTS,
    ARTIFACT_CALL_GRAPH_DB,
    'index-attestation.json',
  ]);
  return analysisDir;
}

function ed25519PemPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'olbundle-test-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  _resetContextCacheForTesting();
  await rm(work, { recursive: true, force: true });
});

describe('index-bundle: export', () => {
  it('builds a self-describing bundle with attestation, commit, and a payload manifest', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const { manifest } = await buildBundle(src, VERSION);

    expect(manifest.bundleVersion).toBe(BUNDLE_VERSION);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.sourceCommit).toBe('abc1234');
    expect(manifest.sourceTreeState).toBe('clean');
    expect(manifest.openloreVersion).toBe(VERSION);
    expect(manifest.attestation.committed).toEqual({ files: 2, functions: 3, edges: 2, classes: 1 });
    expect(manifest.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    // call-graph.db + index-attestation.json + fingerprint.json + repo-structure.json
    expect(manifest.files.map(f => f.name).sort()).toContain(ARTIFACT_CALL_GRAPH_DB);
    expect(manifest.files.length).toBe(6);
  });

  it('is byte-stable: exporting the same index twice produces an identical artifact', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const a = await buildBundle(src, VERSION);
    const b = await buildBundle(src, VERSION);
    expect(Buffer.compare(a.buffer, b.buffer)).toBe(0);
  });

  it('signs the complete trust projection with a stable Ed25519 key fingerprint', async () => {
    const src = join(work, 'signed-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const keys = ed25519PemPair();
    const a = await buildBundle(src, VERSION, { signingKey: keys.privateKey });
    const b = await buildBundle(src, VERSION, { signingKey: keys.privateKey });

    expect(Buffer.compare(a.buffer, b.buffer)).toBe(0);
    const parsed = parseBundle(a.buffer);
    const verdict = verifyBundleSignature(parsed, [{ publicKey: keys.publicKey, label: 'release' }]);
    expect(verdict).toMatchObject({ status: 'verified', label: 'release' });
    expect(parsed.manifest.signature?.keyId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects manifest provenance edits even when the signed payload bytes are unchanged', async () => {
    const src = join(work, 'signed-tamper');
    await buildAnalysisDir(src, 'source-commit');
    const keys = ed25519PemPair();
    const parsed = parseBundle((await buildBundle(src, VERSION, { signingKey: keys.privateKey })).buffer);

    parsed.manifest.sourceCommit = 'victim-head';
    expect(verifyBundledSourceIdentity(parsed)).toBe(false);
    expect(() => verifyBundleSignature(parsed, [{ publicKey: keys.publicKey }])).toThrow(/verification failed/i);
  });

  it('rejects signatures from keys the repository did not trust', async () => {
    const src = join(work, 'untrusted-signer');
    await buildAnalysisDir(src, 'abc1234');
    const keys = ed25519PemPair();
    const parsed = parseBundle((await buildBundle(src, VERSION, { signingKey: keys.privateKey })).buffer);
    expect(() => verifyBundleSignature(parsed, [])).toThrow(/not trusted/i);
  });

  it('rejects signed payload tampering even when the attacker recomputes the payload digest', async () => {
    const src = join(work, 'signed-payload-tamper');
    await buildAnalysisDir(src, 'abc1234');
    const keys = ed25519PemPair();
    const parsed = parseBundle((await buildBundle(src, VERSION, { signingKey: keys.privateKey })).buffer);
    const fingerprint = JSON.parse(Buffer.from(parsed.payload[ARTIFACT_FINGERPRINT], 'base64').toString('utf8'));
    fingerprint.hash = 'attacker-edited';
    const edited = Buffer.from(JSON.stringify(fingerprint));
    parsed.payload[ARTIFACT_FINGERPRINT] = edited.toString('base64');
    const record = parsed.manifest.files.find(file => file.name === ARTIFACT_FINGERPRINT)!;
    record.bytes = edited.length;
    // The attacker can recompute this unkeyed digest, but cannot update the Ed25519 signature.
    const forgedRaw = Object.entries(parsed.payload).map(([name, value]) => ({ name, bytes: Buffer.from(value, 'base64') }));
    const hash = (await import('node:crypto')).createHash('sha256');
    for (const file of forgedRaw.sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(file.name + '\n');
      hash.update(String(file.bytes.length) + '\n');
      hash.update(file.bytes);
    }
    parsed.manifest.payloadDigest = hash.digest('hex');
    expect(() => verifyBundleSignature(parsed, [{ publicKey: keys.publicKey }])).toThrow(/verification failed/i);
  });

  /**
   * A bundle is a portable GRAPH index. The Pass-1 fact memo (change:
   * optimize-hash-keyed-analyze) is this machine's record of what it has already parsed —
   * ~44% of the compressed payload, and useful to a consumer only under an exact
   * commit-plus-version-plus-grammar match. It must not ride along, and stripping it must
   * leave the live store untouched.
   */
  it('strips the local Pass-1 fact memo, without mutating the exported store', async () => {
    const src = join(work, 'with-memo');
    await buildAnalysisDir(src, 'abc1234');
    const dbPath = join(src, ARTIFACT_CALL_GRAPH_DB);

    const store = EdgeStore.openForAnalyze(dbPath);
    try {
      store.putPass1Facts(
        Array.from({ length: 40 }, (_, i) => ({
          filePath: `src/f${i}.ts`,
          contentHash: `hash-${i}`,
          facts: JSON.stringify({ v: 1, n: [], e: [], s: { filler: 'x'.repeat(2000) } }),
        })),
        'stamp-1',
      );
      expect(store.countPass1Facts()).toBe(40);
    } finally {
      store.close();
    }

    const { buffer } = await buildBundle(src, VERSION);
    const target = join(work, 'materialized');
    await materializeBundle(parseBundle(buffer), target);

    const exported = EdgeStore.openForAnalyze(join(target, ARTIFACT_CALL_GRAPH_DB));
    try {
      expect(exported.countPass1Facts()).toBe(0);       // the memo did not travel
      expect(exported.countNodes()).toBeGreaterThan(0); // the graph did
    } finally {
      exported.close();
    }

    // The live store still has its memo — an export is a read, not a cache eviction.
    const live = EdgeStore.openForAnalyze(dbPath);
    try {
      expect(live.countPass1Facts()).toBe(40);
    } finally {
      live.close();
    }
  });

  /**
   * The analysis directory accumulates FULL, UNPROCESSED copies of the graph store that
   * belong to this machine alone: a `*.corrupt-<n>` preserved when a store was quarantined,
   * and a `*.export-<pid>` left by an export that was killed before it could clean up.
   * Bundling one does not merely bloat the artifact — it re-imports the local build cache the
   * strip exists to remove, and drops a corrupt or stale graph into the consumer's analysis
   * dir, where their own next export would pass it on again.
   *
   * Asserted on PLANTED debris rather than on "the directory is clean after a successful
   * export", which the pre-fix implementation also satisfied (it deleted its scratch in a
   * `finally`) and which therefore proves nothing about a killed one.
   */
  it('never bundles a quarantined or leftover-scratch copy of the store', async () => {
    const src = join(work, 'with-debris');
    await buildAnalysisDir(src, 'abc1234');
    const dbPath = join(src, ARTIFACT_CALL_GRAPH_DB);

    const store = EdgeStore.openForAnalyze(dbPath);
    try {
      store.putPass1Facts([{ filePath: 'src/a.ts', contentHash: 'h', facts: '{"v":1,"n":[],"e":[]}' }], 's');
    } finally {
      store.close();
    }
    // Two full copies of a store carrying the memo, exactly as the two real producers leave them.
    await writeFile(`${dbPath}.corrupt-0`, await readFile(dbPath));
    await writeFile(`${dbPath}.export-99999`, await readFile(dbPath));

    const { manifest } = await buildBundle(src, VERSION);
    const bundled = manifest.files.map(f => f.name);
    expect(bundled).toContain(ARTIFACT_CALL_GRAPH_DB);
    expect(bundled).not.toContain(`${ARTIFACT_CALL_GRAPH_DB}.corrupt-0`);
    expect(bundled).not.toContain(`${ARTIFACT_CALL_GRAPH_DB}.export-99999`);

    // And the debris does not sneak the memo in by the back door.
    const target = join(work, 'materialized-debris');
    await materializeBundle(parseBundle((await buildBundle(src, VERSION)).buffer), target);
    const exported = EdgeStore.openForAnalyze(join(target, ARTIFACT_CALL_GRAPH_DB));
    try {
      expect(exported.countPass1Facts()).toBe(0);
    } finally {
      exported.close();
    }
  });

  it('never exports or materializes the analysis lock', async () => {
    const src = join(work, 'with-runtime-lock');
    await buildAnalysisDir(src, 'abc1234');
    await writeFile(join(src, ANALYSIS_LOCK_FILE), 'producer-lock');
    const built = await buildBundle(src, VERSION);
    expect(built.manifest.files.map(file => file.name)).not.toContain(ANALYSIS_LOCK_FILE);

    const forged = parseBundle(built.buffer);
    forged.payload[ANALYSIS_LOCK_FILE] = Buffer.from('forged-lock').toString('base64');
    forged.payload['.vector-index.lock'] = Buffer.from('forged-vector-lock').toString('base64');
    forged.payload[`${ARTIFACT_CALL_GRAPH_DB}-wal`] = Buffer.from('forged-wal').toString('base64');
    const target = join(work, 'lock-materialized');
    await materializeBundle(forged, target);
    expect(existsSync(join(target, ANALYSIS_LOCK_FILE))).toBe(false);
    expect(existsSync(join(target, '.vector-index.lock'))).toBe(false);
    expect(existsSync(join(target, `${ARTIFACT_CALL_GRAPH_DB}-wal`))).toBe(false);
  });

  /**
   * The strip stages its copy under `os.tmpdir()`, which is not guaranteed to be usable — an
   * unset or read-only `TMPDIR`, a full volume. Silently shipping the local build cache in
   * that case would be the worse outcome, so it falls back to staging beside the store under
   * a name the debris filter matches, and says so when even that fails.
   */
  it('still strips the memo when the temp directory is unusable', async () => {
    const src = join(work, 'no-tmpdir');
    await buildAnalysisDir(src, 'abc1234');
    const store = EdgeStore.openForAnalyze(join(src, ARTIFACT_CALL_GRAPH_DB));
    try {
      store.putPass1Facts([{ filePath: 'src/a.ts', contentHash: 'h', facts: '{"v":1,"n":[],"e":[]}' }], 's');
    } finally {
      store.close();
    }

    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join(work, 'definitely-not-a-directory');
    let buffer: Buffer;
    let note: string | undefined;
    try {
      const built = await buildBundle(src, VERSION);
      buffer = built.buffer;
      note = built.note;
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }

    const target = join(work, 'materialized-no-tmpdir');
    await materializeBundle(parseBundle(buffer), target);
    const exported = EdgeStore.openForAnalyze(join(target, ARTIFACT_CALL_GRAPH_DB));
    try {
      // The STRONG property: the fallback ran and the memo was stripped anyway. Asserting
      // "either it stripped or it said so" would be satisfied by the degraded path the
      // fallback exists to avoid — i.e. it would pass with no fallback at all.
      expect(exported.countPass1Facts()).toBe(0);
      expect(exported.countNodes()).toBeGreaterThan(0);
      expect(note).toBeUndefined();
    } finally {
      exported.close();
    }
    // Whatever happened, no staging file was left in the analysis dir.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(src)).filter(n => n.includes('.export-'))).toEqual([]);
  });

  /**
   * The export-side filter cannot help with a bundle that already contains debris — every
   * OpenLore released before that filter produced them. Materializing one must not plant a
   * full, un-stripped copy of the PRODUCER's store (extraction cache and all) permanently in
   * this machine's analysis dir.
   */
  it('drops debris carried by a bundle built before the export filter existed', async () => {
    const src = join(work, 'legacy-bundle');
    await buildAnalysisDir(src, 'abc1234');
    const { buffer } = await buildBundle(src, VERSION);
    const bundle = parseBundle(buffer);
    expect(bundle.provenance).toBe('imported');

    // Forge the shape an older exporter produced: the quarantine copy alongside the store.
    bundle.payload[`${ARTIFACT_CALL_GRAPH_DB}.corrupt-0`] = bundle.payload[ARTIFACT_CALL_GRAPH_DB];

    const target = join(work, 'materialized-legacy');
    await materializeBundle(bundle, target);
    const { readdir } = await import('node:fs/promises');
    const written = await readdir(target);
    expect(written).toContain(ARTIFACT_CALL_GRAPH_DB);
    expect(written).not.toContain(`${ARTIFACT_CALL_GRAPH_DB}.corrupt-0`);
  });

  it('re-attests from the store at export time, even with no on-disk attestation', async () => {
    const src = join(work, 'no-att');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(src, { recursive: true });
    const store = EdgeStore.open(join(src, ARTIFACT_CALL_GRAPH_DB));
    store.insertNodes(makeNodes());
    store.insertEdges(makeEdges());
    store.insertClasses(makeClasses());
    store.close();
    const { manifest } = await buildBundle(src, VERSION);
    // A fresh attestation was synthesized describing the exported store.
    expect(manifest.attestation.committed).toEqual({ files: 2, functions: 3, edges: 2, classes: 1 });
    expect(manifest.files.map(f => f.name)).toContain('index-attestation.json');
  });

  it('writes the artifact into a not-yet-existing --out directory (creates parents, no ENOENT)', async () => {
    const projectRoot = join(work, 'proj');
    await buildAnalysisDir(join(projectRoot, OPENLORE_ANALYSIS_REL_PATH), 'abc1234');
    const out = join(work, 'nested', 'deep', 'index-bundle.olbundle');
    expect(existsSync(out)).toBe(false);
    const code = await runBundleExport({ out, projectRoot });
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it('returns a clean error for an invalid signing key without overwriting the output', async () => {
    const projectRoot = join(work, 'bad-signing-key');
    await buildAnalysisDir(join(projectRoot, OPENLORE_ANALYSIS_REL_PATH), 'abc1234');
    const out = join(work, 'preserve.olbundle');
    const key = join(work, 'not-a-key.pem');
    await writeFile(out, 'keep-me');
    await writeFile(key, 'not a private key');

    expect(await runBundleExport({ out, projectRoot, signKey: key })).toBe(2);
    expect(await readFile(out, 'utf8')).toBe('keep-me');
  });

  it('refuses to export when no call-graph.db is present', async () => {
    const src = join(work, 'no-db');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(src, { recursive: true });
    await writeAttestation(src, computeAttestation(SCHEMA_VERSION, [], [], []));
    await expect(buildBundle(src, VERSION)).rejects.toMatchObject({ code: 'no-index' });
  });
});

describe('index-bundle: round-trip materialization (the "identical index" property)', () => {
  it('export → parse → materialize reproduces a content-identical graph that reconciles healthy', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const { buffer, manifest } = await buildBundle(src, VERSION);

    const bundle = parseBundle(buffer);
    expect(verifyPayloadIntegrity(bundle)).toBe(true);

    const dest = join(work, 'dest-analysis');
    await materializeBundle(bundle, dest);

    const store = EdgeStore.open(join(dest, ARTIFACT_CALL_GRAPH_DB));
    try {
      // Graph content digest of the materialized store equals the bundled attestation's.
      expect(recomputeProductionDigest(store)).toBe(manifest.attestation.digest);
      // ...and it reconciles healthy (counts + schema match).
      const verdict = reconcile(manifest.attestation, {
        schemaVersion: store.getSchemaVersion(),
        files: store.countFiles(),
        functions: store.countNodes(),
        edges: store.countEdges(),
        classes: store.countClasses(),
      });
      expect(verdict.verdict).toBe('healthy');
    } finally {
      store.close();
    }
    // The non-graph artifact travelled too.
    expect(JSON.parse(await readFile(join(dest, 'repo-structure.json'), 'utf-8'))).toEqual({ layers: ['core'] });
  });
});

describe('index-bundle: promoteStagedIndex clears orphaned search indexes', () => {
  it('removes a prior index\'s vector-index/ + text-line-index/ + vector-index-meta.json, then copies bundle files', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    const staging = join(work, 'staging');
    await materializeBundle(bundle, staging);

    // A live analysis dir carrying a STALE search index from a different prior graph.
    const live = join(work, 'live-analysis');
    await mkdir(join(live, 'vector-index'), { recursive: true });
    await mkdir(join(live, 'text-line-index'), { recursive: true });
    await writeFile(join(live, 'vector-index', 'stale.lance'), 'STALE');
    await writeFile(join(live, 'vector-index-meta.json'), '{"hasEmbeddings":true}');
    await writeFile(join(live, 'old-route-inventory.json'), '{"stale":true}');
    await writeFile(join(live, '.vector-index.lock'), 'local-control');

    await promoteStagedIndex(bundle, staging, live);

    expect(existsSync(join(live, 'vector-index'))).toBe(false);     // orphan dir cleared
    expect(existsSync(join(live, 'text-line-index'))).toBe(false);  // orphan dir cleared
    expect(existsSync(join(live, 'vector-index-meta.json'))).toBe(false); // stale meta cleared
    expect(existsSync(join(live, 'old-route-inventory.json'))).toBe(false); // old-only artifact cleared
    expect(await readFile(join(live, '.vector-index.lock'), 'utf8')).toBe('local-control');
    expect(existsSync(join(live, ARTIFACT_CALL_GRAPH_DB))).toBe(true);    // bundle files promoted
    expect(JSON.parse(await readFile(join(live, 'analysis-origin.json'), 'utf8'))).toEqual({ provenance: 'imported' });
    expect(await readCurrentGeneration(live, [...REQUIRED_ANALYSIS_ARTIFACTS])).not.toBeNull();
  });

  it('marks an interrupted promotion unavailable instead of accepting a mixed generation', async () => {
    const src = join(work, 'next-analysis');
    await buildAnalysisDir(src, 'next');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    const staging = join(work, 'interrupt-staging');
    await materializeBundle(bundle, staging);

    const live = join(work, 'old-analysis');
    await buildAnalysisDir(live, 'old');
    expect(await publishGeneration(live, [...REQUIRED_ANALYSIS_ARTIFACTS])).not.toBeNull();

    await expect(promoteStagedIndex(bundle, staging, live, {
      afterStep: step => {
        if (step.startsWith('renamed:')) throw new Error('simulated process interruption');
      },
    })).rejects.toThrow(/simulated process interruption/);

    expect(await readCurrentGeneration(live, [...REQUIRED_ANALYSIS_ARTIFACTS])).toBeNull();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(live)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.import-/)]));
  });
});

describe('index-bundle: parse + tamper detection', () => {
  it('keeps the decompressed memory boundary at the measured 96 MiB policy cap', () => {
    expect(BUNDLE_MAX_DECOMPRESSED_BYTES).toBe(96 * 1024 * 1024);
  });

  it('rejects a non-bundle buffer as unreadable', () => {
    expect(() => parseBundle(Buffer.from('not a bundle'))).toThrow(BundleError);
  });

  it('rejects an oversized compressed buffer before attempting gzip parsing', () => {
    const oversized = Buffer.allocUnsafe(BUNDLE_MAX_COMPRESSED_BYTES + 1);
    expect(() => parseBundle(oversized)).toThrow(/compressed artifact exceeds.*size cap/i);
  });

  it('rejects a high-ratio gzip one block past the decompressed cap as BundleError', async () => {
    const gzip = createGzip({ level: 9 });
    const chunks: Buffer[] = [];
    gzip.on('data', chunk => chunks.push(Buffer.from(chunk)));
    const block = Buffer.alloc(1024 * 1024);
    for (let written = 0; written <= BUNDLE_MAX_DECOMPRESSED_BYTES; written += block.length) {
      if (!gzip.write(block)) await once(gzip, 'drain');
    }
    gzip.end();
    await once(gzip, 'end');
    const bomb = Buffer.concat(chunks);

    expect(bomb.byteLength).toBeLessThan(BUNDLE_MAX_COMPRESSED_BYTES);
    try {
      parseBundle(bomb);
      expect.fail('expected the near-cap compression bomb to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(BundleError);
      expect((error as Error).message).toMatch(/size cap/i);
    }
  });

  it('detects a tampered payload (flipped byte) via the payload digest', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const { buffer } = await buildBundle(src, VERSION);
    const bundle = parseBundle(buffer);
    expect(verifyPayloadIntegrity(bundle)).toBe(true);

    // Hand-edit a bundled file's bytes — the regenerate-don't-merge contract violation.
    const dbB64 = bundle.payload[ARTIFACT_CALL_GRAPH_DB];
    const raw = Buffer.from(dbB64, 'base64');
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    bundle.payload[ARTIFACT_CALL_GRAPH_DB] = raw.toString('base64');

    expect(verifyPayloadIntegrity(bundle)).toBe(false);
  });
});

describe('index-bundle: untrusted-artifact safety (path traversal)', () => {
  it('isSafeBundleFileName rejects traversal / absolute / separator / empty names', () => {
    for (const ok of ['call-graph.db', 'index-attestation.json', 'a.b.c']) {
      expect(isSafeBundleFileName(ok)).toBe(true);
    }
    for (const bad of ['../evil', '../../etc/passwd', '/etc/passwd', 'a/b', 'a\\b', '..', '.', '', 'x\0y']) {
      expect(isSafeBundleFileName(bad)).toBe(false);
    }
  });

  it('parseBundle refuses a bundle whose payload contains a path-traversal file name (no write)', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    // craft a malicious envelope with a traversal key
    bundle.payload['../../../../tmp/openlore-evil.txt'] = Buffer.from('pwn').toString('base64');
    const evil = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf-8'));
    expect(() => parseBundle(evil)).toThrow(/unsafe bundled file name/i);
  });

  it('materializeBundle refuses an unsafe name even if handed an unvalidated bundle (defense in depth)', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    bundle.payload['../escape.txt'] = Buffer.from('x').toString('base64');
    await expect(materializeBundle(bundle, join(work, 'dest'))).rejects.toThrow(BundleError);
  });
});

describe('index-bundle: envelope validation hardening', () => {
  async function freshBundleObj(): Promise<ReturnType<typeof parseBundle>> {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    return parseBundle((await buildBundle(src, VERSION)).buffer);
  }
  const reGzip = (obj: unknown) => gzipSync(Buffer.from(JSON.stringify(obj), 'utf-8'));

  it('rejects a manifest whose file list disagrees with the payload', async () => {
    const b = await freshBundleObj();
    b.payload['planted-extra.json'] = Buffer.from('{}').toString('base64'); // not in manifest.files
    expect(() => parseBundle(reGzip(b))).toThrow(/manifest file list does not match/i);
  });

  it('rejects an attestation missing its content digest', async () => {
    const b = await freshBundleObj();
    delete (b.manifest.attestation as { digest?: string }).digest;
    expect(() => parseBundle(reGzip(b))).toThrow(BundleError);
  });

  it('rejects an attestation with non-numeric committed counts', async () => {
    const b = await freshBundleObj();
    (b.manifest.attestation.committed as unknown as Record<string, unknown>).functions = 'lots';
    expect(() => parseBundle(reGzip(b))).toThrow(BundleError);
  });

  it('rejects malformed file and signature records at the untrusted parse boundary', async () => {
    const badFile = await freshBundleObj();
    (badFile.manifest.files as unknown[]) = [null];
    expect(() => parseBundle(reGzip(badFile))).toThrow(BundleError);

    const badSignature = await freshBundleObj();
    (badSignature.manifest as unknown as Record<string, unknown>).signature = {
      algorithm: 'rsa', keyId: 'attacker', value: 'not-base64',
    };
    expect(() => parseBundle(reGzip(badSignature))).toThrow(BundleError);
  });
});

describe('index-bundle: preMaterializeRebuildReason (version + schema gates)', () => {
  it('passes a current, matching bundle', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    expect(preMaterializeRebuildReason(bundle)).toBeNull();
  });

  it('flags an incompatible bundle format version', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    bundle.manifest.bundleVersion = BUNDLE_VERSION + 1;
    expect(preMaterializeRebuildReason(bundle)?.reason).toBe('bundle-version');
  });

  it('rejects fractional bundle versions instead of granting legacy semantics', async () => {
    const src = join(work, 'fractional-version');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    bundle.manifest.bundleVersion = 1.5;
    expect(() => parseBundle(gzipSync(Buffer.from(JSON.stringify(bundle))))).toThrow(BundleError);
  });

  it('accepts legacy v1 only as unsigned, with unknown tree currency', async () => {
    const src = join(work, 'legacy-v1');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    bundle.manifest.bundleVersion = 1;
    delete bundle.manifest.sourceTreeState;
    const legacy = parseBundle(gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')));

    expect(preMaterializeRebuildReason(legacy)).toBeNull();
    expect(verifyBundleSignature(legacy, [])).toEqual({ status: 'unsigned' });
    expect(legacy.manifest.sourceTreeState ?? 'unknown').toBe('unknown');
  });

  it('flags a mismatched index schema version', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    bundle.manifest.schemaVersion = SCHEMA_VERSION + 1;
    expect(preMaterializeRebuildReason(bundle)?.reason).toBe('schema-mismatch');
  });
});

describe('index-bundle: import reads bundled signatures (full-symbol search parity)', () => {
  it('returns the signatures the bundle carries in llm-context.json (so non-function symbols are indexed)', async () => {
    const dir = join(work, 'sig-analysis');
    await mkdir(dir, { recursive: true });
    const signatures = [
      { path: 'src/a.ts', language: 'TypeScript', entries: [{ kind: 'interface', name: 'Widget', signature: 'export interface Widget' }] },
    ];
    await writeFile(join(dir, 'llm-context.json'), JSON.stringify({ callGraph: { nodes: [] }, signatures }));
    expect(await readBundledSignatures(dir)).toEqual(signatures);
  });

  it('degrades to [] when llm-context.json is absent or malformed (never throws)', async () => {
    const dir = join(work, 'sig-missing');
    await mkdir(dir, { recursive: true });
    expect(await readBundledSignatures(dir)).toEqual([]);
    await writeFile(join(dir, 'llm-context.json'), 'not json');
    expect(await readBundledSignatures(dir)).toEqual([]);
  });
});

describe('index-bundle: currencyDecision', () => {
  it('imports as-is when the artifact commit matches HEAD', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', sourceTreeState: 'clean', commitMatchesHead: true, commitIsAncestor: false });
    expect(d.action).toBe('import-current');
  });

  it('rebuilds (never serves stale) when the artifact is built at an ancestor commit', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', sourceTreeState: 'clean', commitMatchesHead: false, commitIsAncestor: true });
    expect(d).toMatchObject({ action: 'rebuild', reason: 'stale' });
  });

  it('rebuilds when the artifact commit is unrelated/diverged', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', sourceTreeState: 'clean', commitMatchesHead: false, commitIsAncestor: false });
    expect(d).toMatchObject({ action: 'rebuild', reason: 'unrelated-commit' });
  });

  it('imports with an UNVERIFIED-currency disclosure when there is no git repo', () => {
    const d = currencyDecision({ isGitRepo: false, sourceCommit: 'abc', sourceTreeState: 'clean', commitMatchesHead: false, commitIsAncestor: false });
    expect(d.action).toBe('import-currency-unknown');
  });

  it('imports with an UNVERIFIED-currency disclosure when the build commit is unknown', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: null, sourceTreeState: 'unknown', commitMatchesHead: false, commitIsAncestor: false });
    expect(d.action).toBe('import-currency-unknown');
  });

  it('downgrades a dirty build even when its commit matches HEAD', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', sourceTreeState: 'dirty', commitMatchesHead: true, commitIsAncestor: false });
    expect(d).toMatchObject({ action: 'import-approximate', reason: 'dirty-build' });
    expect(d.detail).toMatch(/approximately current.*dirty tree/i);
  });

  it('downgrades a clean bundle imported into a dirty checkout', () => {
    const d = currencyDecision({
      isGitRepo: true,
      sourceCommit: 'abc',
      sourceTreeState: 'clean',
      consumerTreeState: 'dirty',
      commitMatchesHead: true,
      commitIsAncestor: false,
    });
    expect(d).toMatchObject({ action: 'import-approximate', reason: 'dirty-consumer' });
  });

  it('treats a legacy missing tree state as unknown, never clean', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', sourceTreeState: 'unknown', commitMatchesHead: true, commitIsAncestor: false });
    expect(d).toMatchObject({ action: 'import-currency-unknown', reason: 'tree-state-unknown' });
  });
});

describe('index-bundle: runImport trust boundary', () => {
  async function gitProject(publicKey?: string): Promise<{ root: string; head: string; analysis: string }> {
    const root = join(work, 'consumer');
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, '.gitignore'), '.openlore/analysis/\n');
    if (publicKey) {
      const config = { ...getDefaultConfig('nodejs', './openspec'), bundle: { trustedSigners: [{ publicKey, label: 'release' }] } };
      await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify(config));
    }
    const runGit = (...args: string[]) => execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root },
    ).toString().trim();
    runGit('init', '-q');
    runGit('add', '.');
    runGit('commit', '-q', '-m', 'fixture');
    return { root, head: runGit('rev-parse', '--verify', 'HEAD'), analysis: join(root, OPENLORE_ANALYSIS_REL_PATH) };
  }

  it('imports an unsigned current bundle with an explicit UNVERIFIED provenance receipt', async () => {
    const project = await gitProject();
    await mkdir(join(project.root, 'openspec', 'specs'), { recursive: true });
    await buildAnalysisDir(project.analysis, project.head);
    const artifact = join(work, 'unsigned.olbundle');
    await writeFile(artifact, (await buildBundle(project.analysis, VERSION)).buffer);
    await rm(project.analysis, { recursive: true, force: true });
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});

    expect(await runImport(artifact, { projectRoot: project.root })).toBe(0);
    expect(success.mock.calls.flat().join(' ')).toMatch(/provenance UNVERIFIED/i);
    expect(await readCurrentGeneration(project.analysis, [...REQUIRED_ANALYSIS_ARTIFACTS])).not.toBeNull();
    expect(existsSync(join(project.analysis, 'vector-index', 'bm25-corpus.json'))).toBe(true);
  });

  it('rejects an oversized compressed artifact before reading it into memory', async () => {
    const artifact = join(work, 'oversized.olbundle');
    const handle = await open(artifact, 'w');
    try {
      await handle.truncate(BUNDLE_MAX_COMPRESSED_BYTES + 1);
    } finally {
      await handle.close();
    }
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});

    expect(await runImport(artifact, { projectRoot: work })).toBe(2);
    expect(error.mock.calls.flat().join(' ')).toMatch(/compressed bundle size cap/i);
  });

  it('rejects signed manifest tampering before promotion or rebuild', async () => {
    const keys = ed25519PemPair();
    const project = await gitProject(keys.publicKey);
    await buildAnalysisDir(project.analysis, project.head);
    const signed = parseBundle((await buildBundle(project.analysis, VERSION, { signingKey: keys.privateKey })).buffer);
    signed.manifest.sourceCommit = '0'.repeat(40);
    const artifact = join(work, 'tampered.olbundle');
    await writeFile(artifact, gzipSync(Buffer.from(JSON.stringify(signed))));
    const sentinel = join(project.analysis, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged');
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    expect(await runImport(artifact, { projectRoot: project.root })).toBe(2);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });

  it('keeps verified provenance separate from dirty-build currency', async () => {
    const keys = ed25519PemPair();
    const project = await gitProject(keys.publicKey);
    await buildAnalysisDir(project.analysis, project.head, 'dirty');
    const artifact = join(work, 'dirty-signed.olbundle');
    await writeFile(
      artifact,
      (await buildBundle(project.analysis, VERSION, { signingKey: keys.privateKey })).buffer,
    );
    await rm(project.analysis, { recursive: true, force: true });
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});

    expect(await runImport(artifact, { projectRoot: project.root })).toBe(0);
    expect(success.mock.calls.flat().join(' ')).toMatch(/provenance verified/i);
    expect(warning.mock.calls.flat().join(' ')).toMatch(/approximately current.*dirty tree/i);
  });

  it('certifies imported-local-structural answers after integrity, trust, and source binding', async () => {
    const keys = ed25519PemPair();
    const producer = join(work, 'structural-producer');
    const consumer = join(work, 'structural-consumer');
    const files = {
      'src/pipeline.ts': [
        'export function receive(raw: string): number {',
        '  return normalize(raw);',
        '}',
        'function normalize(raw: string): number {',
        '  return persist(raw.trim());',
        '}',
        'function persist(value: string): number {',
        '  return value.length;',
        '}',
        '',
      ].join('\n'),
    } as const;
    await mkdir(join(producer, '.openlore'), { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(join(producer, relativePath, '..'), { recursive: true });
      await writeFile(join(producer, relativePath), content);
    }
    await writeFile(join(producer, '.gitignore'), '.openlore/analysis/\n');
    const config = {
      ...getDefaultConfig('nodejs', './openspec'),
      bundle: { trustedSigners: [{ publicKey: keys.publicKey, label: 'equivalence-fixture' }] },
    };
    await writeFile(join(producer, '.openlore', 'config.json'), JSON.stringify(config));
    const git = (cwd: string, ...args: string[]) => execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
      { cwd },
    ).toString().trim();
    git(producer, 'init', '-q');
    git(producer, 'add', '.');
    git(producer, 'commit', '-q', '-m', 'structural fixture');
    const head = git(producer, 'rev-parse', '--verify', 'HEAD');
    const producerAnalysis = await buildStructuralAnalysis(producer, files, head);

    const localSubgraph = await handleGetSubgraph(producer, 'receive', 'downstream', 2);
    const localImpact = await handleAnalyzeImpact(producer, 'receive', 2);
    expect(localSubgraph).toMatchObject({ stats: { nodes: 3, edges: 2 } });
    expect(localImpact).toMatchObject({ blastRadius: { downstream: 2 } });

    const artifact = join(work, 'structural.olbundle');
    const builtBundle = await buildBundle(producerAnalysis, VERSION, { signingKey: keys.privateKey });
    await writeFile(artifact, builtBundle.buffer);
    const parsed = parseBundle(builtBundle.buffer);

    // These are production gates, asserted before any imported answer is queried.
    expect(verifyPayloadIntegrity(parsed)).toBe(true);
    expect(verifyBundledSourceIdentity(parsed)).toBe(true);
    expect(parsed.manifest).toMatchObject({ sourceCommit: head, sourceTreeState: 'clean' });
    expect(verifyBundleSignature(parsed, config.bundle.trustedSigners)).toMatchObject({
      status: 'verified',
      label: 'equivalence-fixture',
    });

    execFileSync('git', ['clone', '-q', producer, consumer]);
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    expect(await runImport(artifact, { projectRoot: consumer })).toBe(0);
    expect(success.mock.calls.flat().join(' ')).toMatch(/provenance verified/i);
    expect(info.mock.calls.flat().join(' ')).toMatch(/Current at commit/);
    expect(git(consumer, 'rev-parse', '--verify', 'HEAD')).toBe(head);

    const importedSubgraph = await handleGetSubgraph(consumer, 'receive', 'downstream', 2);
    const importedImpact = await handleAnalyzeImpact(consumer, 'receive', 2);
    expect(semanticAnswerBytes(importedSubgraph)).toBe(semanticAnswerBytes(localSubgraph));
    expect(semanticAnswerBytes(importedImpact)).toBe(semanticAnswerBytes(localImpact));
  });
});
