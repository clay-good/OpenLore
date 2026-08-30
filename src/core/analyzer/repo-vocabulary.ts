/**
 * Deterministic, repository-derived vocabulary used to widen keyword recall.
 *
 * The artifact is deliberately query-side: the BM25 corpus is never expanded.
 * Entries are accepted only when both terms exist in that corpus, and the
 * sidecar is tied to the corpus content stamp so an incremental mutation fails
 * closed to ordinary keyword retrieval.
 */

import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { TOKENIZER_VERSION, tokenize } from './bm25-tokenizer.js';

export const REPO_VOCABULARY_SCHEMA_VERSION = 1;
export const REPO_VOCABULARY_FILE = 'repo-vocabulary.json';
export const REPO_VOCABULARY_EXPANSIONS_PER_TOKEN = 5;
export const REPO_VOCABULARY_MINING_BUDGET_MS = 250;

const MAX_TERMS_PER_BINDING_SITE = 24;
const MAX_ABBREVIATION_CANDIDATES = 100_000;
const MAX_COOCCURRENCE_CANDIDATES = 100_000;
const MAX_BINDING_TERMS = 20_000;
const MAX_OUTPUT_LINKS = 20_000;
const MAX_CALL_EDGES = 500_000;
const MAX_CALLEES_PER_SOURCE = 32;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const MIN_ATTESTING_SITES = 2;
const MAX_MINING_SOURCES = 50_000;
const MAX_MINING_CORPUS_TERMS = 50_000;
const MAX_SOURCE_CONTEXT_CHARS = 4_096;

function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The only links allowed without two repository binding sites. */
export const UNIVERSAL_PROGRAMMING_ABBREVIATIONS = Object.freeze({
  auth: 'authentication',
  cfg: 'config',
  repo: 'repository',
  svc: 'service',
  txn: 'transaction',
} as const);

export interface RepositoryVocabularySource {
  id: string;
  name: string;
  className?: string;
  signature?: string;
  docstring?: string;
  filePath: string;
  text?: string;
}

export interface RepositoryVocabulary {
  schemaVersion: number;
  tokenizerVersion: number;
  contentStamp: string;
  status: 'complete' | 'partial';
  omittedCandidateInputCount: number;
  /** Stable, sorted term -> sorted expansion list. */
  entries: Array<[string, string[]]>;
  payloadHash: string;
}

export interface VocabularyQueryExpansion {
  originalTokens: string[];
  expansionTokens: string[];
  vocabularyAvailable: boolean;
}

export interface VocabularyRankScore {
  id: string;
  score: number;
  expansionScore: number;
}

/** Strict original-match tier, then ordinary score ordering within each tier. */
export function compareVocabularyRank(a: VocabularyRankScore, b: VocabularyRankScore): number {
  return Number(b.score > 0) - Number(a.score > 0)
    || b.score - a.score
    || b.expansionScore - a.expansionScore
    || ordinalCompare(a.id, b.id);
}

function vocabularyPath(dbPath: string): string {
  return join(dbPath, REPO_VOCABULARY_FILE);
}

const vocabularyCache = new Map<string, {
  metaStamp: string | null;
  vocabularyStamp: string | null;
  value: RepositoryVocabulary | null;
}>();

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

function isWord(token: string): boolean {
  return token.length >= 2 && /^[a-z0-9]+$/.test(token);
}

function stableTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter(isWord))].sort(ordinalCompare);
}

function isSubsequence(short: string, long: string): boolean {
  let index = 0;
  for (const char of long) {
    if (char === short[index]) index++;
    if (index === short.length) return true;
  }
  return false;
}

function abbreviationDirection(left: string, right: string): [string, string] | null {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return short[0] === long[0] && isSubsequence(short, long) ? [short, long] : null;
}

function sharedSiteCount(a: Set<string>, b: Set<string>, stopAt = MIN_ATTESTING_SITES): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const site of small) {
    if (!large.has(site)) continue;
    count++;
    if (count >= stopAt) break;
  }
  return count;
}

function morphologicalStem(token: string): string | null {
  const rules: Array<[RegExp, string]> = [
    [/tion$/, 'te'],
    [/ing$/, ''],
    [/ed$/, ''],
    [/er$/, ''],
    [/s$/, ''],
  ];
  for (const [suffix, replacement] of rules) {
    if (!suffix.test(token)) continue;
    const stem = token.replace(suffix, replacement);
    return stem.length >= 3 ? stem : null;
  }
  return null;
}

