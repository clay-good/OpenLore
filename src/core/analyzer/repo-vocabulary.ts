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
  fstatSync,
  openSync,
  readFileSync,
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
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const MIN_ATTESTING_SITES = 2;

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
  omittedCandidateCount: number;
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
    || a.id.localeCompare(b.id);
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
  return [...new Set(tokenize(text).filter(isWord))].sort();
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
  options: { budgetMs?: number; now?: () => number } = {},
): RepositoryVocabulary {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.budgetMs ?? REPO_VOCABULARY_MINING_BUDGET_MS;
  const startedAt = now();
  const bindingTermSites = new Map<string, Set<string>>();
  const cooccurrence = new Map<string, number>();
  let exhausted = false;

  const orderedSources = [...sources].sort((a, b) => a.id.localeCompare(b.id));
  for (let sourceIndex = 0; sourceIndex < orderedSources.length; sourceIndex++) {
    if ((sourceIndex & 63) === 0 && now() - startedAt >= budgetMs) {
      exhausted = true;
      break;
    }
    const source = orderedSources[sourceIndex];
    const bindingTerms = stableTerms([
      source.name,
      source.className ?? '',
      source.signature ?? '',
      source.docstring ?? '',
    ].join(' ')).filter((term) => corpusDf.has(term)).slice(0, MAX_TERMS_PER_BINDING_SITE);
    const contextTerms = stableTerms([
      ...bindingTerms,
      source.filePath,
      source.text ?? '',
    ].join(' ')).filter((term) => corpusDf.has(term)).slice(0, MAX_TERMS_PER_BINDING_SITE);
    for (const term of bindingTerms) {
      let sites = bindingTermSites.get(term);
      if (!sites) bindingTermSites.set(term, sites = new Set());
      sites.add(source.id);
    }
    // Immediate symbol/doc/signature context is one binding neighborhood. Cap it
    // before pairing so pathological generated declarations stay bounded.
    for (let i = 0; i < contextTerms.length; i++) {
      for (let j = i + 1; j < contextTerms.length; j++) {
        const key = `${contextTerms[i]}\0${contextTerms[j]}`;
        cooccurrence.set(key, (cooccurrence.get(key) ?? 0) + 1);
      }
    }
  }

  const links = new Map<string, Map<string, number>>();
  const bindingTerms = [...bindingTermSites.keys()].sort();
  const longBuckets = new Map<string, string[]>();
  for (const term of bindingTerms) {
    const key = `${term[0]}:${Math.ceil(term.length / 3)}`;
    let bucket = longBuckets.get(key);
    if (!bucket) longBuckets.set(key, bucket = []);
    bucket.push(term);
  }

  let checked = 0;
  outer: for (const short of bindingTerms) {
    if (short.length < 3) continue;
    for (let band = Math.ceil(short.length / 3); band <= short.length; band++) {
      for (const long of longBuckets.get(`${short[0]}:${band}`) ?? []) {
        checked++;
        if (checked > MAX_ABBREVIATION_CANDIDATES
            || ((checked & 127) === 0 && now() - startedAt >= budgetMs)) {
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
  const cooccurrenceEntries = [...cooccurrence].sort(([a], [b]) => a.localeCompare(b));
  for (let pairIndex = 0; pairIndex < cooccurrenceEntries.length; pairIndex++) {
    if (pairIndex >= MAX_COOCCURRENCE_CANDIDATES
        || ((pairIndex & 127) === 0 && now() - startedAt >= budgetMs)) {
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

  const byStem = new Map<string, string[]>();
  for (const term of [...corpusDf.keys()].sort()) {
    const stem = morphologicalStem(term);
    if (!stem) continue;
    if (corpusDf.has(stem)) addLink(links, term, stem, 2);
    let variants = byStem.get(stem);
    if (!variants) byStem.set(stem, variants = []);
    variants.push(term);
  }
  for (const variants of byStem.values()) {
    if (variants.length !== 2) continue;
    addLink(links, variants[0], variants[1], 2);
  }

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
          priorityB - priorityA || candidateA.localeCompare(candidateB),
        )
        .map(([candidate]) => candidate)
        .slice(0, REPO_VOCABULARY_EXPANSIONS_PER_TOKEN)
        .sort(),
    ] as [string, string[]])
    .filter(([, expansions]) => expansions.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  const base: Omit<RepositoryVocabulary, 'payloadHash'> = {
    schemaVersion: REPO_VOCABULARY_SCHEMA_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
    contentStamp,
    status: exhausted ? 'partial' : 'complete',
    // Stable upper-level work units, rather than the timing-dependent loop
    // cursor at which the wall-clock check fired.
    omittedCandidateCount: exhausted ? orderedSources.length + corpusDf.size : 0,
    entries,
  };
  return { ...base, payloadHash: payloadHash(base) };
}

export async function persistRepositoryVocabulary(dbPath: string, vocabulary: RepositoryVocabulary): Promise<void> {
  await atomicWriteFile(vocabularyPath(dbPath), JSON.stringify(vocabulary) + '\n');
}

export function invalidateRepositoryVocabulary(dbPath: string): void {
  vocabularyCache.delete(dirname(dbPath));
  try {
    rmSync(vocabularyPath(dbPath), { force: true });
  } catch {
    /* optional artifact; absence is ordinary keyword mode */
  }
}

function readBoundedNoFollow(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) return null;
    return readFileSync(fd, 'utf8');
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
      || !Number.isSafeInteger(raw.omittedCandidateCount) || (raw.omittedCandidateCount as number) < 0
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
