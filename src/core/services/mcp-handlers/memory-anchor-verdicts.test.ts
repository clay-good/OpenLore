/**
 * Sub-symbol span anchors and the memory-anchor-lost work item, end-to-end over a
 * real edge store + source files. (change: add-memory-anchor-verdicts)
 *
 * Guards the mcp-handlers requirements SubSymbolSpanAnchors and
 * AnchorLossIsAnActionableWorkItem. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../../constants.js';
import { handleRemember, handleRecall, detectMemoryAnchorLoss } from './memory.js';
import { FINDING_CODE_REGISTRY } from './enforcement-policy.js';
import {
  anchorFreshness,
  anchorOutcome,
  locateSpan,
  MAX_SPAN_CHARS,
  type GraphFreshnessView,
} from '../../decisions/anchor.js';
import { makeMemoryId } from '../../decisions/memory-store.js';
import { reanchorAnchors } from '../../decisions/continuity-carry-forward.js';
import { collectGovernanceFindings } from '../../../cli/commands/enforce.js';
import type { ContinuityPair } from '../../analyzer/continuity.js';
import { factKey } from '../../analyzer/pass1-fact-cache.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';
import type { StructuralAnchor } from '../../../types/index.js';

let root: string;

const SRC = [
  'export function big() {',
  '  // setup',
  '  const a = 1;',
  '  if (a > 0) retry();',
  '  return a;',
  '}',
  '',
].join('\n');
const SPAN = '  if (a > 0) retry();';

function nodeFor(filePath: string, name: string, src: string, start = 0, end = src.length): FunctionNode {
  return {
    id: `${filePath}::${name}`,
    name,
    filePath,
    isAsync: false,
    language: 'typescript',
    startIndex: start,
    endIndex: end,
    fanIn: 0,
    fanOut: 0,
  };
}

/** Write the file and (re-)index it as one symbol spanning the whole file. */
async function index(src: string | null, extra: FunctionNode[] = []): Promise<void> {
  if (src !== null) await writeFile(join(root, 'src', 'big.ts'), src, 'utf-8');
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.clearAll();
  store.insertNodes([...(src !== null ? [nodeFor('src/big.ts', 'big', src)] : []), ...extra]);
  // What a real index records: the content its offsets describe.
  if (src !== null) store.setFileHash('src/big.ts', createHash('sha256').update(src).digest('hex'));
  store.close();
}

type Recall = {
  authoritative: Array<{ id: string; freshness: string; anchors: Array<Record<string, unknown>>; certificates?: Array<{ lineSpan?: { start: number; end: number } }> }>;
  needsReanchoring: Array<{ id: string; freshness: string; anchors: Array<Record<string, unknown>> }>;
  findings?: Array<{ code: string; subject: string; severity: string; source: string; message: string }>;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-span-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await index(SRC);
});