function payloadHash(value: Omit<RepositoryVocabulary, 'payloadHash'>): string {
  return createHash('sha256')
    .update('openlore-repo-vocabulary-v1\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function addLink(links: Map<string, Map<string, number>>, left: string, right: string, priority: number): void {
  if (left === right) return;
  let leftLinks = links.get(left);
  if (!leftLinks) links.set(left, leftLinks = new Map());
  leftLinks.set(right, Math.max(priority, leftLinks.get(right) ?? 0));
  let rightLinks = links.get(right);
  if (!rightLinks) links.set(right, rightLinks = new Map());
  rightLinks.set(left, Math.max(priority, rightLinks.get(left) ?? 0));
}

/**
 * Mine a bounded vocabulary from already-resident index records.
 * Candidate generation uses first-character/length buckets; no all-pairs walk.
 */
export function mineRepositoryVocabulary(
  sources: readonly RepositoryVocabularySource[],
  corpusDf: ReadonlyMap<string, number>,
  contentStamp: string,
  options: {
    budgetMs?: number;
    now?: () => number;
    contextForSource?: (source: RepositoryVocabularySource) => string | undefined;
    callEdges?: readonly { callerId: string; calleeId: string }[];
  } = {},
): RepositoryVocabulary {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.budgetMs ?? REPO_VOCABULARY_MINING_BUDGET_MS;
  const startedAt = now();
  const miningInputHash = createHash('sha256')
    .update('openlore-repo-vocabulary-input-v1\0')
    .update(contentStamp);
  const bindingTermSites = new Map<string, Set<string>>();
  const assignmentSites = new Map<string, Set<string>>();
  const cooccurrence = new Map<string, number>();
  let exhausted = sources.length > MAX_MINING_SOURCES
    || corpusDf.size > MAX_MINING_CORPUS_TERMS
    || (options.callEdges?.length ?? 0) > MAX_CALL_EDGES;
  const deadlineReached = (): boolean => now() - startedAt >= budgetMs;

  const orderedSources = exhausted ? [] : [...sources].sort((a, b) => ordinalCompare(a.id, b.id));
  const sourceById = new Map(orderedSources.map(source => [source.id, source]));
  const calleeIds = new Map<string, string[]>();
  for (let edgeIndex = 0; !exhausted && edgeIndex < (options.callEdges?.length ?? 0); edgeIndex++) {
    if ((edgeIndex & 127) === 0 && deadlineReached()) {
      exhausted = true;
      break;
    }
    const edge = options.callEdges![edgeIndex];
    if (!sourceById.has(edge.callerId) || !sourceById.has(edge.calleeId)) continue;
    let ids = calleeIds.get(edge.callerId);
    if (!ids) calleeIds.set(edge.callerId, ids = []);
    if (ids.includes(edge.calleeId)) continue;
    ids.push(edge.calleeId);
    ids.sort(ordinalCompare);
    if (ids.length > MAX_CALLEES_PER_SOURCE) ids.pop();
  }
  sourceLoop: for (let sourceIndex = 0; sourceIndex < orderedSources.length; sourceIndex++) {
    if (deadlineReached()) {
      exhausted = true;
      break;
    }
    const source = orderedSources[sourceIndex];
    let callContext = '';
    for (const id of calleeIds.get(source.id) ?? []) {
      const callee = sourceById.get(id)!;
      const remaining = MAX_SOURCE_CONTEXT_CHARS / 2 - callContext.length;
      if (remaining <= 0) break;
      const piece = [callee.name, callee.className ?? '', callee.signature ?? '', callee.docstring ?? '']
        .map(value => value.slice(0, remaining))
        .join(' ')
        .slice(0, remaining);
      callContext += `${callContext ? ' ' : ''}${piece}`;
    }
    const localContext = (options.contextForSource?.(source) ?? source.text ?? '')
      .slice(0, MAX_SOURCE_CONTEXT_CHARS / 2);
    const sourceContext = `${localContext} ${callContext}`;
    miningInputHash.update(JSON.stringify([
      source.id,
      source.name.slice(0, MAX_SOURCE_CONTEXT_CHARS),
      (source.className ?? '').slice(0, MAX_SOURCE_CONTEXT_CHARS),
      (source.signature ?? '').slice(0, MAX_SOURCE_CONTEXT_CHARS),
      (source.docstring ?? '').slice(0, MAX_SOURCE_CONTEXT_CHARS),
      localContext,
      callContext,
    ]));
    const bindingTerms = stableTerms([
      source.name.slice(0, MAX_SOURCE_CONTEXT_CHARS),
      (source.className ?? '').slice(0, MAX_SOURCE_CONTEXT_CHARS),
      (source.signature ?? '').slice(0, MAX_SOURCE_CONTEXT_CHARS),
      (source.docstring ?? '').slice(0, MAX_SOURCE_CONTEXT_CHARS),
      callContext.slice(0, MAX_SOURCE_CONTEXT_CHARS / 2),
    ].join(' ')).filter((term) => corpusDf.has(term)).slice(0, MAX_TERMS_PER_BINDING_SITE);
    const contextTerms = stableTerms([
      ...bindingTerms,
      source.filePath,
      sourceContext,
    ].join(' ')).filter((term) => corpusDf.has(term)).slice(0, MAX_TERMS_PER_BINDING_SITE);
    let assignmentCount = 0;
    for (const match of localContext.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (assignmentCount++ >= MAX_TERMS_PER_BINDING_SITE) break;
      const [variable] = tokenize(match[1]);
      const [callee] = tokenize(match[2]);
      if (!variable || !callee || !corpusDf.has(variable) || !corpusDf.has(callee)) continue;
      const key = ordinalCompare(variable, callee) <= 0 ? `${variable}\0${callee}` : `${callee}\0${variable}`;
      let sites = assignmentSites.get(key);
      if (!sites) assignmentSites.set(key, sites = new Set());
      sites.add(source.id);
    }
    for (const term of bindingTerms) {
      let sites = bindingTermSites.get(term);
      if (!sites) {
        if (bindingTermSites.size >= MAX_BINDING_TERMS) {
          exhausted = true;
          break sourceLoop;
        }
        bindingTermSites.set(term, sites = new Set());
      }
      sites.add(source.id);
    }
    // Immediate symbol/doc/signature context is one binding neighborhood. Cap it
    // before pairing so pathological generated declarations stay bounded.
    for (let i = 0; i < contextTerms.length; i++) {
      for (let j = i + 1; j < contextTerms.length; j++) {
        const key = `${contextTerms[i]}\0${contextTerms[j]}`;
        if (!cooccurrence.has(key) && cooccurrence.size >= MAX_COOCCURRENCE_CANDIDATES) {
          exhausted = true;
          break sourceLoop;
        }
        cooccurrence.set(key, (cooccurrence.get(key) ?? 0) + 1);
      }
    }
  }

  let links = new Map<string, Map<string, number>>();
  if (!exhausted && deadlineReached()) exhausted = true;
  if (!exhausted) {
    for (const [pair, sites] of assignmentSites) {
      if (sites.size < MIN_ATTESTING_SITES) continue;
      const [variable, callee] = pair.split('\0');
      const abbreviation = abbreviationDirection(variable, callee);
      if (!abbreviation || abbreviation[0].length < 3
          || abbreviation[1].length > abbreviation[0].length * 3) continue;
      addLink(links, abbreviation[0], abbreviation[1], 3);
    }
  }
  const bindingTerms = exhausted ? [] : [...bindingTermSites.keys()].sort(ordinalCompare);
  const longBuckets = new Map<string, string[]>();
  for (let termIndex = 0; termIndex < bindingTerms.length; termIndex++) {
    if ((termIndex & 127) === 0 && deadlineReached()) {
      exhausted = true;
      break;
    }
    const term = bindingTerms[termIndex];
    const key = `${term[0]}:${Math.ceil(term.length / 3)}`;
    let bucket = longBuckets.get(key);
    if (!bucket) longBuckets.set(key, bucket = []);
    bucket.push(term);
  }

  let checked = 0;
  outer: for (const short of exhausted ? [] : bindingTerms) {
    if (short.length < 3) continue;
    for (let band = Math.ceil(short.length / 3); band <= short.length; band++) {
      for (const long of longBuckets.get(`${short[0]}:${band}`) ?? []) {
        checked++;
        if (checked > MAX_ABBREVIATION_CANDIDATES
            || ((checked & 127) === 0 && deadlineReached())) {
          exhausted = true;
          break outer;
        }
        if (long.length <= short.length || long.length > short.length * 3) continue;
        if (!isSubsequence(short, long)) continue;
        if (sharedSiteCount(bindingTermSites.get(short)!, bindingTermSites.get(long)!) < MIN_ATTESTING_SITES) continue;
        addLink(links, short, long, 3);
      }
    }
  }

  // Repeated local co-occurrence is evidence, but remains capped by the same
  // bounded binding-site vocabulary used above.
  const cooccurrenceEntries = exhausted
    ? []
    : [...cooccurrence].sort(([a], [b]) => ordinalCompare(a, b));
  for (let pairIndex = 0; pairIndex < cooccurrenceEntries.length; pairIndex++) {
    if (pairIndex >= MAX_COOCCURRENCE_CANDIDATES
        || ((pairIndex & 127) === 0 && deadlineReached())) {
      exhausted = true;
      break;
    }
    const [pair, count] = cooccurrenceEntries[pairIndex];
    if (count < MIN_ATTESTING_SITES) continue;
    const [left, right] = pair.split('\0');
    const abbreviation = abbreviationDirection(left, right);
    if (abbreviation && (links.get(abbreviation[0])?.get(abbreviation[1]) ?? 0) < 3) continue;
    addLink(links, left, right, 1);
  }

  if (!exhausted && deadlineReached()) exhausted = true;
  if (!exhausted) {
    const byStem = new Map<string, string[]>();
    const corpusTerms = [...corpusDf.keys()].sort(ordinalCompare);
    for (let termIndex = 0; termIndex < corpusTerms.length; termIndex++) {
      if ((termIndex & 127) === 0 && deadlineReached()) {
        exhausted = true;
        break;
      }
      const term = corpusTerms[termIndex];
      const stem = morphologicalStem(term);
      if (!stem) continue;
      if (corpusDf.has(stem)) addLink(links, term, stem, 2);
      let variants = byStem.get(stem);
      if (!variants) byStem.set(stem, variants = []);
      variants.push(term);
    }
    if (!exhausted) {
      let variantIndex = 0;
      for (const variants of byStem.values()) {
        if ((variantIndex++ & 127) === 0 && deadlineReached()) {
          exhausted = true;
          break;
        }
        if (variants.length !== 2) continue;
        addLink(links, variants[0], variants[1], 2);
      }
    }
  }

  if (!exhausted) {
    let outputLinks = 0;
    for (const expansions of links.values()) {
      outputLinks += expansions.size;
      if (outputLinks > MAX_OUTPUT_LINKS || deadlineReached()) {
        exhausted = true;
        break;
      }
    }
  }
  // Any cutoff discards all optional mining work. This keeps partial artifacts
  // byte-identical across machines while the tiny seed pass remains bounded.
  if (exhausted) links = new Map();
  for (const [short, long] of Object.entries(UNIVERSAL_PROGRAMMING_ABBREVIATIONS)) {
    if (corpusDf.has(short) && corpusDf.has(long)) addLink(links, short, long, 4);
  }

  const entries: Array<[string, string[]]> = [...links]
    .map(([term, expansions]) => [
      term,
      [...expansions]
        // A time cutoff can occur at different loop positions on different
        // machines. Canonical partial artifacts retain only links derived
        // independently of those loops, making their bytes reproducible.
        .filter(([, priority]) => !exhausted || priority >= 2)
        .filter(([candidate]) => corpusDf.has(candidate))
        .sort(([candidateA, priorityA], [candidateB, priorityB]) =>
          priorityB - priorityA || ordinalCompare(candidateA, candidateB),
        )
        .map(([candidate]) => candidate)
        .slice(0, REPO_VOCABULARY_EXPANSIONS_PER_TOKEN)
        .sort(ordinalCompare),
    ] as [string, string[]])
    .filter(([, expansions]) => expansions.length > 0)
    .sort(([a], [b]) => ordinalCompare(a, b));

  const vocabularyContentStamp = exhausted
    ? createHash('sha256')
        .update('openlore-repo-vocabulary-partial-input-v1\0')
        .update(contentStamp)
        .update(JSON.stringify([sources.length, corpusDf.size, options.callEdges?.length ?? 0]))
        .digest('hex')
    : miningInputHash.digest('hex');
  const base: Omit<RepositoryVocabulary, 'payloadHash'> = {
    schemaVersion: REPO_VOCABULARY_SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    contentStamp: vocabularyContentStamp,
    status: exhausted ? 'partial' : 'complete',
    // On a partial run every optional source-site and corpus-term candidate is
    // deliberately omitted; only the fixed seed set above is retained.
    omittedCandidateInputCount: exhausted
      ? sources.length + corpusDf.size + (options.callEdges?.length ?? 0)
      : 0,
    entries,
  };
  return { ...base, payloadHash: payloadHash(base) };
}

export async function persistRepositoryVocabulary(dbPath: string, vocabulary: RepositoryVocabulary): Promise<void> {
  await atomicWriteFile(vocabularyPath(dbPath), JSON.stringify(vocabulary) + '\n');
}

export function invalidateRepositoryVocabulary(dbPath: string, strict = false): void {
  vocabularyCache.delete(dirname(dbPath));
  try {
    rmSync(vocabularyPath(dbPath), { force: true });
    if (strict && existsSync(vocabularyPath(dbPath))) {
      throw new Error('Repository vocabulary sidecar still exists after invalidation');
    }
  } catch (error) {
    if (strict) throw error;
    /* optional artifact; absence is ordinary keyword mode */
  }
}

function readBoundedNoFollow(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_SIDECAR_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SIDECAR_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total).toString('utf8');
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validVocabulary(value: unknown, contentStamp: string): RepositoryVocabulary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== REPO_VOCABULARY_SCHEMA_VERSION
      || raw.tokenizerVersion !== TOKENIZER_VERSION
      || raw.contentStamp !== contentStamp
      || (raw.status !== 'complete' && raw.status !== 'partial')
      || !Number.isSafeInteger(raw.omittedCandidateInputCount) || (raw.omittedCandidateInputCount as number) < 0
      || !Array.isArray(raw.entries)
      || typeof raw.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.payloadHash)) return null;
  let previous = '';
  for (const entry of raw.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || entry[0].length === 0 || entry[0] <= previous || !Array.isArray(entry[1])
        || entry[1].length === 0 || entry[1].length > REPO_VOCABULARY_EXPANSIONS_PER_TOKEN) return null;
    previous = entry[0];
    let priorExpansion = '';
    for (const expansion of entry[1]) {
      if (typeof expansion !== 'string' || expansion.length === 0 || expansion <= priorExpansion) return null;
      priorExpansion = expansion;
    }
  }
  const vocabulary = raw as unknown as RepositoryVocabulary;
  const { payloadHash: recordedHash, ...base } = vocabulary;
  return payloadHash(base) === recordedHash ? vocabulary : null;
}

