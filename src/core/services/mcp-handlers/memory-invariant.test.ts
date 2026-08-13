/**
 * AuthoritativeRecallInvariant — the named, test-enforced brand promise.
 * (change: harden-memory-integrity-invariant)
 *
 * The invariant, verbatim:
 *
 *   No memory whose freshness verdict is `drifted` or `orphaned` ever appears in
 *   an authoritative recall path UNLABELED. An `orphaned` memory is fully withheld
 *   from the authoritative set; a `drifted` memory may remain only when carrying an
 *   explicit `verify` label. The authoritative recall paths are the `recall` tool
 *   and the memory (decision) section of `orient`.
 *
 * This is the operational definition of the project promise — *OpenLore never
 * serves an unverified or stale fact as authoritative* — guarded by a property
 * test that generates arbitrary memories and arbitrary code mutations and asserts
 * the property holds for every generated case.
 *
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// orient gates on "an index exists"; mock only the vector-index surface (orthogonal
// to freshness). Harmless to the recall path, which does not touch it.
vi.mock('../../analyzer/vector-index.js', () => ({
  VectorIndex: {
    exists: vi.fn(() => true),
    search: vi.fn(async () => []),
    keywordMissDiagnostics: vi.fn(async () => ({ missedTokens: [], nearTokens: [] })),
  },
}));
vi.mock('../../analyzer/embedding-service.js', () => ({
  EmbeddingService: { fromEnv: vi.fn(() => { throw new Error('no env'); }), fromConfig: vi.fn(() => null) },
}));
vi.mock('../../analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: { exists: vi.fn(() => false), search: vi.fn(async () => []) },
}));
// The bitemporal valid-time marker is orthogonal to the freshness invariant under
// test, but `handleRemember` reads it by spawning `git rev-parse HEAD` — 600 of
// them across these 120-trial properties, which on a machine with slow process
// spawn is ~90s of pure subprocess overhead and the sole reason this file timed
// out. The fixtures are throwaway temp dirs with no git repo, so HEAD is
// `undefined` here anyway; return it directly and keep the property intact.
vi.mock('../../decisions/git-time.js', () => ({
  getHeadCommit: vi.fn(async () => undefined),
  resolveCommitSha: vi.fn(async () => undefined),
  isAncestor: vi.fn(async () => false),
}));

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT, MEMORY_NOTES_FILE } from '../../../constants.js';
import { memoryDir } from '../../decisions/memory-store.js';
import { handleRemember, handleRecall } from './memory.js';
import { handleOrient } from './orient.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

// ── deterministic PRNG (replayable; no new dependency) ────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FN_COUNT = 5;
const fnName = (k: number) => `fn${k}`;
const fnFile = (k: number) => `src/m${k}.ts`;
const fnSrc = (k: number, body: string) => `export function ${fnName(k)}() {\n  ${body}\n}\n`;

// The fixture root is module-scoped for the helpers below, but each test also
// binds it to a LOCAL const and uses that. A timed-out test's loop keeps running
// (a JS promise cannot be cancelled); reading the shared `root` it would delete
// the NEXT test's fixture mid-run, turning one timeout into a cascade of
// unrelated ENOENT failures. The local binding contains the damage to the test
// that actually failed.
let root: string;
const analysisDirOf = (dir: string) => join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
const ANALYSIS = () => analysisDirOf(root);

function nodeFor(k: number, src: string): FunctionNode {
  return {
    id: `${fnFile(k)}::${fnName(k)}`,
    name: fnName(k),
    filePath: fnFile(k),
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: Buffer.byteLength(src, 'utf-8'),
    fanIn: 0,
    fanOut: 0,
  };
}

async function buildStore(nodes: FunctionNode[], dir: string = root): Promise<void> {
  const analysis = analysisDirOf(dir);
  await mkdir(analysis, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(analysis));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
  // orient also reads the cached call-graph artifact to decide "analysis exists".
  const callGraph = {
    nodes, edges: [], classes: [], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
  await writeFile(join(analysis, ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'openlore-invariant-'));
  await mkdir(join(root, 'src'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

type RecalledItem = { freshness: string; verify?: boolean; kind?: string; id?: string };

/** Assert the invariant against one recall response. */
function assertRecallInvariant(r: {
  authoritative: RecalledItem[];
  needsReanchoring: RecalledItem[];
}, label: string): void {
  for (const item of r.authoritative) {
    // (1) orphaned is NEVER authoritative — fully withheld.
    expect(item.freshness, `${label}: orphaned leaked into authoritative`).not.toBe('orphaned');
    // (2) any non-fresh authoritative entry MUST carry the explicit verify label.
    if (item.freshness !== 'fresh') {
      expect(item.verify, `${label}: unlabeled ${item.freshness} in authoritative`).toBe(true);
    }
  }
  // needsReanchoring holds only orphaned memories.
  for (const item of r.needsReanchoring) {
    expect(item.freshness, `${label}: non-orphaned in needsReanchoring`).toBe('orphaned');
  }
}