afterEach(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(root, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

async function rememberSpan(content = 'retry only when a is positive', span = SPAN): Promise<{ id: string; anchors: Array<Record<string, unknown>>; spanNotRecorded?: unknown[]; message: string }> {
  return (await handleRemember(root, content, [{ symbol: 'big', file: 'src/big.ts', span }])) as never;
}

describe('SubSymbolSpanAnchors', () => {
  it('records a span anchor and recalls it fresh', async () => {
    const r = await rememberSpan();
    expect(r.anchors[0]).toMatchObject({ level: 'symbol', symbol: 'big', span: true });
    expect(r.spanNotRecorded).toBeUndefined();
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.authoritative).toHaveLength(1);
    expect(rec.authoritative[0].freshness).toBe('fresh');
    expect(rec.authoritative[0].anchors[0]).toMatchObject({ span: true, outcome: 'silently-carried' });
    // The evidence is the span's own line, not the whole function.
    expect(rec.authoritative[0].certificates?.[0].lineSpan).toEqual({ start: 4, end: 4 });
  });

  it('stays fresh when an unrelated line in the same function changes, where a whole-symbol anchor drifts', async () => {
    await rememberSpan();
    await handleRemember(root, 'big is the whole retry loop', [{ symbol: 'big', file: 'src/big.ts' }]);
    await index(SRC.replace('// setup', '// setup, now with a longer comment'));
    const rec = (await handleRecall(root)) as Recall;
    const byText = new Map(rec.authoritative.map((m) => [m.id, m]));
    const span = [...byText.values()].find((m) => m.anchors[0].span === true)!;
    const whole = [...byText.values()].find((m) => m.anchors[0].span === undefined)!;
    expect(span.freshness).toBe('fresh');
    expect(whole.freshness).toBe('drifted');
    expect(whole.anchors[0].outcome).toBeUndefined();
  });

  it('re-locates a span that moved within the symbol and cites its new line', async () => {
    await rememberSpan();
    await index(SRC.replace('  // setup\n', '  // setup\n  // two\n  // more lines\n'));
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.authoritative[0].freshness).toBe('fresh');
    expect(rec.authoritative[0].certificates?.[0].lineSpan).toEqual({ start: 6, end: 6 });
  });

  it('drifts when the span text itself changes', async () => {
    await rememberSpan();
    await index(SRC.replace('retry();', 'retryTwice();'));
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.authoritative[0].freshness).toBe('drifted');
    expect(rec.findings).toBeUndefined();
  });

  it('orphans an ambiguous span with both candidate lines and emits a finding', async () => {
    const r = await rememberSpan();
    await index(SRC.replace(SPAN, `${SPAN}\n${SPAN}`));
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.authoritative).toHaveLength(0);
    expect(rec.needsReanchoring).toHaveLength(1);
    expect(rec.needsReanchoring[0].anchors[0]).toMatchObject({
      freshness: 'orphaned',
      spanCandidates: { lines: [4, 5] },
      outcome: 'needs-human-reselection',
      reselectReason: 'span-ambiguous',
    });
    expect(rec.findings).toEqual([expect.objectContaining({
      code: 'memory-anchor-lost', subject: r.id, severity: 'warning', source: 'memory-freshness',
    })]);
  });

  it('caps the disclosed candidates and says more exist', async () => {
    await rememberSpan();
    await index(SRC.replace(SPAN, Array(15).fill(SPAN).join('\n')));
    const rec = (await handleRecall(root)) as Recall;
    const a = rec.needsReanchoring[0].anchors[0] as { spanCandidates: { lines: number[]; truncated?: boolean } };
    expect(a.spanCandidates.lines).toHaveLength(10);
    expect(a.spanCandidates.truncated).toBe(true);
  });

  it('records a span that is not in the body, or is ambiguous, at symbol level and says so', async () => {
    const missing = await rememberSpan('a', 'not in the body');
    expect(missing.anchors[0].span).toBeUndefined();
    expect(missing.spanNotRecorded).toEqual([{ anchor: 0, reason: 'not-found' }]);
    expect(missing.message).toMatch(/anchors\[0\]\.span was not recorded/);
    const ambiguous = await rememberSpan('b', 'a');
    expect(ambiguous.anchors[0].span).toBeUndefined();
    expect(ambiguous.spanNotRecorded).toEqual([{ anchor: 0, reason: 'ambiguous' }]);
  });

  it('discloses a dropped span when the symbol does not resolve', async () => {
    const r = (await handleRemember(root, 'x', [{ symbol: 'nope', file: 'src/big.ts', span: SPAN }])) as { anchors: Array<{ level: string }>; spanNotRecorded: unknown[] };
    expect(r.anchors[0].level).toBe('file');
    expect(r.spanNotRecorded).toEqual([{ anchor: 0, reason: 'no-symbol' }]);
  });

  it('rejects malformed span hints', async () => {
    expect(await handleRemember(root, 'x', [{ file: 'src/big.ts', span: SPAN }])).toMatchObject({ error: expect.stringMatching(/needs anchors\[0\]\.symbol/) });
    expect(await handleRemember(root, 'x', [{ symbol: 'big', span: '   ' }])).toMatchObject({ error: expect.stringMatching(/non-empty/) });
    expect(await handleRemember(root, 'x', [{ symbol: 'big', span: 'x'.repeat(MAX_SPAN_CHARS + 1) }])).toMatchObject({ error: expect.stringMatching(/max 2000/) });
    expect(await handleRemember(root, 'x', [{ symbol: 'big', span: 42 as unknown as string }])).toMatchObject({ error: expect.stringMatching(/non-empty/) });
  });

  it('keeps two spans on one symbol as two memories, and plain anchor ids unchanged', async () => {
    const one = await rememberSpan('same fact', SPAN);
    const two = await rememberSpan('same fact', '  return a;');
    expect(one.id).not.toBe(two.id);
    const plain: StructuralAnchor[] = [{ nodeId: 'src/big.ts::big', filePath: 'src/big.ts', contentHash: 'h' }];
    const legacy = createHash('sha256').update('same fact\x00sym:src/big.ts::big').digest('hex').slice(0, 8);
    expect(makeMemoryId('same fact', plain)).toBe(legacy);
  });

  it('skips a stored note whose span is not bounded text', async () => {
    await rememberSpan();
    const path = join(root, OPENLORE_DIR, 'memory', 'notes.json');
    const store = JSON.parse(await readFile(path, 'utf-8'));
    store.memories[0].anchors[0].spanText = 'x'.repeat(MAX_SPAN_CHARS + 1);
    await writeFile(path, JSON.stringify(store), 'utf-8');
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.authoritative).toHaveLength(0);
    expect(rec.needsReanchoring).toHaveLength(0);
  });
});

