/**
 * change: add-edit-loop-breakage-verdict
 *
 * Deterministic, watcher-produced edit verdicts.
 *
 * The watcher is the only writer. Readers never analyze: they validate the
 * artifact against the current analysis generation and the edited file's
 * content hash, then serve the already-derived findings.
 */

import { createHash } from 'node:crypto';
import { access, open } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { readCurrentGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../runtime/analysis-generation.js';
import { OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../constants.js';
import type { CallEdge, FunctionNode, SerializedCallGraph } from '../analyzer/call-graph.js';
import type { GovernanceFinding } from './mcp-handlers/enforcement-policy.js';
import type { EdgeStore } from './edge-store.js';
import { isTestFile } from '../analyzer/test-file.js';
import { readFileConfined } from '../../utils/path-confinement.js';

export const EDIT_VERDICT_ARTIFACT = 'edit-verdicts.json';
const EDIT_VERDICT_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_REACHABILITY_DEPTH = 12;
const MAX_REACHABILITY_NODES = 4096;
const MAX_REACHING_TESTS = 256;
const MAX_FINDINGS = 512;
const MAX_ENTRIES = 2048;
export const MAX_EDIT_VERDICT_BASIS_FILES = 2048;
export const MAX_EDIT_VERDICT_BASIS_FILE_BYTES = 10_000_000;
export const MAX_EDIT_VERDICT_BASIS_TOTAL_BYTES = 64_000_000;
const MAX_PATH_LENGTH = 1024;
const MAX_TEXT_LENGTH = 4096;
const MAX_PATH_STEPS = 64;
const PRECISE_CALL_CONFIDENCES = new Set<CallEdge['confidence']>([
  'import', 're_export', 'same_file', 'self_cls',
]);
const FINDING_CODES = new Set([
  'edit-broken-reference', 'edit-arity-mismatch', 'edit-import-breakage',
]);

export interface EditVerdictBasis {
  file: string;
  contentHash: string;
}

export interface EditReachingTest {
  test: string;
  file: string;
  viaPath: string[];
  basisFiles?: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface EditVerdictBoundary {
  staleFiles: string[];
  reachingTestsBasis: 'incremental-graph' | 'last-full-analysis';
  reachingTestsTruncated?: boolean;
  findingsTruncated?: boolean;
  staleFilesTruncated?: boolean;
  staleFileCount?: number;
}

export interface EditVerdictStoreBoundary {
  entriesEvicted: number;
  evictedFiles: string[];
  bytesBounded?: true;
}

export interface EditVerdict {
  file: string;
  contentHash: string;
  findings: GovernanceFinding[];
  reachingTests: EditReachingTest[];
  languageScope: string[];
  boundaries: EditVerdictBoundary;
  basis?: EditVerdictBasis[];
}

export interface EditVerdictStore {
  version: 1;
  analysisGenerationId: string;
  entries: EditVerdict[];
  boundaries?: EditVerdictStoreBoundary;
}

export type EditVerdictRead =
  | { status: 'current'; entries: EditVerdict[]; storeBoundaries?: EditVerdictStoreBoundary }
  | { status: 'missing' | 'stale' | 'invalid'; entries: []; reason: string };

export interface EditCallSite {
  callerId: string;
  callerFile: string;
  calleeId: string;
  calleeName: string;
  line?: number;
  argCount?: number;
  argCountLowerBound?: true;
  confidence?: CallEdge['confidence'];
  kind?: CallEdge['kind'];
}

export interface ImportBreakageSite {
  importerFile: string;
  importedName: string;
  line?: number;
}

export interface GraphVerdictInput {
  file: string;
  contentHash: string;
  oldNodes: FunctionNode[];
  newNodes: FunctionNode[];
  oldIncoming: EditCallSite[];
  postOutgoingByCaller: ReadonlyMap<string, readonly CallEdge[]>;
  postIncoming: EditCallSite[];
  recomputedCallerFiles: ReadonlySet<string>;
  staleFiles: readonly string[];
  reachingTests: EditReachingTest[];
  reachingTestsTruncated?: boolean;
  reachingTestsBasis?: EditVerdictBoundary['reachingTestsBasis'];
  importBreakages?: ImportBreakageSite[];
  basis?: EditVerdictBasis[];
  basisSnapshots?: ReadonlyMap<string, string>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validPath(value: unknown): value is string {
  return validText(value) && value.length <= MAX_PATH_LENGTH && !value.startsWith('/') && !value.startsWith('\\') &&
    !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes('..');
}

function validLine(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validFinding(value: unknown): value is GovernanceFinding {
  if (!value || typeof value !== 'object') return false;
  const f = value as Partial<GovernanceFinding>;
  if (!FINDING_CODES.has(String(f.code)) || f.source !== 'edit-verdict' || f.severity !== 'error' ||
      !validText(f.subject) || !validText(f.message) || f.decision !== undefined) return false;
  if (f.discriminator !== undefined && !validText(f.discriminator)) return false;
  return f.location === undefined || (!!f.location && validPath(f.location.path) &&
    (f.location.line === undefined || validLine(f.location.line)));
}

function validEntry(value: unknown): value is EditVerdict {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<EditVerdict>;
  return validPath(e.file) && validHash(e.contentHash) &&
    Array.isArray(e.findings) && e.findings.length <= MAX_FINDINGS && e.findings.every(validFinding) &&
    Array.isArray(e.reachingTests) && e.reachingTests.length <= MAX_REACHING_TESTS &&
    e.reachingTests.every(test => !!test && typeof test === 'object' &&
      validText((test as EditReachingTest).test) && validPath((test as EditReachingTest).file) &&
      Array.isArray((test as EditReachingTest).viaPath) && (test as EditReachingTest).viaPath.length <= MAX_PATH_STEPS &&
      (test as EditReachingTest).viaPath.every(validText) &&
      (Array.isArray((test as EditReachingTest).basisFiles) &&
        (test as EditReachingTest).basisFiles!.length <= MAX_EDIT_VERDICT_BASIS_FILES &&
        (test as EditReachingTest).basisFiles!.every(validPath)) &&
      ['high', 'medium', 'low'].includes((test as EditReachingTest).confidence)) &&
    Array.isArray(e.languageScope) && e.languageScope.length <= 2 &&
    e.languageScope.every(language => language === 'Python' || language === 'TypeScript') &&
    !!e.boundaries && Array.isArray(e.boundaries.staleFiles) && e.boundaries.staleFiles.length <= MAX_EDIT_VERDICT_BASIS_FILES &&
    e.boundaries.staleFiles.every(validPath) &&
    (e.boundaries.reachingTestsBasis === 'incremental-graph' || e.boundaries.reachingTestsBasis === 'last-full-analysis') &&
    (e.boundaries.reachingTestsTruncated === undefined || typeof e.boundaries.reachingTestsTruncated === 'boolean') &&
    (e.boundaries.findingsTruncated === undefined || typeof e.boundaries.findingsTruncated === 'boolean') &&
    (e.boundaries.staleFilesTruncated === undefined || typeof e.boundaries.staleFilesTruncated === 'boolean') &&
    (e.boundaries.staleFileCount === undefined || (Number.isSafeInteger(e.boundaries.staleFileCount) && e.boundaries.staleFileCount >= e.boundaries.staleFiles.length)) &&
    Array.isArray(e.basis) && e.basis.length > 0 && e.basis.length <= MAX_EDIT_VERDICT_BASIS_FILES &&
    e.basis.every(b => !!b && typeof b === 'object' && validPath(b.file) && validHash(b.contentHash)) &&
    new Set(e.basis.map(b => b.file)).size === e.basis.length &&
    e.basis.some(b => b.file === e.file && b.contentHash === e.contentHash);
}

function validStoreBoundary(value: unknown): value is EditVerdictStoreBoundary {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<EditVerdictStoreBoundary>;
  return Number.isSafeInteger(b.entriesEvicted) && b.entriesEvicted! > 0 &&
    Array.isArray(b.evictedFiles) && b.evictedFiles.length <= MAX_ENTRIES && b.evictedFiles.every(validPath) &&
    (b.bytesBounded === undefined || b.bytesBounded === true);
}

export interface EditVerdictWriteOptions {
  previousGenerationId?: string;
  invalidatedFiles?: readonly string[];
  evictedFiles?: readonly string[];
}

export async function writeEditVerdictStore(
  outputPath: string,
  analysisGenerationId: string,
  entries: EditVerdict[],
  options: EditVerdictWriteOptions = {},
): Promise<void> {
  const replaced = new Set(entries.map(entry => entry.file));
  const invalidated = new Set(options.invalidatedFiles ?? []);
  const prior = options.previousGenerationId ? await readEditVerdictStore(outputPath) : null;
  const retained = prior !== null && prior.analysisGenerationId === options.previousGenerationId
    ? prior.entries.filter(entry => !replaced.has(entry.file) &&
      !entry.basis!.some(basis => invalidated.has(basis.file)))
    : [];
  const incoming = [...entries].sort((a, b) => a.file.localeCompare(b.file));
  const eligibleIncoming = incoming.filter(entry => validEntry(entry as unknown));
  const invalidIncoming = incoming.filter(entry => !validEntry(entry as unknown)).map(entry => entry.file);
  const candidates = [...eligibleIncoming, ...retained].filter((entry, index, all) =>
    all.findIndex(candidate => candidate.file === entry.file) === index);
  const maximumKept = Math.min(candidates.length, MAX_ENTRIES);
  const explicitlyEvicted = [...invalidIncoming, ...(options.evictedFiles ?? [])];
  const buildStore = (keepCount: number, bytesBounded: boolean): EditVerdictStore => {
    const evicted = [...new Set([
      ...explicitlyEvicted,
      ...candidates.slice(keepCount).map(entry => entry.file),
    ])];
    return {
      version: EDIT_VERDICT_VERSION,
      analysisGenerationId,
      entries: candidates.slice(0, keepCount).sort((a, b) => a.file.localeCompare(b.file)),
      ...(evicted.length > 0 ? { boundaries: {
        entriesEvicted: evicted.length,
        evictedFiles: evicted.filter(validPath).sort().slice(0, MAX_ENTRIES),
        ...(bytesBounded ? { bytesBounded: true as const } : {}),
      } } : {}),
    };
  };
  const serialize = (store: EditVerdictStore) => JSON.stringify(store, null, 2) + '\n';
  let store = buildStore(maximumKept, false);
  if (Buffer.byteLength(serialize(store)) > MAX_STORE_BYTES) {
    // Find a deterministic bounded prefix without repeatedly serializing and
    // removing one entry at a time (which is quadratic for a hostile store).
    let low = 0;
    let high = maximumKept;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(serialize(buildStore(middle, true))) <= MAX_STORE_BYTES) low = middle;
      else high = middle - 1;
    }
    store = buildStore(low, true);
  }
  if (Buffer.byteLength(serialize(store)) > MAX_STORE_BYTES ||
      (store.boundaries !== undefined && !validStoreBoundary(store.boundaries))) {
    const evictedCount = Math.max(1, explicitlyEvicted.length + candidates.length);
    store = { version: EDIT_VERDICT_VERSION, analysisGenerationId, entries: [], boundaries: {
      entriesEvicted: evictedCount, evictedFiles: [], bytesBounded: true,
    } };
  }
  await atomicWriteFile(join(outputPath, EDIT_VERDICT_ARTIFACT), serialize(store));
}

/** Size-bounded, shape-validated artifact read. Never quarantines or mutates. */
export async function readEditVerdictStore(outputPath: string): Promise<EditVerdictStore | null> {
  let handle;
  try {
    handle = await open(join(outputPath, EDIT_VERDICT_ARTIFACT), 'r');
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_STORE_BYTES) return null;
    const raw = await handle.readFile('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const store = parsed as Partial<EditVerdictStore>;
    if (store.version !== EDIT_VERDICT_VERSION || !validText(store.analysisGenerationId) ||
        !Array.isArray(store.entries) || store.entries.length > MAX_ENTRIES || !store.entries.every(validEntry) ||
        new Set(store.entries.map(entry => entry.file)).size !== store.entries.length ||
        (store.boundaries !== undefined && !validStoreBoundary(store.boundaries))) return null;
    return store as EditVerdictStore;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read only verdicts that belong to the current committed analysis generation
 * and still match their edited file's bytes.
 */
export async function readCurrentEditVerdicts(
  rootPath: string,
  files?: readonly string[],
): Promise<EditVerdictRead> {
  const outputPath = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const store = await readEditVerdictStore(outputPath);
  if (!store) {
    try {
      await access(join(outputPath, EDIT_VERDICT_ARTIFACT));
      return { status: 'invalid', entries: [], reason: 'The watcher verdict artifact is malformed or exceeds its size limit.' };
    } catch {
      return { status: 'missing', entries: [], reason: 'No watcher verdict is available.' };
    }
  }
  const generation = await readCurrentGeneration(outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS]);
  if (!generation || generation.generationId !== store.analysisGenerationId) {
    return { status: 'stale', entries: [], reason: 'The watcher verdict belongs to an older analysis generation.' };
  }
  const wanted = files ? new Set(files) : undefined;
  const candidates = wanted ? store.entries.filter(entry => wanted.has(entry.file)) : store.entries;
  if (wanted && candidates.length !== wanted.size) {
    const evicted = store.boundaries?.evictedFiles.some(file => wanted.has(file));
    return { status: 'stale', entries: [], reason: evicted
      ? 'The requested verdict was deterministically evicted to keep the watcher artifact bounded.'
      : 'The watcher store has no verdict for every requested file.' };
  }
  const current: EditVerdict[] = [];
  let basisBytes = 0;
  const verified = new Map<string, string>();
  for (const entry of candidates) {
    for (const basis of entry.basis!) {
      const priorHash = verified.get(basis.file);
      if (priorHash !== undefined) {
        if (priorHash !== basis.contentHash) return { status: 'stale', entries: [], reason: `Verdicts disagree about the basis hash for ${basis.file}.` };
        continue;
      }
      let content: string;
      try { content = await readFileConfined(rootPath, basis.file, MAX_EDIT_VERDICT_BASIS_FILE_BYTES); }
      catch {
        return { status: 'stale', entries: [], reason: `The verdict input ${basis.file} is no longer readable.` };
      }
      if (sha256(content) !== basis.contentHash) {
        return { status: 'stale', entries: [], reason: `The verdict input ${basis.file} does not match its recorded content.` };
      }
      basisBytes += Buffer.byteLength(content);
      if (basisBytes > MAX_EDIT_VERDICT_BASIS_TOTAL_BYTES) {
        return { status: 'stale', entries: [], reason: 'The verdict basis exceeds the aggregate read budget.' };
      }
      verified.set(basis.file, basis.contentHash);
    }
    current.push(entry);
  }
  const finalGeneration = await readCurrentGeneration(outputPath, [...REQUIRED_ANALYSIS_ARTIFACTS]);
  if (!finalGeneration || finalGeneration.generationId !== store.analysisGenerationId) {
    return { status: 'stale', entries: [], reason: 'The analysis generation changed while the watcher verdict was being read.' };
  }
  return { status: 'current', entries: current, ...(store.boundaries ? { storeBoundaries: store.boundaries } : {}) };
}

function siteDiscriminator(site: EditCallSite, suffix = ''): string {
  return `${site.callerFile}:${site.line ?? '?'}:${site.calleeName}${suffix}`;
}

function isSameCallSite(edge: CallEdge, site: EditCallSite): boolean {
  return edge.callerId === site.callerId && edge.calleeName === site.calleeName && edge.line === site.line &&
    edge.argCount === site.argCount && !!edge.argCountLowerBound === !!site.argCountLowerBound;
}

function callSiteKey(site: EditCallSite): string {
  return [site.callerId, site.calleeId, site.calleeName, site.line ?? '', site.argCount ?? '',
    site.argCountLowerBound ? 1 : 0].join('\0');
}

/** Pure, conservative verdict derivation over facts captured around one batch. */
export function deriveEditVerdict(input: GraphVerdictInput): EditVerdict {
  const findings: GovernanceFinding[] = [];
  const newIds = new Set(input.newNodes.map(n => n.id));
  const removedIds = new Set(input.oldNodes.filter(n => !newIds.has(n.id)).map(n => n.id));

  for (const site of input.oldIncoming) {
    if (!removedIds.has(site.calleeId) || site.callerFile === input.file || !site.confidence ||
        !PRECISE_CALL_CONFIDENCES.has(site.confidence) ||
        !input.recomputedCallerFiles.has(site.callerFile)) continue;
    const postCandidates = input.postOutgoingByCaller.get(site.callerId)?.filter(e => isSameCallSite(e, site)) ?? [];
    const post = postCandidates.length === 1 ? postCandidates[0] : undefined;
    if (!post) continue;
    // A surviving site is broken only when it no longer resolves to a live new
    // definition from this file. The caller may now be external or dangling.
    const unresolved = post.confidence === 'external' || removedIds.has(post.calleeId);
    if (!unresolved) continue;
    findings.push({
      code: 'edit-broken-reference', severity: 'error', source: 'edit-verdict',
      subject: site.calleeName,
      message: `${site.callerFile}:${site.line ?? '?'} still calls ${site.calleeName}, which this edit removed or renamed.`,
      discriminator: siteDiscriminator(site),
      location: { path: site.callerFile, ...(site.line !== undefined ? { line: site.line } : {}) },
    });
  }

  const oldSitesByKey = new Map<string, EditCallSite[]>();
  for (const site of input.oldIncoming) {
    const key = callSiteKey(site);
    const sites = oldSitesByKey.get(key) ?? [];
    sites.push(site);
    oldSitesByKey.set(key, sites);
  }
  const oldNodeById = new Map(input.oldNodes.map(n => [n.id, n]));
  const nodeById = new Map(input.newNodes.map(n => [n.id, n]));
  for (const site of input.postIncoming) {
    if (site.callerFile === input.file || input.staleFiles.includes(site.callerFile)) continue;
    const node = nodeById.get(site.calleeId);
    const oldNode = oldNodeById.get(site.calleeId);
    const arity = node?.callArity;
    const oldArity = oldNode?.callArity;
    const oldCandidates = oldSitesByKey.get(callSiteKey(site)) ?? [];
    const oldSite = oldCandidates.length === 1 ? oldCandidates[0] : undefined;
    // JS intentionally has no callArity. Any uncertainty makes this lane silent.
    if (!arity || !oldArity || arity.overloaded || arity.variadic ||
        oldArity.overloaded || oldArity.variadic || !oldSite ||
        site.argCount === undefined || oldSite.argCount === undefined ||
        !site.confidence || !oldSite.confidence ||
        !PRECISE_CALL_CONFIDENCES.has(site.confidence) || !PRECISE_CALL_CONFIDENCES.has(oldSite.confidence) ||
        (site.kind !== undefined && site.kind !== 'calls') ||
        (oldSite.kind !== undefined && oldSite.kind !== 'calls') ||
        site.argCountLowerBound || oldSite.argCountLowerBound ||
        arity.hasOptionalOrDefault || oldArity.hasOptionalOrDefault) continue;
    if (oldSite.argCount < oldArity.required || oldSite.argCount > oldArity.total) continue;
    const supplied = site.argCount;
    if (supplied >= arity.required && supplied <= arity.total) continue;
    findings.push({
      code: 'edit-arity-mismatch', severity: 'error', source: 'edit-verdict',
      subject: node.name,
      message: `${site.callerFile}:${site.line ?? '?'} supplies ${site.argCount} argument(s) to ${node.name}; its exact supported arity is ${arity.required === arity.total ? arity.total : `${arity.required}-${arity.total}`}.`,
      discriminator: siteDiscriminator(site, `:${site.argCount}`),
      location: { path: site.callerFile, ...(site.line !== undefined ? { line: site.line } : {}) },
    });
  }

  for (const site of input.importBreakages ?? []) {
    findings.push({
      code: 'edit-import-breakage', severity: 'error', source: 'edit-verdict',
      subject: site.importedName,
      message: `${site.importerFile}:${site.line ?? '?'} imports ${site.importedName}, which ${input.file} no longer exports.`,
      discriminator: `${site.importerFile}:${site.line ?? '?'}:${site.importedName}`,
      location: { path: site.importerFile, ...(site.line !== undefined ? { line: site.line } : {}) },
    });
  }

  findings.sort((a, b) => a.code.localeCompare(b.code) ||
    (a.location?.path ?? '').localeCompare(b.location?.path ?? '') ||
    (a.location?.line ?? 0) - (b.location?.line ?? 0) || a.subject.localeCompare(b.subject));
  const findingsTruncated = findings.length > MAX_FINDINGS;
  if (findingsTruncated) findings.length = MAX_FINDINGS;
  const languageScope = ['Python', 'TypeScript'];
  const staleFiles = [...new Set(input.staleFiles)].sort();
  const staleFilesTruncated = staleFiles.length > MAX_EDIT_VERDICT_BASIS_FILES;
  const staleFileCount = staleFiles.length;
  if (staleFilesTruncated) staleFiles.length = MAX_EDIT_VERDICT_BASIS_FILES;
  return {
    file: input.file,
    contentHash: input.contentHash,
    findings,
    reachingTests: input.reachingTests,
    languageScope,
    boundaries: {
      staleFiles,
      reachingTestsBasis: input.reachingTestsBasis ?? 'incremental-graph',
      ...(input.reachingTestsTruncated ? { reachingTestsTruncated: true } : {}),
      ...(findingsTruncated ? { findingsTruncated: true } : {}),
      ...(staleFilesTruncated ? { staleFilesTruncated: true, staleFileCount } : {}),
    },
    basis: input.basis ?? [{ file: input.file, contentHash: input.contentHash }],
  };
}

/** EdgeStore-backed form of select_tests' backward reachability. */
export function selectReachingTestsFromStore(
  store: EdgeStore,
  seedIds: readonly string[],
  maxDepth = MAX_REACHABILITY_DEPTH,
): { tests: EditReachingTest[]; truncated: boolean } {
  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const id of [...new Set(seedIds)].sort()) { depth.set(id, 0); queue.push(id); }
  let truncated = false;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const d = depth.get(id)!;
    const callers = store.getCallers(id).map(e => e.callerId).sort();
    if (d >= maxDepth) { if (callers.some(c => !depth.has(c))) truncated = true; continue; }
    for (const caller of callers) {
      if (depth.has(caller)) continue;
      if (depth.size >= MAX_REACHABILITY_NODES) { truncated = true; break; }
      depth.set(caller, d + 1);
      parent.set(caller, id);
      queue.push(caller);
    }
  }
  const tests: EditReachingTest[] = [];
  const seenTests = new Set<string>();
  const addTest = (node: FunctionNode, viaPath: string[], basisFiles: string[], confidence: EditReachingTest['confidence']) => {
    const key = `${node.filePath}\0${node.name}`;
    if (seenTests.has(key)) return;
    seenTests.add(key);
    tests.push({ test: node.name, file: node.filePath, viaPath, basisFiles: [...new Set(basisFiles)].sort(), confidence });
  };
  for (const [id, d] of depth) {
    if (d === 0) continue;
    const node = store.getNode(id);
    if (!node || !isTestFile(node.filePath)) continue;
    const viaPath: string[] = [];
    const basisFiles: string[] = [];
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const pathNode = store.getNode(cur);
      viaPath.push(pathNode?.name ?? cur);
      if (pathNode) basisFiles.push(pathNode.filePath);
      cur = parent.get(cur);
    }
    addTest(node, viaPath, basisFiles, d === 1 ? 'high' : d <= 3 ? 'medium' : 'low');
  }
  // Import-associated tests are represented as production -> test `tested_by`
  // edges, not callers, so mirror select_tests' second discovery lane.
  for (const [id, d] of depth) {
    for (const edge of store.getCallees(id)) {
      if (edge.kind !== 'tested_by') continue;
      const test = store.getNode(edge.calleeId);
      if (!test || !isTestFile(test.filePath)) continue;
      const viaPath: string[] = [test.name];
      const basisFiles: string[] = [test.filePath];
      let cur: string | undefined = id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const pathNode = store.getNode(cur);
        viaPath.push(pathNode?.name ?? cur);
        if (pathNode) basisFiles.push(pathNode.filePath);
        cur = parent.get(cur);
      }
      addTest(test, viaPath, basisFiles, d === 0 ? 'high' : 'medium');
    }
  }
  tests.sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test));
  if (tests.length > MAX_REACHING_TESTS) { tests.length = MAX_REACHING_TESTS; truncated = true; }
  return { tests, truncated };
}

