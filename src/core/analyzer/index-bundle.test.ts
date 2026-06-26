import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore, SCHEMA_VERSION } from '../services/edge-store.js';
import { ARTIFACT_CALL_GRAPH_DB, ARTIFACT_FINGERPRINT } from '../../constants.js';
import { computeAttestation, writeAttestation, reconcile } from './index-attestation.js';
import type { FunctionNode, CallEdge, ClassNode } from './call-graph.js';
import {
  buildBundle,
  parseBundle,
  verifyPayloadIntegrity,
  recomputeProductionDigest,
  materializeBundle,
  BundleError,
  BUNDLE_VERSION,
} from './index-bundle.js';
import {
  preMaterializeRebuildReason,
  currencyDecision,
} from '../../cli/commands/import.js';

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
async function buildAnalysisDir(dir: string, commit: string | null): Promise<void> {
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
  if (commit !== null) {
    await writeFile(join(dir, ARTIFACT_FINGERPRINT), JSON.stringify({ hash: 'h', commit, computedAt: 'x', fileCount: 2 }));
  }
  // A non-graph JSON artifact, to prove the whole index travels (not just the db).
  await writeFile(join(dir, 'repo-structure.json'), JSON.stringify({ layers: ['core'] }));
}

let work: string;
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'olbundle-test-')); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

describe('index-bundle: export', () => {
  it('builds a self-describing bundle with attestation, commit, and a payload manifest', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const { manifest } = await buildBundle(src, VERSION);

    expect(manifest.bundleVersion).toBe(BUNDLE_VERSION);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.sourceCommit).toBe('abc1234');
    expect(manifest.openloreVersion).toBe(VERSION);
    expect(manifest.attestation.committed).toEqual({ files: 2, functions: 3, edges: 2, classes: 1 });
    expect(manifest.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    // call-graph.db + index-attestation.json + fingerprint.json + repo-structure.json
    expect(manifest.files.map(f => f.name).sort()).toContain(ARTIFACT_CALL_GRAPH_DB);
    expect(manifest.files.length).toBe(4);
  });

  it('is byte-stable: exporting the same index twice produces an identical artifact', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const a = await buildBundle(src, VERSION);
    const b = await buildBundle(src, VERSION);
    expect(Buffer.compare(a.buffer, b.buffer)).toBe(0);
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

describe('index-bundle: parse + tamper detection', () => {
  it('rejects a non-bundle buffer as unreadable', () => {
    expect(() => parseBundle(Buffer.from('not a bundle'))).toThrow(BundleError);
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

  it('flags a mismatched index schema version', async () => {
    const src = join(work, 'src-analysis');
    await buildAnalysisDir(src, 'abc1234');
    const bundle = parseBundle((await buildBundle(src, VERSION)).buffer);
    bundle.manifest.schemaVersion = SCHEMA_VERSION + 1;
    expect(preMaterializeRebuildReason(bundle)?.reason).toBe('schema-mismatch');
  });
});

describe('index-bundle: currencyDecision', () => {
  it('imports as-is when the artifact commit matches HEAD', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', commitMatchesHead: true, commitIsAncestor: false });
    expect(d.action).toBe('import-fresh');
  });

  it('rebuilds (never serves stale) when the artifact is built at an ancestor commit', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', commitMatchesHead: false, commitIsAncestor: true });
    expect(d).toMatchObject({ action: 'rebuild', reason: 'stale' });
  });

  it('rebuilds when the artifact commit is unrelated/diverged', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: 'abc', commitMatchesHead: false, commitIsAncestor: false });
    expect(d).toMatchObject({ action: 'rebuild', reason: 'unrelated-commit' });
  });

  it('imports with an UNVERIFIED-currency disclosure when there is no git repo', () => {
    const d = currencyDecision({ isGitRepo: false, sourceCommit: 'abc', commitMatchesHead: false, commitIsAncestor: false });
    expect(d.action).toBe('import-unverified');
  });

  it('imports with an UNVERIFIED-currency disclosure when the build commit is unknown', () => {
    const d = currencyDecision({ isGitRepo: true, sourceCommit: null, commitMatchesHead: false, commitIsAncestor: false });
    expect(d.action).toBe('import-unverified');
  });
});