describe('round-1 review regressions', () => {
  it('does not report a span fresh when the file changed since analysis (stale offsets)', async () => {
    await rememberSpan();
    // The span moves out of big's stored window into code that is not big's: no re-index.
    const shifted = `// header\n// header\nfunction other() {\n${SPAN}\n}\n${SRC.replace(SPAN, '  noop();')}`;
    await writeFile(join(root, 'src', 'big.ts'), shifted, 'utf-8');
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.authoritative[0].freshness).toBe('drifted');
    expect(rec.authoritative[0].certificates).toBeUndefined();
  });

  it('refuses to record a span against stale offsets, and says why', async () => {
    await writeFile(join(root, 'src', 'big.ts'), `// one more line\n${SRC}`, 'utf-8');
    const r = await rememberSpan();
    expect(r.spanNotRecorded).toEqual([{ anchor: 0, reason: 'index-stale' }]);
  });

  it('trusts offsets from the full-analyze memo key when there is no watcher hash', async () => {
    await rememberSpan();
    const edited = SRC.replace('// setup', '// setup, edited');
    await index(edited);
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const store = EdgeStore.open(EdgeStore.dbPath(dir));
    store.deleteFileHash('src/big.ts');
    store.close();
    // No key at all: span search is not trusted; the changed whole symbol reads drifted.
    expect(((await handleRecall(root)) as Recall).authoritative[0].freshness).toBe('drifted');
    const again = EdgeStore.openForAnalyze(EdgeStore.dbPath(dir));
    again.putPass1Facts([{ filePath: 'src/big.ts', contentHash: factKey({ path: 'src/big.ts', language: 'typescript', content: edited }), facts: 'null' }], 'stamp');
    again.close();
    expect(((await handleRecall(root)) as Recall).authoritative[0].freshness).toBe('fresh');
  });

  it('reports no findings without a graph', async () => {
    await handleRemember(root, 'old', [{ symbol: 'big', file: 'src/big.ts' }]);
    await rm(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true, force: true });
    const noGraph = (await handleRecall(root)) as Recall & { graphAvailable: boolean };
    expect(noGraph.graphAvailable).toBe(false);
    expect(noGraph.findings).toBeUndefined();
  });

  it('keeps an advisory incomplete check from failing the gate', async () => {
    await handleRemember(root, 'x', [{ file: 'src/big.ts' }]);
    await rm(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true, force: true });
    const advisory = await collectGovernanceFindings(root, null, {});
    expect(advisory.failedCodes.has('memory-anchor-lost')).toBe(false);
    expect(advisory.caveats.join(' ')).toContain('memory-anchor-lost check incomplete');
    const blocking = await collectGovernanceFindings(root, null, { 'memory-anchor-lost': 'blocking' });
    expect(blocking.failedCodes.has('memory-anchor-lost')).toBe(true);
  });

  it('says a symbol anchor lost its file, not its successor', async () => {
    await handleRemember(root, 'big must retry', [{ symbol: 'big', file: 'src/big.ts' }]);
    await rm(join(root, 'src', 'big.ts'));
    await index(null, [nodeFor('src/other.ts', 'other', 'x')]);
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.needsReanchoring[0].anchors[0]).toMatchObject({ reselectReason: 'file-missing' });
  });

  it('hints at line endings for an LF span in a CRLF file', async () => {
    await index(SRC.replace(/\n/g, '\r\n'));
    const r = await rememberSpan('x', '  const a = 1;\n  if (a > 0)');
    expect(r.spanNotRecorded).toEqual([{ anchor: 0, reason: 'line-endings' }]);
    expect(r.message).toMatch(/CRLF/);
    const ok = await rememberSpan('y', '  const a = 1;\r\n  if (a > 0)');
    expect(ok.anchors[0].span).toBe(true);
  });

  it('labels no outcome when there is no graph to check against', async () => {
    await handleRemember(root, 'x', [{ symbol: 'big', file: 'src/big.ts' }]);
    await rm(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true, force: true });
    const rec = (await handleRecall(root)) as Recall;
    const all = [...rec.authoritative, ...rec.needsReanchoring].flatMap((m) => m.anchors);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) expect(a.outcome).toBeUndefined();
  });

  it('treats an anchored file whose content matches the index as current for the gate', async () => {
    await rememberSpan();
    const gated = await collectGovernanceFindings(root, null, { 'memory-anchor-lost': 'blocking' });
    expect(gated.assessedCodes).toContain('memory-anchor-lost');
    await writeFile(join(root, 'src', 'big.ts'), `${SRC}// edited\n`, 'utf-8');
    const stale = await collectGovernanceFindings(root, null, { 'memory-anchor-lost': 'blocking' });
    expect(stale.failedCodes).toContain('memory-anchor-lost');
    expect(stale.caveats.join(' ')).toContain('1 anchored file(s) changed since analysis');
  });

  it('survives a non-string symbol label in a hostile store', async () => {
    const r = (await handleRemember(root, 'big must retry', [{ symbol: 'big', file: 'src/big.ts' }])) as { id: string };
    const path = join(root, OPENLORE_DIR, 'memory', 'notes.json');
    const store = JSON.parse(await readFile(path, 'utf-8'));
    store.memories[0].anchors[0].symbolName = { length: 999 };
    await writeFile(path, JSON.stringify(store), 'utf-8');
    await index(null, [nodeFor('src/other.ts', 'other', 'x')]);
    const rec = (await handleRecall(root)) as Recall & { error?: string };
    expect(rec.error).toBeUndefined();
    expect(rec.findings?.map((f) => f.subject)).toEqual([r.id]);
    expect((await detectMemoryAnchorLoss(root)).findings).toHaveLength(1);
  });

  it('treats a torn store as an incomplete check and leaves the file in place', async () => {
    const path = join(root, OPENLORE_DIR, 'memory', 'notes.json');
    await mkdir(join(root, OPENLORE_DIR, 'memory'), { recursive: true });
    await writeFile(path, '{"memories": [ torn', 'utf-8');
    await expect(detectMemoryAnchorLoss(root)).rejects.toThrow(/unreadable/);
    expect(await readFile(path, 'utf-8')).toBe('{"memories": [ torn');
    const gated = await collectGovernanceFindings(root, null, { 'memory-anchor-lost': 'blocking' });
    expect(gated.failedCodes).toContain('memory-anchor-lost');
    expect(gated.assessedCodes).not.toContain('memory-anchor-lost');
  });

  it('keeps span checks linear in a large file with many span notes', async () => {
    const pad = '// pad\n'.repeat(200_000);
    const src = `${pad}${SRC}`;
    await writeFile(join(root, 'src', 'big.ts'), src, 'utf-8');
    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const store = EdgeStore.open(EdgeStore.dbPath(dir));
    store.clearAll();
    store.insertNodes([nodeFor('src/big.ts', 'big', src, pad.length)]);
    store.setFileHash('src/big.ts', createHash('sha256').update(src).digest('hex'));
    store.close();
    for (let i = 0; i < 40; i++) await rememberSpan(`note ${i}`);
    const started = Date.now();
    const loss = await detectMemoryAnchorLoss(root);
    expect(loss.checked).toBe(40);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not flag two spans in one symbol as unreconciled', async () => {
    await rememberSpan('one', SPAN);
    await rememberSpan('two', '  return a;');
    const rec = (await handleRecall(root)) as Recall & { unreconciled?: unknown };
    expect(rec.authoritative).toHaveLength(2);
    expect(rec.unreconciled).toBeUndefined();
  });
});