/** Load only when both the lexicon and authoritative code-corpus stamps agree. */
export function loadRepositoryVocabulary(outputDir: string): RepositoryVocabulary | null {
  const dbPath = join(outputDir, 'vector-index');
  const metaPath = join(outputDir, 'vector-index-meta.json');
  const sidecarPath = vocabularyPath(dbPath);
  const metaStamp = fileStamp(metaPath);
  const vocabularyStamp = fileStamp(sidecarPath);
  const cached = vocabularyCache.get(outputDir);
  if (cached && cached.metaStamp === metaStamp && cached.vocabularyStamp === vocabularyStamp) {
    return cached.value;
  }
  const remember = (value: RepositoryVocabulary | null): RepositoryVocabulary | null => {
    vocabularyCache.set(outputDir, { metaStamp, vocabularyStamp, value });
    return value;
  };
  const metaJson = readBoundedNoFollow(metaPath);
  if (metaJson === null) return remember(null);
  let contentStamp: string;
  try {
    const meta = JSON.parse(metaJson) as { vocabularyContentStamp?: unknown };
    if (typeof meta.vocabularyContentStamp !== 'string'
        || !/^[a-f0-9]{64}$/.test(meta.vocabularyContentStamp)) return remember(null);
    contentStamp = meta.vocabularyContentStamp;
  } catch {
    return remember(null);
  }
  const json = readBoundedNoFollow(sidecarPath);
  if (json === null) return remember(null);
  try {
    return remember(validVocabulary(JSON.parse(json), contentStamp));
  } catch {
    return remember(null);
  }
}