/** Reaching tests from the retained full-analysis graph, which includes test nodes. */
export function selectReachingTestsFromFullGraph(
  graph: Pick<SerializedCallGraph, 'nodes' | 'edges'> | undefined,
  seedIds: readonly string[],
  maxDepth = MAX_REACHABILITY_DEPTH,
): { tests: EditReachingTest[]; truncated: boolean } {
  if (!graph) return { tests: [], truncated: false };
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const callers = new Map<string, string[]>();
  const testedBy = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const map = edge.kind === 'tested_by' ? testedBy : callers;
    const values = map.get(edge.calleeId) ?? [];
    // tested_by is production -> test, unlike ordinary caller -> callee.
    if (edge.kind === 'tested_by') {
      const tests = testedBy.get(edge.callerId) ?? [];
      tests.push(edge.calleeId);
      testedBy.set(edge.callerId, tests);
    } else {
      values.push(edge.callerId);
      map.set(edge.calleeId, values);
    }
  }
  const depth = new Map<string, number>();
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const id of [...new Set(seedIds)].sort()) if (nodes.has(id)) { depth.set(id, 0); queue.push(id); }
  let truncated = false;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const d = depth.get(id)!;
    const upstream = [...new Set(callers.get(id) ?? [])].sort();
    if (d >= maxDepth) { if (upstream.some(caller => !depth.has(caller))) truncated = true; continue; }
    for (const caller of upstream) {
      if (depth.has(caller)) continue;
      if (depth.size >= MAX_REACHABILITY_NODES) { truncated = true; break; }
      depth.set(caller, d + 1);
      parent.set(caller, id);
      queue.push(caller);
    }
  }
  const tests: EditReachingTest[] = [];
  const seen = new Set<string>();
  const add = (testId: string, anchorId: string, confidence: EditReachingTest['confidence']) => {
    const test = nodes.get(testId);
    if (!test || (!test.isTest && !isTestFile(test.filePath))) return;
    const key = `${test.filePath}\0${test.name}`;
    if (seen.has(key) || tests.length >= MAX_REACHING_TESTS) { if (!seen.has(key)) truncated = true; return; }
    const viaPath = [test.name];
    const basisFiles = [test.filePath];
    let current: string | undefined = anchorId;
    const pathSeen = new Set<string>();
    while (current && !pathSeen.has(current) && viaPath.length < MAX_PATH_STEPS) {
      pathSeen.add(current);
      const node = nodes.get(current);
      viaPath.push(node?.name ?? current);
      if (node) basisFiles.push(node.filePath);
      current = parent.get(current);
    }
    if (current) truncated = true;
    seen.add(key);
    tests.push({ test: test.name, file: test.filePath, viaPath,
      basisFiles: [...new Set(basisFiles)].sort(), confidence });
  };
  for (const [id, d] of depth) {
    const node = nodes.get(id);
    if (node?.isTest || (node && isTestFile(node.filePath))) {
      add(id, parent.get(id) ?? id, d === 1 ? 'high' : d <= 3 ? 'medium' : 'low');
    }
    for (const testId of [...new Set(testedBy.get(id) ?? [])].sort()) add(testId, id, d === 0 ? 'high' : 'medium');
  }
  tests.sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test));
  return { tests, truncated };
}

export function mergeReachingTests(
  ...groups: readonly EditReachingTest[][]
): EditReachingTest[] {
  const out = new Map<string, EditReachingTest>();
  for (const group of groups) for (const test of group) {
    const key = `${test.file}\0${test.test}`;
    if (!out.has(key)) out.set(key, test);
  }
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file) || a.test.localeCompare(b.test));
}