describe('AnchorLossIsAnActionableWorkItem', () => {
  it('labels a deleted symbol needs-human-reselection with a finding in recall and enforce', async () => {
    const r = (await handleRemember(root, 'big must retry', [{ symbol: 'big', file: 'src/big.ts' }])) as { id: string };
    await index(null, [nodeFor('src/other.ts', 'other', 'x')]);
    const rec = (await handleRecall(root)) as Recall;
    expect(rec.needsReanchoring[0].anchors[0]).toMatchObject({ outcome: 'needs-human-reselection', reselectReason: 'no-successor' });
    expect(rec.findings?.[0]).toMatchObject({ code: 'memory-anchor-lost', subject: r.id });
    expect(rec.findings?.[0].message).toMatch(/several analyses/);

    const loss = await detectMemoryAnchorLoss(root);
    expect(loss.unassessedReason).toBeUndefined();
    expect(loss.checked).toBe(1);
    expect(loss.findings.map((f) => f.subject)).toEqual([r.id]);
  });

  it('is collected by openlore enforce, and an unverifiable index marks a gated code incomplete', async () => {
    const empty = await collectGovernanceFindings(root, null, {});
    expect(empty.assessedCodes).toContain('memory-anchor-lost');

    const r = (await handleRemember(root, 'big must retry', [{ symbol: 'big', file: 'src/big.ts' }])) as { id: string };
    await index(null, [nodeFor('src/other.ts', 'other', 'x')]);
    const collected = await collectGovernanceFindings(root, null, { 'memory-anchor-lost': 'frozen' });
    expect(collected.findings.filter((f) => f.code === 'memory-anchor-lost').map((f) => f.subject)).toEqual([r.id]);
    // The fixture is not a git repository, so the index freshness is unknown.
    expect(collected.failedCodes).toContain('memory-anchor-lost');
    expect(collected.caveats.join(' ')).toContain('memory-anchor-lost check incomplete');
  });

  it('registers the code as advisory by default', () => {
    expect(FINDING_CODE_REGISTRY['memory-anchor-lost']).toMatchObject({ defaultClass: 'advisory', source: 'memory-freshness' });
  });

  it('reports no findings for fresh notes and says when there is no analysis', async () => {
    await rememberSpan();
    expect(await detectMemoryAnchorLoss(root)).toEqual({ findings: [], checked: 1, staleFiles: [] });
    await rm(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true, force: true });
    const loss = await detectMemoryAnchorLoss(root);
    expect(loss.findings).toEqual([]);
    expect(loss.unassessedReason).toMatch(/openlore analyze/);
  });

  it('does not report retired notes', async () => {
    const r = (await handleRemember(root, 'old', [{ symbol: 'big', file: 'src/big.ts' }])) as { id: string };
    await handleRemember(root, 'new', [{ file: 'src/big.ts' }], undefined, undefined, r.id);
    await index(null, [nodeFor('src/other.ts', 'other', 'x')]);
    expect((await detectMemoryAnchorLoss(root)).findings).toEqual([]);
  });
});