describe('AuthoritativeRecallInvariant — recall, property-based over generated mutations', () => {
  it('the authoritative set never contains an orphaned or unlabeled-drifted memory (120 generated cases)', async () => {
    const dir = root;   // see the note on `root`: never touch the next test's fixture
    for (let trial = 0; trial < 120; trial++) {
      const rand = rng(0x1000 + trial);

      // Fresh baseline: every function present and unmodified.
      const baseSrc = Array.from({ length: FN_COUNT }, (_, k) => fnSrc(k, `return ${k};`));
      for (let k = 0; k < FN_COUNT; k++) await writeFile(join(dir, fnFile(k)), baseSrc[k], 'utf-8');
      await buildStore(baseSrc.map((s, k) => nodeFor(k, s)), dir);

      // Anchor one memory per function (plus an occasional unanchored note).
      for (let k = 0; k < FN_COUNT; k++) {
        await handleRemember(dir, `memory about ${fnName(k)} number ${trial}`, [{ symbol: fnName(k), file: fnFile(k) }]);
      }
      if (rand() < 0.5) await handleRemember(dir, `free-floating note ${trial}`);

      // Apply an arbitrary mutation plan: keep / edit-body (→drift) / delete (→orphan).
      const survivors: FunctionNode[] = [];
      for (let k = 0; k < FN_COUNT; k++) {
        const roll = rand();
        if (roll < 0.34) {
          // keep fresh
          survivors.push(nodeFor(k, baseSrc[k]));
        } else if (roll < 0.67) {
          // edit body in place → span hash differs → drifted (node stays in store)
          const edited = fnSrc(k, `return ${k * 100 + trial};`);
          await writeFile(join(dir, fnFile(k)), edited, 'utf-8');
          survivors.push(nodeFor(k, baseSrc[k])); // stale offsets/hash on purpose
        } else if (roll < 0.84) {
          // delete the node from the graph → orphaned
          // (file may or may not remain; symbol-level anchor still orphans)
        } else {
          // delete the whole file too → orphaned
          await rm(join(dir, fnFile(k)), { force: true });
        }
      }
      await buildStore(survivors, dir);

      const r = (await handleRecall(dir, undefined, 50)) as {
        authoritative: RecalledItem[]; needsReanchoring: RecalledItem[];
      };
      assertRecallInvariant(r, `recall trial ${trial}`);

      // Reset for the next trial: clear the source tree and the notes store. The
      // edge store is reset by buildStore's clearAll, so we avoid rm-ing the
      // .openlore dir (which races with the SQLite file handle on some platforms).
      await rm(join(dir, 'src'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      await rm(join(memoryDir(dir), MEMORY_NOTES_FILE), { force: true });
      await mkdir(join(dir, 'src'), { recursive: true });
    }
  }, 60_000);
});

// orient surfaces decisions (not notes); the property mirrors recall over the
// decision store. Decisions are anchored to files via affectedFiles, so a deleted
// file orphans, a changed-symbol anchor drifts, an untouched file stays fresh.
async function writeDecisions(decisions: Array<Record<string, unknown>>, rootDir: string = root): Promise<void> {
  const dir = join(rootDir, OPENLORE_DIR, 'decisions');
  await mkdir(dir, { recursive: true });
  const full = decisions.map((d) => ({
    status: 'approved', title: 'untitled', rationale: '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], sessionId: 's', recordedAt: '2026-01-01T00:00:00Z',
    confidence: 'medium', syncedToSpecs: [], ...d,
  }));
  await writeFile(join(dir, 'pending.json'), JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions: full }), 'utf-8');
}

