import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
} from './index-bundle.js';
import { gzipSync } from 'node:zlib';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  preMaterializeRebuildReason,
  currencyDecision,
  readBundledSignatures,
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

  it('writes the artifact into a not-yet-existing --out directory (creates parents, no ENOENT)', async () => {
    const projectRoot = join(work, 'proj');
    await buildAnalysisDir(join(projectRoot, OPENLORE_ANALYSIS_REL_PATH), 'abc1234');
    const out = join(work, 'nested', 'deep', 'index-bundle.olbundle');
    expect(existsSync(out)).toBe(false);
    const code = await runBundleExport({ out, projectRoot });
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
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

    await promoteStagedIndex(bundle, staging, live);

    expect(existsSync(join(live, 'vector-index'))).toBe(false);     // orphan dir cleared
    expect(existsSync(join(live, 'text-line-index'))).toBe(false);  // orphan dir cleared
    expect(existsSync(join(live, 'vector-index-meta.json'))).toBe(false); // stale meta cleared
    expect(existsSync(join(live, ARTIFACT_CALL_GRAPH_DB))).toBe(true);    // bundle files promoted
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