// ── pure engine ─────────────────────────────────────────────────────────────

function view(bodies: Record<string, string>, extra: Partial<GraphFreshnessView> = {}): GraphFreshnessView {
  return {
    nodeHash: (id) => (id in bodies ? `h:${bodies[id]}` : undefined),
    nodeSource: (id) => (id in bodies ? { text: bodies[id], startLine: 10 } : undefined),
    fileExists: () => true,
    fileHash: () => undefined,
    ...extra,
  };
}

describe('span freshness (pure)', () => {
  const anchor: StructuralAnchor = { nodeId: 'f::g', stableId: 's1', symbolName: 'g', filePath: 'f', contentHash: 'h:old', spanText: 'X' };

  it('follows a stable-id relocation and re-locates the span in the new body', () => {
    const v = anchorFreshness(anchor, view({ 'g::g': 'a\nX\nb' }, {
      resolveStableId: () => ({ nodeId: 'g::g', contentHash: 'h:new' }),
    }));
    expect(v).toMatchObject({ freshness: 'fresh', relocatedTo: 'g::g' });
  });

  it('falls back to the whole-symbol hash when the view cannot read the body', () => {
    const noSource = { ...view({ 'f::g': 'X' }), nodeSource: undefined };
    expect(anchorFreshness({ ...anchor, contentHash: 'h:X' }, noSource).freshness).toBe('fresh');
    expect(anchorFreshness(anchor, noSource).freshness).toBe('drifted');
  });

  it('discloses candidate lines relative to the symbol start', () => {
    const v = anchorFreshness(anchor, view({ 'f::g': 'X\n\nX' }));
    expect(v).toMatchObject({ freshness: 'orphaned', spanCandidates: { lines: [10, 12] } });
  });

  it('still downgrades a fresh span in a stale region', () => {
    const v = anchorFreshness(anchor, view({ 'f::g': 'X' }, { inStaleRegion: () => true }));
    expect(v).toMatchObject({ freshness: 'drifted', staleRegion: true });
  });

  it('maps verdicts to outcomes', () => {
    const base: StructuralAnchor = { nodeId: 'n', filePath: 'f' };
    expect(anchorOutcome({ anchor: base, freshness: 'fresh' })).toEqual({ outcome: 'silently-carried' });
    expect(anchorOutcome({ anchor: base, freshness: 'drifted' })).toBeUndefined();
    const carried = { ...base, carriedAcross: { from: 'f::old', reason: 'renamed', basis: 'exact-signature' } } as unknown as StructuralAnchor;
    expect(anchorOutcome({ anchor: carried, freshness: 'fresh' })).toEqual({ outcome: 're-pointed-with-provenance' });
    expect(anchorOutcome({ anchor: { ...base, possiblyMovedTo: ['a::b', 'c::d'] }, freshness: 'orphaned' }))
      .toEqual({ outcome: 'needs-human-reselection', reason: 'move-ambiguous' });
    expect(anchorOutcome({ anchor: { filePath: 'f' }, freshness: 'orphaned' }))
      .toEqual({ outcome: 'needs-human-reselection', reason: 'file-missing' });
  });

  it('keeps the span through a carry and re-locates it in the new body', () => {
    const pair = {
      from: { nodeId: 'f::g' },
      to: { id: 'f::h', name: 'h', filePath: 'f' },
      reason: 'renamed',
      basis: 'exact-signature',
    } as unknown as ContinuityPair;
    const [carried] = reanchorAnchors([anchor], new Map([['f::g', pair]]), new Map()).anchors;
    expect(carried).toMatchObject({ nodeId: 'f::h', spanText: 'X' });
    const v = anchorFreshness(carried, view({ 'f::h': 'h\nX' }));
    expect(v.freshness).toBe('fresh');
    expect(anchorOutcome(v)).toEqual({ outcome: 're-pointed-with-provenance' });
    // A rename that edits the span's own text drifts it instead of guessing.
    expect(anchorFreshness(carried, view({ 'f::h': 'h\nY' })).freshness).toBe('drifted');
  });

  it('locateSpan counts overlapping occurrences up to the limit', () => {
    expect(locateSpan('aaaa', 'aa', 10)).toEqual([0, 1, 2]);
    expect(locateSpan('aaaa', 'aa', 2)).toEqual([0, 1]);
    expect(locateSpan('abc', '', 10)).toEqual([]);
  });
});