describe('AuthoritativeRecallInvariant — orient decision section, property-based', () => {
  it('pendingDecisions never lists an orphaned decision; staleDecisions holds only orphaned (120 cases)', async () => {
    const dir = root;   // see the note on `root`
    for (let trial = 0; trial < 120; trial++) {
      const rand = rng(0x2000 + trial);

      const baseSrc = Array.from({ length: FN_COUNT }, (_, k) => fnSrc(k, `return ${k};`));
      for (let k = 0; k < FN_COUNT; k++) await writeFile(join(dir, fnFile(k)), baseSrc[k], 'utf-8');
      await buildStore(baseSrc.map((s, k) => nodeFor(k, s)), dir);

      // One approved decision per function, symbol-anchored to it.
      const decisions = Array.from({ length: FN_COUNT }, (_, k) => ({
        id: `dec${k}`,
        title: `decision about ${fnName(k)}`,
        affectedFiles: [fnFile(k)],
        anchors: [{ nodeId: `${fnFile(k)}::${fnName(k)}`, symbolName: fnName(k), filePath: fnFile(k), contentHash: '__RECORDED__' }],
      }));
      // Capture the real recorded span hash so "keep" stays fresh.
      const { hashSpan } = await import('../../decisions/anchor.js');
      for (let k = 0; k < FN_COUNT; k++) {
        (decisions[k].anchors[0] as { contentHash: string }).contentHash = hashSpan(baseSrc[k]);
      }

      const survivors: FunctionNode[] = [];
      for (let k = 0; k < FN_COUNT; k++) {
        const roll = rand();
        if (roll < 0.34) {
          survivors.push(nodeFor(k, baseSrc[k]));
        } else if (roll < 0.67) {
          // change the symbol → drift (node remains, hash differs)
          const edited = fnSrc(k, `return ${k * 100 + trial};`);
          survivors.push(nodeFor(k, edited));
        } else {
          // delete the node (and sometimes the file) → orphan
          if (roll > 0.84) await rm(join(dir, fnFile(k)), { force: true });
        }
      }
      await buildStore(survivors, dir);
      await writeDecisions(decisions, dir);

      const r = (await handleOrient(dir, `work on ${fnName(0)} ${fnName(1)} ${fnName(2)} ${fnName(3)} ${fnName(4)}`)) as {
        error?: string;
        pendingDecisions?: Array<{ id: string; freshness?: string; verify?: boolean }>;
        staleDecisions?: Array<{ id: string; freshness?: string }>;
      };
      expect(r.error, `orient trial ${trial}`).toBeUndefined();

      for (const d of r.pendingDecisions ?? []) {
        expect(d.freshness, `orient trial ${trial}: orphaned in pendingDecisions`).not.toBe('orphaned');
        if (d.freshness && d.freshness !== 'fresh') {
          expect(d.verify, `orient trial ${trial}: unlabeled ${d.freshness} in pendingDecisions`).toBe(true);
        }
      }
      for (const d of r.staleDecisions ?? []) {
        expect(d.freshness, `orient trial ${trial}: non-orphaned in staleDecisions`).toBe('orphaned');
      }

      // Reset the source tree only; buildStore.clearAll resets the edge store and
      // writeDecisions overwrites pending.json next trial.
      await rm(join(dir, 'src'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      await mkdir(join(dir, 'src'), { recursive: true });
    }
  }, 60_000);
});
