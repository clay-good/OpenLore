/**
 * change_impact_certificate (change: add-change-impact-certificate).
 *
 * The differential core (newly-opened-path detection) and surface resolution are
 * pure over a synthetic call graph + edge delta, so they are tested exhaustively
 * here without disk. Decay (the freshness lease) and the spec-store health-check
 * re-fire are tested against a REAL on-disk edge store + source file — the same
 * fixture style as decisions-anchoring.test.ts — so a fresh→stale transition is
 * exercised through the actual anchor engine, not a mock. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSurfaces,
  surfacesFromConfig,
  detectNewlyOpenedPaths,
  computeEdgeDelta,
  collectChangedFiles,
  persistCertificate,
  recheckCertificate,
  recheckPersistedCertificates,
  type ImpactCertificate,
  type NewlyOpenedPath,
} from './impact-certificate.js';
import { triggeredBlockSeverities } from '../../../cli/commands/impact-certificate.js';
import { assertConclusionShape } from './tool-contract.js';
import { TOOL_OUTPUT_CLASS } from './tool-contract.js';
import { handleSpecStoreStatus } from './spec-store.js';
import { dispatchTool } from '../tool-dispatch.js';
import { EdgeStore } from '../edge-store.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import { addRepo } from '../../federation/registry.js';
import {
  OPENLORE_DIR,
  OPENLORE_CONFIG_FILENAME,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_FINGERPRINT,
} from '../../../constants.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';
import type { CoveringSurfaceConfig, StructuralAnchor } from '../../../types/index.js';

// ── synthetic-graph helpers (mirrors blast-radius.test.ts) ─────────────────────
function node(id: string, over: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id,
    name: over.name ?? id.split('::')[1] ?? id,
    filePath: over.filePath ?? id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function edge(callerId: string, calleeId: string, calleeName?: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeName ?? calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind: 'calls' };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
}

// ── 1. surface resolution ──────────────────────────────────────────────────────
describe('resolveSurfaces', () => {
  const cg = graph(
    [node('src/client.ts::send'), node('src/client.ts::open'), node('src/util.ts::log'), node('src/util.ts::log', { id: 'src/other.ts::log', filePath: 'src/other.ts' })],
    [],
  );

  it('resolves a surface declared by file + symbol to the expected id set', () => {
    const surfaces: CoveringSurfaceConfig[] = [
      { name: 'client', severity: 'critical', members: [{ file: 'src/client.ts' }, { symbol: 'send' }] },
    ];
    const { resolved, views, findings } = resolveSurfaces(surfaces, cg);
    // send + open from the file; send again from the symbol member (deduped by Set).
    expect([...resolved[0].ids].sort()).toEqual(['src/client.ts::open', 'src/client.ts::send']);
    expect(resolved[0].severity).toBe('critical');
    expect(views[0].resolvedSymbols).toBe(2);
    expect(findings).toHaveLength(0);
  });

  it('resolves BOTH symbol and file when a single member declares both', () => {
    const { resolved } = resolveSurfaces(
      [{ name: 'mix', severity: 'critical', members: [{ symbol: 'send', file: 'src/util.ts' }] }],
      cg,
    );
    // send (the symbol) + util.ts::log (the file) — the file is not silently dropped.
    expect([...resolved[0].ids].sort()).toEqual(['src/client.ts::send', 'src/util.ts::log']);
  });

  it('degrades an unresolved symbol member to exactly one finding (never throws)', () => {
    const { findings, views } = resolveSurfaces(
      [{ name: 'client', members: [{ symbol: 'doesNotExist' }] }],
      cg,
    );
    const unresolved = findings.filter(f => f.code === 'surface-unresolved-member');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].subject).toBe('client:doesNotExist');
    // zero resolved → also a surface-empty finding; default severity is warn.
    expect(findings.some(f => f.code === 'surface-empty')).toBe(true);
    expect(views[0].unresolvedMembers).toEqual(['doesNotExist']);
  });

  it('treats an ambiguous symbol (>1 match) as unresolved — never guesses', () => {
    const { findings, resolved } = resolveSurfaces(
      [{ name: 'logs', members: [{ symbol: 'log' }] }],
      cg,
    );
    expect(findings.some(f => f.code === 'surface-unresolved-member' && /ambiguous/.test(f.message))).toBe(true);
    expect(resolved[0].ids.size).toBe(0);
  });
});

describe('surfacesFromConfig', () => {
  it('keeps well-formed surfaces and drops wrong-typed entries (no throw)', () => {
    const out = surfacesFromConfig({
      surfaces: [
        { name: 'ok', members: [{ symbol: 'x' }] },
        // wrong-typed entries the JSON could carry:
        { name: 123 as unknown as string, members: [] },
        { name: 'no-members', members: 'oops' as unknown as [] },
      ],
    });
    expect(out.map(s => s.name)).toEqual(['ok']);
  });
  it('returns [] for absent or non-array config', () => {
    expect(surfacesFromConfig(undefined)).toEqual([]);
    expect(surfacesFromConfig({ surfaces: 'nope' as unknown as [] })).toEqual([]);
  });
  it('coerces a wrong-typed severity to "warn" (else highestSurfaceSeverity goes NaN/undefined)', () => {
    const out = surfacesFromConfig({ surfaces: [{ name: 's', severity: 'high' as never, members: [{ symbol: 'x' }] }] });
    expect(out[0].severity).toBe('warn');
    const valid = surfacesFromConfig({ surfaces: [{ name: 'c', severity: 'critical', members: [{ symbol: 'x' }] }] });
    expect(valid[0].severity).toBe('critical');
  });
  it('drops duplicate surface names (they would collide in the per-surface findings map)', () => {
    const out = surfacesFromConfig({ surfaces: [
      { name: 'dup', severity: 'critical', members: [{ symbol: 'a' }] },
      { name: 'dup', severity: 'info', members: [{ symbol: 'b' }] },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical'); // first wins
  });
  it('drops empty / whitespace-only surface names', () => {
    const out = surfacesFromConfig({ surfaces: [
      { name: '   ', members: [{ symbol: 'a' }] },
      { name: 'real', members: [{ symbol: 'b' }] },
    ] });
    expect(out.map(s => s.name)).toEqual(['real']);
  });
  it('drops non-object members (null/string/number) that would crash resolveSurfaces', () => {
    // Members arrive via raw JSON.parse; a `null` element passes the Array.isArray
    // check but would throw at resolveSurfaces' `m.symbol` access — a no-throw violation.
    const out = surfacesFromConfig({ surfaces: [
      { name: 's', members: [null, 'str', 42, { symbol: 'keep' }] as never, severity: 'warn' },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].members).toEqual([{ symbol: 'keep' }]);
  });
});

// ── 2. newly-opened-path detection (the differential core) ─────────────────────
describe('detectNewlyOpenedPaths', () => {
  const A = 'src/a.ts::A', B = 'src/b.ts::B', S = 'src/surface.ts::surfaceFn', C = 'src/c.ts::C';
  // Base graph: B already reaches the surface (B → surfaceFn); A and C do not.
  const cg = graph([node(A), node(B), node(S), node(C)], [edge(B, S)]);
  const surfaces = [{ name: 'client', severity: 'critical' as const, ids: new Set([S]) }];

  it('reports exactly the path a 2-hop opening edge creates, naming the shortest path', () => {
    const out = detectNewlyOpenedPaths(cg, surfaces, { added: [{ from: A, to: B }], removed: [], unresolved: [] });
    expect(out).toHaveLength(1);
    const p = out[0];
    expect(p.surface).toBe('client');
    expect(p.path).toEqual(['A', 'B', 'surfaceFn']);
    expect(p.openingEdge).toEqual({ from: 'A', to: 'B' });
    expect(p.reaches).toBe('surfaceFn');
  });

  it('reports a direct opening edge into a surface member', () => {
    const out = detectNewlyOpenedPaths(cg, surfaces, { added: [{ from: A, to: S }], removed: [], unresolved: [] });
    expect(out).toHaveLength(1);
    expect(out[0].path).toEqual(['A', 'surfaceFn']);
  });

  it('reports nothing when the change touches only an existing caller of the surface', () => {
    // B already reaches the surface; an added edge B → C (C reaches nothing) opens no path.
    const out = detectNewlyOpenedPaths(cg, surfaces, { added: [{ from: B, to: C }], removed: [], unresolved: [] });
    expect(out).toEqual([]);
  });

  it('reports nothing when a caller that ALREADY reaches the surface gains a new edge', () => {
    // A → B → surfaceFn AND C → surfaceFn both exist; A already reaches the surface.
    // Adding A → C opens no NEW reach because A could already reach it (via B).
    const cg2 = graph([node(A), node(B), node(S), node(C)], [edge(A, B), edge(B, S), edge(C, S)]);
    const out = detectNewlyOpenedPaths(cg2, surfaces, { added: [{ from: A, to: C }], removed: [], unresolved: [] });
    expect(out).toEqual([]);
  });

  it('reports nothing for an empty diff', () => {
    expect(detectNewlyOpenedPaths(cg, surfaces, { added: [], removed: [], unresolved: [] })).toEqual([]);
  });
});

// ── 3. advisory posture / block gate ──────────────────────────────────────────
describe('triggeredBlockSeverities', () => {
  const cert = (paths: NewlyOpenedPath[]): ImpactCertificate => ({
    kind: 'impact-certificate', version: 1, baseRef: 'HEAD', resolvedBaseRef: 'HEAD', change: 'working-tree',
    changed: { files: 1, symbols: 1 }, surfaces: [], newlyOpenedPaths: paths,
    impact: { unavailable: 'x' }, tests: { unavailable: 'x' }, specs: { unavailable: 'x' },
    lease: { anchors: [] }, findings: [], highestSurfaceSeverity: 'none', posture: 'advisory', caveats: [], headline: '',
  });
  const crit: NewlyOpenedPath = { surface: 'client', surfaceSeverity: 'critical', openingEdge: { from: 'A', to: 'B' }, path: ['A', 'B'], reaches: 'B' };
  const warn: NewlyOpenedPath = { surface: 'logs', surfaceSeverity: 'warn', openingEdge: { from: 'A', to: 'L' }, path: ['A', 'L'], reaches: 'L' };

  it('fires only on a configured severity', () => {
    expect(triggeredBlockSeverities(cert([crit]), ['critical'])).toEqual(['critical']);
    expect(triggeredBlockSeverities(cert([warn]), ['critical'])).toEqual([]);
  });
  it('is advisory (empty) when nothing is configured to block', () => {
    expect(triggeredBlockSeverities(cert([crit]), [])).toEqual([]);
  });
});

// ── 4. contract classification + conclusion shape ──────────────────────────────
describe('contract', () => {
  it('is classified conclusion and a full certificate passes assertConclusionShape', () => {
    expect(TOOL_OUTPUT_CLASS['change_impact_certificate']).toBe('conclusion');
    const cert: ImpactCertificate = {
      kind: 'impact-certificate', version: 1, baseRef: 'HEAD', resolvedBaseRef: 'HEAD', change: 'add-x',
      changed: { files: 2, symbols: 4 },
      surfaces: [{ name: 'client', severity: 'critical', resolvedSymbols: 3, unresolvedMembers: [] }],
      newlyOpenedPaths: [{ surface: 'client', surfaceSeverity: 'critical', openingEdge: { from: 'A', to: 'B' }, path: ['A', 'B', 'send'], reaches: 'send' }],
      impact: { highestRiskLevel: 'high', maxAffectedCallers: 4, hubsTouched: [], layersCrossed: [], governingDecisions: [], governingDecisionProvenance: [], topSymbols: [], analyzedSymbolCount: 1 },
      tests: { count: 2, toRun: [], soundness: {} },
      specs: { willGoStale: 1, items: [] },
      lease: { anchors: [{ nodeId: 'src/a.ts::A', filePath: 'src/a.ts', contentHash: 'abc' }] },
      findings: [], highestSurfaceSeverity: 'critical', posture: 'advisory', caveats: [], headline: 'x',
    };
    expect(() => assertConclusionShape('change_impact_certificate', cert)).not.toThrow();
  });

  it('dispatchTool(change_impact_certificate) resolves to a conclusion-shaped result (MCP path)', async () => {
    // No analysis in this temp dir → the tool returns a conclusion-shaped {error},
    // never rejects. Mirrors the spec-store / working-set dispatch reachability tests.
    const dir = mkdtempSync(join(tmpdir(), 'impactcert-dispatch-'));
    try {
      const result = await dispatchTool('change_impact_certificate', { directory: dir }, dir);
      expect(() => assertConclusionShape('change_impact_certificate', result)).not.toThrow();
      expect(result).toHaveProperty('error'); // no analysis → unavailable, advisory
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 5 & 6. decay via the freshness lease + health-check re-fire ─────────────────
describe('certificate decay (freshness lease)', () => {
  let root: string;
  const SRC_FRESH = 'export function send() {\n  return 1;\n}\nexport function open() {}\n';
  const SRC_EDITED = 'export function send() {\n  return 999; // body changed\n}\nexport function open() {}\n';

  function buildStore(rootPath: string, src: string): void {
    writeFileSync(join(rootPath, 'src', 'client.ts'), src, 'utf-8');
    const dir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    mkdirSync(dir, { recursive: true });
    const store = EdgeStore.open(EdgeStore.dbPath(dir));
    store.clearAll();
    store.insertNodes([
      node('src/client.ts::send', { startIndex: 0, endIndex: src.indexOf('}') + 1 }),
      node('src/client.ts::open', { startIndex: src.indexOf('export function open'), endIndex: src.length }),
    ]);
    store.close();
  }

  /** Anchor to send() using the real anchor engine, then make a minimal certificate. */
  function makeCertFor(rootPath: string, change: string): ImpactCertificate {
    const ctx = AnchorContext.open(rootPath)!;
    let anchors: StructuralAnchor[];
    try { anchors = ctx.anchorNodesForFiles(['src/client.ts']).map(n => ({ nodeId: n.id, symbolName: n.name, filePath: n.filePath, contentHash: n.contentHash, ...(n.stableId ? { stableId: n.stableId } : {}) })); }
    finally { ctx.close(); }
    return {
      kind: 'impact-certificate', version: 1, baseRef: 'HEAD', resolvedBaseRef: 'HEAD', change,
      changed: { files: 1, symbols: anchors.length }, surfaces: [], newlyOpenedPaths: [],
      impact: { unavailable: 'n/a' }, tests: { unavailable: 'n/a' }, specs: { unavailable: 'n/a' },
      lease: { anchors }, findings: [], highestSurfaceSeverity: 'none', posture: 'advisory', caveats: [], headline: '',
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'impactcert-'));
    mkdirSync(join(root, 'src'), { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a FILE-level anchor (as built for a new/unindexed file) decays when the file changes', () => {
    // New files have no indexed symbol, so buildLeaseAnchors anchors them at file level.
    // Verify that mechanism decays: a file anchor is fresh, then stale once the file moves.
    buildStore(root, SRC_FRESH);
    const fileAnchor: StructuralAnchor = { filePath: 'src/client.ts', contentHash: '' };
    // Capture the current file hash via a real cert build is overkill; compute fresh by reading.
    const ctx = AnchorContext.open(root)!;
    try { fileAnchor.contentHash = ctx.fileContentHash('src/client.ts'); } finally { ctx.close(); }
    const cert: ImpactCertificate = { ...makeBareCert('add-file'), lease: { anchors: [fileAnchor] } };
    expect(recheckCertificate(root, cert).status).toBe('fresh');
    writeFileSync(join(root, 'src', 'client.ts'), SRC_EDITED, 'utf-8'); // file content changes
    expect(recheckCertificate(root, cert).status).toBe('stale');
  });

  it('a certificate is fresh against the graph it was computed against, and stale after an anchored symbol changes', () => {
    buildStore(root, SRC_FRESH);
    const cert = makeCertFor(root, 'add-x');
    expect(cert.lease.anchors.length).toBeGreaterThan(0);
    expect(recheckCertificate(root, cert).status).toBe('fresh');

    // Edit the anchored symbol's body → its content hash changes → drifted → stale.
    buildStore(root, SRC_EDITED);
    const after = recheckCertificate(root, cert);
    expect(after.status).toBe('stale');
    expect(after.movedAnchors.some(m => m.subject === 'send')).toBe(true);
  });

  it('treats a certificate as stale when there is no graph to verify it against (never silently current)', () => {
    // No edge store built → AnchorContext.open returns null.
    const cert: ImpactCertificate = makeBareCert('add-y');
    expect(recheckCertificate(root, cert).status).toBe('stale');
  });

  it('persists, re-reads, and gates: recheckPersistedCertificates returns [] with no dir, finds the stale one after', () => {
    buildStore(root, SRC_FRESH);
    const certDir = join(root, OPENLORE_DIR, 'impact-certificates');
    expect(existsSync(certDir)).toBe(false);
    expect(recheckPersistedCertificates(root)).toEqual([]); // cheap gate: no dir

    const cert = makeCertFor(root, 'add-x');
    persistCertificate(root, cert);
    expect(existsSync(certDir)).toBe(true);
    expect(recheckPersistedCertificates(root)).toEqual([]); // fresh → nothing to re-fire

    buildStore(root, SRC_EDITED); // anchored symbol moved
    const stale = recheckPersistedCertificates(root);
    expect(stale.map(s => s.change)).toEqual(['add-x']);
  });

  function makeBareCert(change: string): ImpactCertificate {
    return {
      kind: 'impact-certificate', version: 1, baseRef: 'HEAD', resolvedBaseRef: 'HEAD', change,
      changed: { files: 1, symbols: 1 }, surfaces: [], newlyOpenedPaths: [],
      impact: { unavailable: 'n/a' }, tests: { unavailable: 'n/a' }, specs: { unavailable: 'n/a' },
      lease: { anchors: [{ nodeId: 'src/client.ts::send', symbolName: 'send', filePath: 'src/client.ts', contentHash: 'deadbeef' }] },
      findings: [], highestSurfaceSeverity: 'none', posture: 'advisory', caveats: [], headline: '',
    };
  }

  it('the spec-store health check surfaces a stale certificate in an indexed target as a re-fire finding', async () => {
    // Home repo with a spec-store binding to one target; target is indexed + carries a cert.
    const scratch = mkdtempSync(join(tmpdir(), 'impactcert-fed-'));
    try {
      const home = join(scratch, 'home');
      const target = join(scratch, 'app');
      mkdirSync(join(home, OPENLORE_DIR), { recursive: true });
      mkdirSync(join(target, 'src'), { recursive: true });

      // Build the target's real index (edge store) + fingerprint so it resolves "indexed".
      buildStore(target, SRC_FRESH);
      const fp = 'fp-deadbeef';
      mkdirSync(join(target, OPENLORE_ANALYSIS_REL_PATH), { recursive: true });
      writeFileSync(join(target, OPENLORE_ANALYSIS_REL_PATH, ARTIFACT_FINGERPRINT), JSON.stringify({ hash: fp }));

      // Register the target in the home repo's federation registry, then bind the store.
      addRepo(home, target, { name: 'app' });
      mkdirSync(join(scratch, 'store'), { recursive: true });
      writeFileSync(join(home, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME), JSON.stringify({
        version: '1.0.0', projectType: 'library', openspecPath: 'openspec',
        analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
        generation: { model: 'x', domains: 'auto' }, createdAt: new Date().toISOString(), lastRun: null,
        specStore: { name: 'plans', path: join(scratch, 'store'), targets: ['app'] },
      }));

      // A fresh certificate in the target → no certificate-stale finding.
      persistCertificate(target, makeCertFor(target, 'add-x'));
      let status = await handleSpecStoreStatus(home);
      // The cert re-fire only runs for targets resolved as indexed; assert that holds here.
      expect(status.targets.find(t => t.name === 'app')?.state).toBe('indexed');
      expect(status.findings.some(f => f.code === 'certificate-stale')).toBe(false);

      // Now move the anchored symbol → the persisted certificate decays, and the
      // health check surfaces it as a finding to re-fire (never silently still-true).
      buildStore(target, SRC_EDITED);
      status = await handleSpecStoreStatus(home);
      const stale = status.findings.filter(f => f.code === 'certificate-stale');
      expect(stale).toHaveLength(1);
      expect(stale[0].subject).toBe('app:add-x');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a corrupt persisted certificate / wrong-typed lease never throws (no-throw contract)', () => {
    // recheckCertificate must be conservative-but-safe even on a malformed cert.
    const bad = { ...makeBareCert('add-z'), lease: { anchors: 'not-an-array' as unknown as [] } } as ImpactCertificate;
    expect(() => recheckCertificate(root, bad)).not.toThrow();
    expect(recheckCertificate(root, bad).change).toBe('add-z');

    // A non-JSON file in the certs dir is skipped, not thrown on.
    const dir = join(root, OPENLORE_DIR, 'impact-certificates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'garbage.json'), '{ not valid json', 'utf-8');
    expect(() => recheckPersistedCertificates(root)).not.toThrow();
    expect(recheckPersistedCertificates(root)).toEqual([]);
  });
});

// ── 7. diff plumbing — renames + untracked files (regression: PR #181 review) ──
// Both bugs were reproduced e2e: a pure rename reported a false newly-opened path,
// and a brand-new untracked file opening a surface was missed entirely. These pin
// the fix against a REAL temp git repo + the real CallGraphBuilder snapshot.
describe('changed-file plumbing (rename + untracked)', () => {
  let repo: string;
  const SURFACE = 'src/lib.ts::surfaceFn';
  const CALLER = 'src/caller.ts::caller';

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  function write(rel: string, content: string): void {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), content, 'utf-8');
  }
  // Synthetic canonical graph: caller → surfaceFn already exists at HEAD.
  const cg = graph([node(SURFACE), node(CALLER)], [edge(CALLER, SURFACE, 'surfaceFn')]);
  const surfaces = [{ name: 'lib', severity: 'critical' as const, ids: new Set([SURFACE]) }];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'impactcert-git-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('src/lib.ts', 'export function surfaceFn() { return 1; }\n');
    write('src/caller.ts', 'export function caller() { return surfaceFn(); }\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('a pure rename (calls unchanged) opens NO new path — old content read from oldPath', async () => {
    git('mv', 'src/caller.ts', 'src/caller_renamed.ts');
    const entries = await collectChangedFiles(repo, 'HEAD');
    const renamed = entries.find(e => e.path === 'src/caller_renamed.ts');
    expect(renamed?.status).toBe('renamed');
    expect(renamed?.oldPath).toBe('src/caller.ts');

    const delta = await computeEdgeDelta(repo, 'HEAD', entries, cg);
    // caller → surfaceFn existed before and after the rename → NOT an added edge.
    expect(delta.added).toEqual([]);
    expect(detectNewlyOpenedPaths(cg, surfaces, delta)).toEqual([]);
  });

  it('a brand-new UNTRACKED file that opens a surface is detected (folded in via ls-files)', async () => {
    write('src/newcaller.ts', 'export function newCaller() { return surfaceFn(); }\n');
    // Deliberately NOT git-added — it is untracked.
    const entries = await collectChangedFiles(repo, 'HEAD');
    const untracked = entries.find(e => e.path === 'src/newcaller.ts');
    expect(untracked?.status).toBe('added');

    const delta = await computeEdgeDelta(repo, 'HEAD', entries, cg);
    expect(delta.added).toContainEqual({ from: 'src/newcaller.ts::newCaller', to: SURFACE });
    const opened = detectNewlyOpenedPaths(cg, surfaces, delta);
    expect(opened).toHaveLength(1);
    expect(opened[0].openingEdge).toEqual({ from: 'newCaller', to: 'surfaceFn' });
    expect(opened[0].surfaceSeverity).toBe('critical');
  });

  it('an in-place edit that adds a call into the surface is detected; one that does not opens nothing', async () => {
    // Add a NEW caller in an existing tracked file → newly-opened.
    write('src/lib.ts', 'export function surfaceFn() { return 1; }\nexport function sneaky() { return surfaceFn(); }\n');
    const entries = await collectChangedFiles(repo, 'HEAD');
    const delta = await computeEdgeDelta(repo, 'HEAD', entries, cg);
    // sneaky → surfaceFn is a new edge; sneaky is not in the canonical cg, so it
    // resolves to its snapshot id. surfaceFn resolves to the canonical surface id.
    expect(delta.added.some(e => e.to === SURFACE)).toBe(true);
    expect(detectNewlyOpenedPaths(cg, surfaces, delta).length).toBeGreaterThanOrEqual(1);
  });

  it('a LOCAL helper sharing a surface symbol name does NOT phantom-open the surface (homonym)', async () => {
    // Canonical surface symbol `surfaceFn` lives in src/lib.ts. A changed file defines a
    // DIFFERENT local `surfaceFn` (at base) and now ADDS a caller of it. The added call
    // binds to the local def, so it must NOT be reported as a new path into the canonical
    // surface — the bug was that name-based resolution mapped it to the canonical surface.
    write('src/helpers.ts', 'function surfaceFn() { return 99; }\nexport function unused() { return 0; }\n');
    git('add', '-A'); git('commit', '-q', '-m', 'helpers-with-local-homonym');
    // THIS diff adds a caller of the LOCAL surfaceFn:
    write('src/helpers.ts', 'function surfaceFn() { return 99; }\nexport function localCheck() { return surfaceFn(); }\n');
    const entries = await collectChangedFiles(repo, 'HEAD');
    const delta = await computeEdgeDelta(repo, 'HEAD', entries, cg);
    // The added edge resolves to the LOCAL id, never the canonical surface.
    expect(delta.added.some(e => e.to === SURFACE)).toBe(false);
    expect(delta.added).toContainEqual({ from: 'src/helpers.ts::localCheck', to: 'src/helpers.ts::surfaceFn' });
    expect(detectNewlyOpenedPaths(cg, surfaces, delta)).toEqual([]);
  });

  it('a surface member ADDED in the same diff still resolves and its opening is detected', async () => {
    // A brand-new file defines `boundary` (declared as the surface) AND a caller that
    // reaches it. `boundary` is absent from the canonical cg, so resolution must use
    // the post-change snapshot nodes — else the critical opening is silently missed.
    write('src/newsurface.ts', 'export function boundary() { return 1; }\nexport function reachIt() { return boundary(); }\n');
    const entries = await collectChangedFiles(repo, 'HEAD');
    const delta = await computeEdgeDelta(repo, 'HEAD', entries, cg);
    // Resolve the surface over canonical ∪ post-change nodes.
    const { resolved } = resolveSurfaces(
      [{ name: 'newbound', severity: 'critical', members: [{ symbol: 'boundary' }] }],
      cg, delta.postNodes,
    );
    expect(resolved[0].ids.size).toBe(1); // resolved via postNodes
    const opened = detectNewlyOpenedPaths(cg, resolved, delta, delta.postNodes);
    expect(opened).toHaveLength(1);
    expect(opened[0].openingEdge).toEqual({ from: 'reachIt', to: 'boundary' });
  });

  it('reads old content from the MERGE-BASE, not the base-ref tip, when the base branch advanced', async () => {
    // base: caller does NOT call surfaceFn. Branch off, then BOTH branch and base add the
    // same call. getChangedFiles diffs vs the merge-base (three-dot), so the differential
    // must read old content from the merge-base too — reading the base-ref TIP (which now
    // has the call) would MISS the opening the branch genuinely introduced.
    const base = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString().trim();
    write('src/caller.ts', 'export function caller() { return 0; }\n'); // base: no call
    git('add', '-A'); git('commit', '-q', '-m', 'base-no-call');
    git('branch', 'feature');
    // the base branch advances: it ALSO adds the call (so its tip no longer matches the merge-base)
    write('src/caller.ts', 'export function caller() { return surfaceFn(); }\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base-adds-call');
    // feature adds the call independently — this is the change under assessment
    git('checkout', '-q', 'feature');
    write('src/caller.ts', 'export function caller() { return surfaceFn(); }\n');
    git('add', '-A'); git('commit', '-q', '-m', 'feature-adds-call');

    const entries = await collectChangedFiles(repo, base);
    const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: repo }).toString().trim();

    // Correct (merge-base): old caller had no call → the edge is newly added → opening detected.
    const good = await computeEdgeDelta(repo, mergeBase, entries, cg);
    expect(good.added).toContainEqual({ from: 'src/caller.ts::caller', to: SURFACE });
    expect(detectNewlyOpenedPaths(cg, surfaces, good)).toHaveLength(1);

    // Buggy baseline (the ref TIP) would read the base branch's caller — which already calls
    // surfaceFn — so the edge looks pre-existing and the real opening is MISSED. Pin the divergence.
    const bad = await computeEdgeDelta(repo, base, entries, cg);
    expect(bad.added.some(e => e.to === SURFACE)).toBe(false);
  });
});
