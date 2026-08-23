import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallEdge, FunctionNode } from '../analyzer/call-graph.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../runtime/analysis-generation.js';
import {
  deriveEditVerdict,
  readEditVerdictStore,
  readCurrentEditVerdicts,
  selectReachingTestsFromStore,
  selectReachingTestsFromFullGraph,
  writeEditVerdictStore,
  MAX_EDIT_VERDICT_BASIS_FILES,
  type EditCallSite,
} from './edit-verdict.js';
import { EdgeStore } from './edge-store.js';

function node(id: string, name: string, extra: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id, name, filePath: id.split('::')[0], isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...extra,
  };
}

function baseInput() {
  return {
    file: 'src/api.ts',
    contentHash: createHash('sha256').update('new').digest('hex'),
    oldNodes: [] as FunctionNode[],
    newNodes: [] as FunctionNode[],
    oldIncoming: [] as EditCallSite[],
    postOutgoingByCaller: new Map<string, CallEdge[]>(),
    postIncoming: [] as EditCallSite[],
    recomputedCallerFiles: new Set<string>(),
    staleFiles: [] as string[],
    reachingTests: [],
    basis: [{ file: 'src/api.ts', contentHash: createHash('sha256').update('new').digest('hex') }],
  };
}

describe('edit verdict derivation', () => {
  it('reports a removed symbol only when the exact caller site survives the batch', () => {
    const old = node('src/api.ts::gone', 'gone');
    const site: EditCallSite = {
      callerId: 'src/use.ts::use', callerFile: 'src/use.ts', calleeId: old.id,
      calleeName: 'gone', line: 7, confidence: 'import' as const,
    };
    const post: CallEdge = {
      callerId: site.callerId, calleeId: 'external::gone', calleeName: 'gone',
      line: 7, confidence: 'external', kind: 'calls',
    };
    const verdict = deriveEditVerdict({
      ...baseInput(), oldNodes: [old], oldIncoming: [site],
      postOutgoingByCaller: new Map([[site.callerId, [post]]]),
      recomputedCallerFiles: new Set(['src/use.ts']),
    });
    expect(verdict.findings).toMatchObject([{
      code: 'edit-broken-reference', location: { path: 'src/use.ts', line: 7 },
    }]);

    const fixedInSameBatch = deriveEditVerdict({
      ...baseInput(), oldNodes: [old], oldIncoming: [site],
      recomputedCallerFiles: new Set(['src/use.ts']),
    });
    expect(fixedInSameBatch.findings).toEqual([]);

    const reboundElsewhere = deriveEditVerdict({
      ...baseInput(), oldNodes: [old], oldIncoming: [site],
      postOutgoingByCaller: new Map([[site.callerId, [{
        ...post, calleeId: 'src/other.ts::gone', confidence: 'name_only',
      }]]]),
      recomputedCallerFiles: new Set(['src/use.ts']),
    });
    expect(reboundElsewhere.findings).toEqual([]);
  });

  it('stays silent for a caller outside the recomputed closure', () => {
    const old = node('src/api.ts::gone', 'gone');
    const site: EditCallSite = {
      callerId: 'src/stale.ts::use', callerFile: 'src/stale.ts', calleeId: old.id,
      calleeName: 'gone', line: 2, confidence: 'import' as const,
    };
    const verdict = deriveEditVerdict({
      ...baseInput(), oldNodes: [old], oldIncoming: [site],
      postOutgoingByCaller: new Map([[site.callerId, [{
        callerId: site.callerId, calleeId: 'external::gone', calleeName: 'gone',
        line: 2, confidence: 'external',
      }]]]),
      staleFiles: ['src/stale.ts'],
    });
    expect(verdict.findings).toEqual([]);
    expect(verdict.boundaries.staleFiles).toEqual(['src/stale.ts']);
  });

  it('emits exact arity mismatches and silences uncertain signatures and calls', () => {
    const oldExact = node('src/api.ts::f', 'f', {
      callArity: { required: 1, total: 1, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const exact = node('src/api.ts::f', 'f', {
      callArity: { required: 2, total: 2, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const caller = { callerId: 'src/use.ts::use', callerFile: 'src/use.ts', calleeId: exact.id, calleeName: 'f', line: 3, confidence: 'import' as const, kind: 'calls' as const };
    expect(deriveEditVerdict({
      ...baseInput(), oldNodes: [oldExact], newNodes: [exact],
      oldIncoming: [{ ...caller, argCount: 1 }], postIncoming: [{ ...caller, argCount: 1 }],
    }).findings.map(f => f.code)).toEqual(['edit-arity-mismatch']);

    for (const uncertain of [
      { ...caller },
      { ...caller, argCount: 1, argCountLowerBound: true as const },
    ]) {
      expect(deriveEditVerdict({ ...baseInput(), oldNodes: [oldExact], newNodes: [exact],
        oldIncoming: [{ ...caller, argCount: 1 }], postIncoming: [uncertain] }).findings).toEqual([]);
    }
    const optional = node(exact.id, exact.name, {
      callArity: { required: 1, total: 2, variadic: false, hasOptionalOrDefault: true, implicitReceiverCount: 0 },
    });
    expect(deriveEditVerdict({
      ...baseInput(), oldNodes: [oldExact], newNodes: [optional],
      oldIncoming: [{ ...caller, argCount: 1 }], postIncoming: [{ ...caller, argCount: 3 }],
    }).findings).toEqual([]);
  });

  it('requires precise binding and a previously compatible call for arity findings', () => {
    const old = node('src/api.ts::f', 'f', {
      callArity: { required: 1, total: 1, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const next = node(old.id, 'f', {
      callArity: { required: 2, total: 2, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const site = { callerId: 'src/use.ts::u', callerFile: 'src/use.ts', calleeId: old.id,
      calleeName: 'f', line: 4, argCount: 1, confidence: 'import' as const, kind: 'calls' as const };
    for (const confidence of ['name_only', 'type_name'] as const) {
      expect(deriveEditVerdict({ ...baseInput(), oldNodes: [old], newNodes: [next],
        oldIncoming: [{ ...site, confidence }], postIncoming: [{ ...site, confidence }] }).findings).toEqual([]);
    }
    expect(deriveEditVerdict({ ...baseInput(), oldNodes: [old], newNodes: [next],
      oldIncoming: [{ ...site, argCount: 2 }], postIncoming: [site] }).findings).toEqual([]);
  });

  it('matches same-line arity sites by exact argument facts and silences ambiguity', () => {
    const old = node('src/api.ts::f', 'f', {
      callArity: { required: 1, total: 2, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const next = node(old.id, 'f', {
      callArity: { required: 2, total: 2, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const site = (argCount: number): EditCallSite => ({ callerId: 'src/use.ts::u', callerFile: 'src/use.ts',
      calleeId: old.id, calleeName: 'f', line: 1, argCount, confidence: 'import', kind: 'calls' });
    const verdict = deriveEditVerdict({ ...baseInput(), oldNodes: [old], newNodes: [next],
      oldIncoming: [site(1), site(2)], postIncoming: [site(1), site(2)] });
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.message).toContain('supplies 1');

    expect(deriveEditVerdict({ ...baseInput(), oldNodes: [old], newNodes: [next],
      oldIncoming: [site(1), site(1)], postIncoming: [site(1)] }).findings).toEqual([]);
  });

  it('indexes old call sites instead of rescanning them for every post site', () => {
    const old = node('src/api.ts::f', 'f', {
      callArity: { required: 1, total: 1, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const next = node(old.id, 'f', {
      callArity: { required: 2, total: 2, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0 },
    });
    const sites = Array.from({ length: 2000 }, (_, index): EditCallSite => ({
      callerId: `src/u.ts::u${index}`, callerFile: 'src/u.ts', calleeId: old.id,
      calleeName: 'f', line: index + 1, argCount: 1, confidence: 'import', kind: 'calls',
    }));
    Object.defineProperty(sites, 'find', { value: () => { throw new Error('quadratic scan'); } });
    expect(deriveEditVerdict({ ...baseInput(), oldNodes: [old], newNodes: [next],
      oldIncoming: sites, postIncoming: sites }).findings).toHaveLength(512);
  });

  it('has a bounded deterministic false-positive sample for representative non-breaking edits', () => {
    const exact = (required: number, total = required) => ({
      required, total, variadic: false, hasOptionalOrDefault: false, implicitReceiverCount: 0,
    });
    const old = node('src/api.ts::f', 'f', { callArity: exact(1) });
    const site = { callerId: 'src/use.ts::u', callerFile: 'src/use.ts', calleeId: old.id,
      calleeName: 'f', line: 4, argCount: 1, confidence: 'import' as const, kind: 'calls' as const };
    // This bounded unit sample deliberately covers the highest-risk transition
    // classes without depending on repository history or network availability.
    const samples = [
      { name: 'unchanged signature', next: node(old.id, 'f', { callArity: exact(1) }), oldSite: site, postSite: site },
      { name: 'wider exact signature', next: node(old.id, 'f', { callArity: exact(1, 2) }), oldSite: site, postSite: site },
      { name: 'optional/default uncertainty', next: node(old.id, 'f', { callArity: { ...exact(1, 2), hasOptionalOrDefault: true } }), oldSite: site, postSite: site },
      { name: 'variadic uncertainty', next: node(old.id, 'f', { callArity: { ...exact(1), variadic: true } }), oldSite: site, postSite: site },
      { name: 'spread lower bound', next: node(old.id, 'f', { callArity: exact(2) }), oldSite: site, postSite: { ...site, argCountLowerBound: true as const } },
      { name: 'pre-existing mismatch', next: node(old.id, 'f', { callArity: exact(2) }), oldSite: { ...site, argCount: 2 }, postSite: site },
      { name: 'heuristic binding', next: node(old.id, 'f', { callArity: exact(2) }), oldSite: { ...site, confidence: 'name_only' as const }, postSite: { ...site, confidence: 'name_only' as const } },
    ];
    for (const sample of samples) {
      expect(deriveEditVerdict({ ...baseInput(), oldNodes: [old], newNodes: [sample.next],
        oldIncoming: [sample.oldSite], postIncoming: [sample.postSite] }).findings,
      sample.name).toEqual([]);
    }
  });

  it('joins exact import breakage facts into the governance shape', () => {
    const verdict = deriveEditVerdict({
      ...baseInput(),
      importBreakages: [{ importerFile: 'src/use.ts', importedName: 'removed' }],
    });
    expect(verdict.findings).toMatchObject([{
      code: 'edit-import-breakage', subject: 'removed', location: { path: 'src/use.ts' },
    }]);
  });
});

describe('edit verdict store', () => {
  it('serves only the current generation and matching content hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-edit-verdict-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(output, { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'new');
    await writeFile(join(root, 'src/use.ts'), 'caller');
    for (const artifact of REQUIRED_ANALYSIS_ARTIFACTS) await writeFile(join(output, artifact), '{}');
    const generation = await publishGeneration(output, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    expect(generation).not.toBeNull();
    const entry = deriveEditVerdict(baseInput());
    entry.file = 'src/a.ts';
    entry.basis = [
      { file: 'src/a.ts', contentHash: entry.contentHash },
      { file: 'src/use.ts', contentHash: createHash('sha256').update('caller').digest('hex') },
    ];
    await writeEditVerdictStore(output, generation!.generationId, [entry]);
    expect(await readCurrentEditVerdicts(root, ['src/a.ts'])).toMatchObject({ status: 'current' });

    await writeFile(join(root, 'src/use.ts'), 'caller-changed');
    expect(await readCurrentEditVerdicts(root, ['src/a.ts'])).toMatchObject({ status: 'stale' });
    await writeFile(join(root, 'src/use.ts'), 'caller');

    await writeFile(join(root, 'src/a.ts'), 'changed-again');
    expect(await readCurrentEditVerdicts(root, ['src/a.ts'])).toMatchObject({ status: 'stale' });
    expect(await readCurrentEditVerdicts(root)).toMatchObject({ status: 'stale', entries: [] });
  });

  it('distinguishes a malformed artifact from an absent one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-edit-verdict-invalid-'));
    expect(await readCurrentEditVerdicts(root)).toMatchObject({ status: 'missing' });
    const output = join(root, '.openlore', 'analysis');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'edit-verdicts.json'), '{not json');
    expect(await readCurrentEditVerdicts(root)).toMatchObject({ status: 'invalid' });
  });

  it('retains unrelated latest entries and invalidates entries whose semantic basis changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-edit-verdict-merge-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(output, { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'a');
    await writeFile(join(root, 'src/b.ts'), 'b');
    await writeFile(join(root, 'src/use.ts'), 'use');
    for (const artifact of REQUIRED_ANALYSIS_ARTIFACTS) await writeFile(join(output, artifact), '{}');
    const firstGeneration = (await publishGeneration(output, [...REQUIRED_ANALYSIS_ARTIFACTS]))!;
    const makeEntry = (file: string, content: string, extraBasis: Array<{ file: string; contentHash: string }> = []) => {
      const contentHash = createHash('sha256').update(content).digest('hex');
      const verdict = deriveEditVerdict({ ...baseInput(), file, contentHash,
        basis: [{ file, contentHash }, ...extraBasis] });
      return verdict;
    };
    const useHash = createHash('sha256').update('use').digest('hex');
    await writeEditVerdictStore(output, firstGeneration.generationId, [
      makeEntry('src/a.ts', 'a'), makeEntry('src/b.ts', 'b', [{ file: 'src/use.ts', contentHash: useHash }]),
    ]);
    await writeFile(join(output, REQUIRED_ANALYSIS_ARTIFACTS[0]!), '{"next":true}');
    const secondGeneration = (await publishGeneration(output, [...REQUIRED_ANALYSIS_ARTIFACTS]))!;
    await writeEditVerdictStore(output, secondGeneration.generationId, [makeEntry('src/a.ts', 'a')], {
      previousGenerationId: firstGeneration.generationId,
      invalidatedFiles: ['src/use.ts'],
    });
    expect((await readEditVerdictStore(output))?.entries.map(entry => entry.file)).toEqual(['src/a.ts']);
  });

  it('never self-writes an invalid over-cap store and discloses deterministic eviction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-edit-verdict-cap-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(output, { recursive: true });
    const entries = Array.from({ length: 2050 }, (_, index) => {
      const file = `src/f${String(index).padStart(4, '0')}.ts`;
      const contentHash = createHash('sha256').update(file).digest('hex');
      return deriveEditVerdict({ ...baseInput(), file, contentHash, basis: [{ file, contentHash }] });
    });
    await writeEditVerdictStore(output, 'generation', entries);
    const store = await readEditVerdictStore(output);
    expect(store?.entries).toHaveLength(2048);
    expect(store?.boundaries).toMatchObject({ entriesEvicted: 2 });
    expect(store?.boundaries?.evictedFiles).toEqual(['src/f2048.ts', 'src/f2049.ts']);
  });

  it('evicts a single over-cap fan-in basis instead of writing an unreadable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-edit-verdict-basis-cap-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(output, { recursive: true });
    const entry = deriveEditVerdict(baseInput());
    entry.basis = Array.from({ length: MAX_EDIT_VERDICT_BASIS_FILES + 1 }, (_, index) => {
      const file = index === 0 ? entry.file : `src/caller-${index}.ts`;
      return { file, contentHash: index === 0 ? entry.contentHash : createHash('sha256').update(file).digest('hex') };
    });
    await writeEditVerdictStore(output, 'generation', [entry]);
    expect(await readEditVerdictStore(output)).toMatchObject({
      entries: [], boundaries: { entriesEvicted: 1, evictedFiles: [entry.file] },
    });
  });

  it('rejects hostile or unbounded artifact members fail-soft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-edit-verdict-schema-'));
    const output = join(root, '.openlore', 'analysis');
    await mkdir(output, { recursive: true });
    const entry = deriveEditVerdict({ ...baseInput(), importBreakages: [
      { importerFile: 'src/use.ts', importedName: 'f', line: 1 },
    ] });
    const store = { version: 1, analysisGenerationId: 'generation', entries: [entry] };
    const variants: unknown[] = [
      { ...store, entries: [{ ...entry, file: '../escape.ts' }] },
      { ...store, entries: [{ ...entry, findings: [{ ...entry.findings[0], code: 'unknown' }] }] },
      { ...store, entries: [{ ...entry, findings: [{ ...entry.findings[0], source: 'forged' }] }] },
      { ...store, entries: [{ ...entry, findings: [{ ...entry.findings[0], message: 'x'.repeat(4097) }] }] },
      { ...store, entries: [{ ...entry, findings: [{ ...entry.findings[0], message: 'safe\u202Etxt' }] }] },
      { ...store, entries: [{ ...entry, findings: [{ ...entry.findings[0], location: { path: 'src/use.ts', line: Number.MAX_SAFE_INTEGER + 1 } }] }] },
      { ...store, entries: [{ ...entry, boundaries: { ...entry.boundaries, findingsTruncated: 'true' } }] },
      { ...store, entries: [{ ...entry, reachingTests: [{ test: 't', file: 'src/t.test.ts', viaPath: 'not-an-array', basisFiles: [], confidence: 'high' }] }] },
    ];
    for (const variant of variants) {
      await writeFile(join(output, 'edit-verdicts.json'), JSON.stringify(variant));
      expect(await readEditVerdictStore(output)).toBeNull();
    }
  });
});

describe('EdgeStore-backed reaching tests', () => {
  it('finds direct callers and tested_by associations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openlore-edit-tests-'));
    const store = EdgeStore.openForAnalyze(join(dir, 'graph.db'));
    const target = node('src/api.ts::target', 'target');
    const direct = node('src/api.test.ts::direct', 'direct', { filePath: 'src/api.test.ts' });
    const associated = node('src/assoc.test.ts::associated', 'associated', { filePath: 'src/assoc.test.ts' });
    store.insertNodes([target, direct, associated]);
    store.insertEdges([
      { callerId: direct.id, calleeId: target.id, calleeName: 'target', confidence: 'import', kind: 'calls' },
      { callerId: target.id, calleeId: associated.id, calleeName: 'associated', confidence: 'import', kind: 'tested_by' },
    ]);
    const selected = selectReachingTestsFromStore(store, [target.id]);
    store.close();
    expect(selected.tests.map(test => test.test).sort()).toEqual(['associated', 'direct']);
  });
});

describe('last-full-analysis reaching tests', () => {
  it('selects direct and tested_by tests without adding them to the production store', () => {
    const target = node('src/api.ts::target', 'target');
    const direct = node('src/api.test.ts::direct', 'direct', { filePath: 'src/api.test.ts', isTest: true });
    const selected = selectReachingTestsFromFullGraph({ nodes: [target, direct], edges: [
      { callerId: direct.id, calleeId: target.id, calleeName: 'target', confidence: 'import', kind: 'calls' },
      { callerId: target.id, calleeId: direct.id, calleeName: 'direct', confidence: 'import', kind: 'tested_by' },
    ] } as never, [target.id]);
    expect(selected.tests).toMatchObject([{ test: 'direct', file: 'src/api.test.ts' }]);
  });

  it('bounds traversal nodes and discloses truncation on a wide graph', () => {
    const target = node('src/api.ts::target', 'target');
    const callers = Array.from({ length: 5000 }, (_, index) => node(`src/u${index}.ts::u`, `u${index}`));
    const selected = selectReachingTestsFromFullGraph({ nodes: [target, ...callers], edges: callers.map(caller => ({
      callerId: caller.id, calleeId: target.id, calleeName: 'target', confidence: 'import', kind: 'calls',
    })) } as never, [target.id]);
    expect(selected.truncated).toBe(true);
    expect(selected.tests).toEqual([]);
  });
});