export function _resetRepositoryVocabularyCacheForTesting(): void {
  vocabularyCache.clear();
}

export function expandVocabularyQuery(
  outputDir: string,
  originalTokens: string[],
  enabled = true,
): VocabularyQueryExpansion {
  if (!enabled) return { originalTokens, expansionTokens: [], vocabularyAvailable: false };
  const vocabulary = loadRepositoryVocabulary(outputDir);
  if (!vocabulary || vocabulary.entries.length === 0) {
    return { originalTokens, expansionTokens: [], vocabularyAvailable: false };
  }
  const byTerm = new Map(vocabulary.entries);
  const original = new Set(originalTokens);
  const expansionTokens: string[] = [];
  const seen = new Set<string>();
  for (const token of original) {
    for (const expansion of byTerm.get(token) ?? []) {
      if (original.has(expansion) || seen.has(expansion)) continue;
      seen.add(expansion);
      expansionTokens.push(expansion);
    }
  }
  return { originalTokens, expansionTokens, vocabularyAvailable: true };
}

/** Expansion terms that made a non-zero contribution to one result. */
export function scoredExpansionTerms(
  expansionTokens: readonly string[],
  termFrequencies: ReadonlyMap<string, number>,
): string[] {
  return expansionTokens.filter((token) => (termFrequencies.get(token) ?? 0) > 0);
}
