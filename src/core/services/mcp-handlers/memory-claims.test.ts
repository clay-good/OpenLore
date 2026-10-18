/**
 * Memory claim verdicts (change: add-memory-claim-verdicts).
 *
 * A real edge store keeps the memory's anchor fresh; the call graph the claims are checked
 * against is the mocked cached context, so a test can change the graph under an unchanged
 * anchor — the rot this change exists to catch. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils.js')>()),
  readCachedContext: vi.fn(),
}));

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../../constants.js';
import { handleRemember, handleRecall } from './memory.js';
import { readCachedContext } from './utils.js';
import { __resetStalenessMemo } from './confidence-boundary.js';
import { parseClaims, isWellFormedClaim } from './memory-claims.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

let root: string;
const FOO_SRC = 'export function foo() {\n  return 1;\n}\n';

function node(id: string, over: Partial<FunctionNode> = {}): FunctionNode {
  const [filePath, name] = id.split('::');
  return { id, name, filePath, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, ...over };
}
function edge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1], confidence: 'import', kind: 'calls' };
}
function useGraph(nodes: FunctionNode[], edges: CallEdge[]): void {
  const cg: SerializedCallGraph = {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
  vi.mocked(readCachedContext).mockResolvedValue({ callGraph: cg } as never);
}

const MAIN = node('src/main.ts::main', { fanOut: 1 });
const HANDLER = node('src/app.ts::handler', { fanIn: 1 });
const ORPHAN = node('src/dead.ts::orphan');

beforeEach(async () => {
  __resetStalenessMemo();
  root = await mkdtemp(join(tmpdir(), 'openlore-memclaim-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo.ts'), FOO_SRC, 'utf-8');
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.insertNodes([{
    ...node('src/foo.ts::foo'), language: 'typescript', endIndex: Buffer.byteLength(FOO_SRC), startLine: 1, endLine: 3,
  }]);
  store.close();
  useGraph([MAIN, HANDLER, ORPHAN], [edge(MAIN.id, HANDLER.id)]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Check = { kind: string; subject: string; object?: string; verdict: string; reason: string; receipt?: unknown };
type Item = { id: string; freshness: string; claims?: Check[]; verifiedCurrent?: boolean };
type Recall = {
  authoritative: Item[]; needsReanchoring: Item[]; evidenceRefuted?: Item[]; evidenceUnverifiable?: Item[];
  summary: Record<string, number>; note?: string;
};

async function rememberWith(claims: unknown, content = 'orphan is dead; foo may replace it'): Promise<Record<string, unknown>> {
  return await handleRemember(root, content, [{ symbol: 'foo', file: 'src/foo.ts' }], undefined, 'invariant', undefined, undefined, undefined, claims) as Record<string, unknown>;
}

describe('remember with claims', () => {
  it('stores claims that hold now and reports them', async () => {
    const r = await rememberWith([{ kind: 'dead', subject: 'orphan' }, { kind: 'calls', subject: 'main', object: 'handler' }]);
    expect(r.error).toBeUndefined();
    expect(r.claims).toEqual([{ kind: 'dead', subject: 'orphan' }, { kind: 'calls', subject: 'main', object: 'handler' }]);
    const stored = JSON.parse(await readFile(join(root, OPENLORE_DIR, 'memory', 'notes.json'), 'utf-8'));
    expect(stored.memories[0].claims).toHaveLength(2);
  });

  it('refuses a claim that is already false, with the verdicts', async () => {
    const r = await rememberWith([{ kind: 'dead', subject: 'orphan' }, { kind: 'dead', subject: 'handler' }]);
    expect(r.error).toMatch(/1 of 2 claim\(s\) do not hold/);
    const verdicts = r.claimVerdicts as Check[];
    expect(verdicts.map(v => v.verdict)).toEqual(['evidence-holds', 'evidence-refuted']);
    // Nothing was written.
    await expect(readFile(join(root, OPENLORE_DIR, 'memory', 'notes.json'), 'utf-8')).rejects.toThrow();
  });

  it('refuses a claim that cannot be checked', async () => {
    const r = await rememberWith([{ kind: 'dead', subject: 'nosuchsymbol' }]);
    expect(r.error).toMatch(/do not hold/);
    expect((r.claimVerdicts as Check[])[0].verdict).toBe('evidence-unverifiable');
  });

  it('rejects malformed claims before any check', async () => {
    expect((await rememberWith('dead')).error).toMatch(/must be an array/);
    expect((await rememberWith([{ kind: 'owns', subject: 'x' }])).error).toMatch(/claims\[0\]\.kind/);
    expect((await rememberWith([{ kind: 'dead', subject: '' }])).error).toMatch(/claims\[0\]\.subject/);
    expect((await rememberWith(Array.from({ length: 11 }, () => ({ kind: 'dead', subject: 'orphan' })))).error).toMatch(/too many claims/);
    // A relational claim with no object is refused by verify_claim's own validation.
    expect((await rememberWith([{ kind: 'calls', subject: 'main' }])).error).toMatch(/do not hold/);
  });

  it('says so when an in-place update drops the claims', async () => {
    await rememberWith([{ kind: 'dead', subject: 'orphan' }]);
    const r = await rememberWith(undefined);
    expect(r.message).toMatch(/previous claim list was not repeated/);
  });
});

describe('recall checks claims again', () => {
  it('keeps a memory authoritative while its claims hold', async () => {
    await rememberWith([{ kind: 'dead', subject: 'orphan' }]);
    const r = await handleRecall(root) as Recall;
    expect(r.authoritative).toHaveLength(1);
    expect(r.authoritative[0].claims?.[0]).toMatchObject({ kind: 'dead', subject: 'orphan', verdict: 'evidence-holds' });
    expect(r.evidenceRefuted).toBeUndefined();
  });

  it('moves a memory to evidenceRefuted when the code changes under a fresh anchor', async () => {
    await rememberWith([{ kind: 'dead', subject: 'orphan' }]);
    // Someone now calls orphan. The memory's anchor (foo) is untouched.
    useGraph([MAIN, HANDLER, { ...ORPHAN, fanIn: 1 }], [edge(MAIN.id, HANDLER.id), edge(HANDLER.id, ORPHAN.id)]);
    const r = await handleRecall(root) as Recall;
    expect(r.authoritative).toHaveLength(0);
    expect(r.evidenceRefuted).toHaveLength(1);
    const item = r.evidenceRefuted![0];
    expect(item.freshness).toBe('fresh');
    expect(item.verifiedCurrent).toBeUndefined();
    expect(item.claims?.[0].verdict).toBe('evidence-refuted');
    expect(item.claims?.[0].reason).toMatch(/not dead/);
    expect(r.summary.evidenceRefuted).toBe(1);
    expect(r.note).toMatch(/evidenceRefuted/);
  });

  it('moves a memory to evidenceUnverifiable when the claim subject is gone', async () => {
    await rememberWith([{ kind: 'dead', subject: 'orphan' }]);
    useGraph([MAIN, HANDLER], [edge(MAIN.id, HANDLER.id)]);
    const r = await handleRecall(root) as Recall;
    expect(r.authoritative).toHaveLength(0);
    expect(r.needsReanchoring).toHaveLength(0);
    expect(r.evidenceUnverifiable?.[0].claims?.[0].verdict).toBe('evidence-unverifiable');
  });

  it('checks a claim shared by two memories once per recall', async () => {
    await rememberWith([{ kind: 'dead', subject: 'orphan' }], 'first fact');
    await rememberWith([{ kind: 'dead', subject: 'orphan' }], 'second fact');
    vi.mocked(readCachedContext).mockClear();
    const r = await handleRecall(root) as Recall;
    expect(r.authoritative).toHaveLength(2);
    expect(vi.mocked(readCachedContext)).toHaveBeenCalledTimes(1);
  });

  it('serves a memory without claims exactly as before', async () => {
    await handleRemember(root, 'plain fact', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    const r = await handleRecall(root) as Recall;
    expect(r.authoritative).toHaveLength(1);
    expect(r.authoritative[0].claims).toBeUndefined();
    expect(r.authoritative[0].verifiedCurrent).toBe(true);
  });

  it('skips a hand-edited memory whose stored claim is malformed', async () => {
    await rememberWith([{ kind: 'dead', subject: 'orphan' }]);
    const file = join(root, OPENLORE_DIR, 'memory', 'notes.json');
    const stored = JSON.parse(await readFile(file, 'utf-8'));
    stored.memories[0].claims = [{ kind: 'owns', subject: 'x' }];
    await writeFile(file, JSON.stringify(stored), 'utf-8');
    const r = await handleRecall(root) as Recall;
    expect(r.authoritative).toHaveLength(0);
  });
});

describe('claim shape', () => {
  it('parses and validates', () => {
    expect(parseClaims([{ kind: 'reaches', subject: 'a', object: 'b', extra: 1 }])).toEqual({ claims: [{ kind: 'reaches', subject: 'a', object: 'b' }] });
    expect(isWellFormedClaim({ kind: 'dead', subject: 'a', recordedIndexCommit: 'abc1234' })).toBe(true);
    expect(isWellFormedClaim({ kind: 'dead', subject: 'a'.repeat(257) })).toBe(false);
    expect(isWellFormedClaim({ kind: 'dead', subject: 'a', object: 3 })).toBe(false);
  });
});
