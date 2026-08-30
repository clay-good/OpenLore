/** change: add-retrieval-match-evidence */

import { join } from 'node:path';
import { statSync } from 'node:fs';
import { readOpenLoreConfig } from '../config-manager.js';
import { resolveEmbedder } from '../../analyzer/embedder.js';
import {
  VectorIndex,
  searchableFieldsForFunctionRow,
  tokenize,
} from '../../analyzer/vector-index.js';
import {
  SpecVectorIndex,
  searchableFieldsForSpecRow,
} from '../../analyzer/spec-vector-index.js';
import { detectLanguage, languageSupport } from '../../analyzer/language-support.js';
import { queryTooLongError, validateDirectory } from './utils.js';
import { requireMatchEvidence, type SearchableFields } from '../../analyzer/retrieval-evidence.js';

export type RetrievalSurface = 'code' | 'spec';
export type RetrievalTarget = {
  kind: 'symbol' | 'file' | 'requirement';
  value: string;
  filePath?: string;
};

export interface ExplainRetrievalMissInput {
  query: string;
  surface: RetrievalSurface;
  target: RetrievalTarget;
  limit?: number;
  language?: string;
  minFanIn?: number;
  domain?: string;
  section?: string;
}

type IndexedRow = Record<string, unknown>;

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readIndexRows(
  outputDir: string,
  tableName: 'functions' | 'specs',
  predicate: string,
): Promise<IndexedRow[]> {
  const { connect } = await import('@lancedb/lancedb');
  const db = await connect(join(outputDir, 'vector-index'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table: any = await db.openTable(tableName);
  return await table.query().where(predicate).toArray() as IndexedRow[];
}

function indexGenerationStamp(outputDir: string, surface: RetrievalSurface): string | null {
  try {
    const name = surface === 'code' ? 'vector-index-meta.json' : 'spec-index-meta.json';
    const stat = statSync(join(outputDir, name), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

function usage(error: string, candidates?: string[]): Record<string, unknown> {
  return { error, usageError: true, ...(candidates?.length ? { candidates: candidates.slice(0, 10) } : {}) };
}

function resolveCodeRows(rows: IndexedRow[], target: RetrievalTarget): IndexedRow[] | Record<string, unknown> {
  if (target.kind === 'requirement') return usage('target.kind "requirement" requires surface "spec".');
  if (target.kind === 'file') return rows.filter((row) => row.filePath === target.value);

  const matches = rows.filter((row) =>
    (row.id === target.value || row.name === target.value) &&
    (!target.filePath || row.filePath === target.filePath),
  );
  const identities = [...new Set(matches.map((row) => `${String(row.filePath)}::${String(row.name)}`))].sort();
  if (!target.filePath && identities.length > 1 && !matches.some((row) => row.id === target.value)) {
    return usage(`Symbol target "${target.value}" is ambiguous; provide target.filePath.`, identities);
  }
  return matches;
}

function codePredicate(target: RetrievalTarget): string {
  return target.kind === 'file'
    ? `\`filePath\` = ${sql(target.value)}`
    : `(id = ${sql(target.value)} OR name = ${sql(target.value)})${target.filePath ? ` AND \`filePath\` = ${sql(target.filePath)}` : ''}`;
}

function resolveSpecRows(rows: IndexedRow[], target: RetrievalTarget): IndexedRow[] | Record<string, unknown> {
  if (target.kind !== 'requirement') return usage('Spec retrieval requires target.kind "requirement".');
  return rows.filter((row) => row.id === target.value);
}

function unsupportedCodeTarget(target: RetrievalTarget): { language: string } | null {
  const filePath = target.kind === 'file' ? target.value : target.filePath;
  if (!filePath) return null;
  const language = detectLanguage(filePath);
  const support = languageSupport(language);
  return !support.capabilities.includes('signatures') ? { language } : null;
}

function targetIds(rows: IndexedRow[]): Set<string> {
  return new Set(rows.map((row) => String(row.id)));
}

function hasLexicalMatch(rows: IndexedRow[], query: string, fieldsFor: (row: IndexedRow) => SearchableFields): boolean {
  const queryTerms = new Set(tokenize(query));
  return rows.some((row) => Object.values(fieldsFor(row)).some((value) =>
    tokenize(value ?? '').some((token) => queryTerms.has(token)),
  ));
}

function unsupportedResolvedRows(rows: IndexedRow[]): string | null {
  const languages = [...new Set(rows.map((row) => String(row.language ?? '')).filter(Boolean))];
  if (languages.length === 0) return null;
  return languages.every((language) => !languageSupport(language).capabilities.includes('signatures'))
    ? languages.sort()[0]
    : null;
}

async function explainRetrievalMiss(
  directory: string,
  input: ExplainRetrievalMissInput,
  snapshotRetry = 0,
): Promise<unknown> {
  if (!input?.query?.trim()) return usage('query is required and must not be empty.');
  const tooLong = queryTooLongError(input.query); if (tooLong) return tooLong;
  if (!input.target?.value?.trim()) return usage('A named target is required; open non-match enumeration is not supported.');
  if (!['code', 'spec'].includes(input.surface)) return usage('surface must be "code" or "spec".');
  if (!['symbol', 'file', 'requirement'].includes(input.target.kind)) {
    return usage('target.kind must be "symbol", "file", or "requirement".');
  }
  if (input.target.value.length > 2048 || (input.target.filePath?.length ?? 0) > 2048) {
    return usage('target.value and target.filePath must be at most 2,048 characters.');
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    return usage('limit must be a positive integer.');
  }
  if (input.minFanIn !== undefined && (!Number.isInteger(input.minFanIn) || input.minFanIn < 0)) {
    return usage('minFanIn must be a non-negative integer.');
  }
  if ([input.language, input.domain, input.section].some((value) => (value?.length ?? 0) > 256)) {
    return usage('language, domain, and section filters must be at most 256 characters.');
  }
  if (input.target.filePath && input.target.kind !== 'symbol') {
    return usage('target.filePath is valid only for a symbol target.');
  }
  if (input.surface === 'code') {
    if (input.target.kind === 'requirement') return usage('target.kind "requirement" requires surface "spec".');
    if (input.domain || input.section) return usage('domain and section filters require surface "spec".');
  } else {
    if (input.target.kind !== 'requirement') return usage('Spec retrieval requires target.kind "requirement".');
    if (input.language || input.minFanIn !== undefined) return usage('language and minFanIn filters require surface "code".');
  }

  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, '.openlore', 'analysis');
  const generation = indexGenerationStamp(outputDir, input.surface);

  if (input.surface === 'code') {
    const extensionUnsupported = unsupportedCodeTarget(input.target);
    if (extensionUnsupported) {
      const textIndexed = input.target.kind === 'file'
        ? await (async () => {
            const { TextLineIndex } = await import('../../analyzer/text-line-index.js');
            return TextLineIndex.exists(outputDir) && TextLineIndex.hasFile(outputDir, input.target.value);
          })()
        : false;
      if (!textIndexed) {
        return { cause: 'capability-unsupported-for-language', target: input.target, ...extensionUnsupported };
      }
    }
    if (!VectorIndex.exists(outputDir)) return { cause: 'not-indexed', target: input.target };
    const rows = await readIndexRows(outputDir, 'functions', codePredicate(input.target));
    if (generation !== indexGenerationStamp(outputDir, input.surface)) {
      return snapshotRetry === 0
        ? explainRetrievalMiss(directory, input, 1)
        : { error: 'Retrieval index changed during diagnosis. Retry the request.', retryable: true };
    }
    const resolved = resolveCodeRows(rows, input.target);
    if (!Array.isArray(resolved)) return resolved;
    if (input.target.kind === 'symbol' && resolved.length === 0) {
      return { cause: 'not-indexed', target: input.target };
    }
    if (input.target.kind === 'file' && resolved.length === 0) {
      const { TextLineIndex } = await import('../../analyzer/text-line-index.js');
      if (!TextLineIndex.exists(outputDir) || !await TextLineIndex.hasFile(outputDir, input.target.value)) {
        return { cause: 'not-indexed', target: input.target };
      }
    }
    const unsupportedLanguage = unsupportedResolvedRows(resolved);
    if (unsupportedLanguage) {
      return { cause: 'capability-unsupported-for-language', target: input.target, language: unsupportedLanguage };
    }
    if (resolved.length > 0 && input.language && resolved.every((row) => row.language !== input.language)) {
      return { cause: 'filtered-out', target: input.target, filter: 'language', value: input.language };
    }
    if (resolved.length > 0 && input.minFanIn !== undefined && resolved.every((row) => Number(row.fanIn ?? 0) < input.minFanIn!)) {
      return { cause: 'filtered-out', target: input.target, filter: 'minFanIn', value: input.minFanIn };
    }
    const eligible = resolved.filter((row) =>
      (!input.language || row.language === input.language) &&
      (input.minFanIn === undefined || Number(row.fanIn ?? 0) >= input.minFanIn),
    );
    const ids = targetIds(eligible);
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    const cfg = await readOpenLoreConfig(absDir);
    const embedSvc = await resolveEmbedder(cfg);
    const candidates = await VectorIndex.search(outputDir, input.query, embedSvc, {
      limit,
      language: input.language,
      minFanIn: input.minFanIn,
      traceCandidates: true,
      vocabularyExpansion: cfg?.retrieval?.vocabularyExpansion !== false,
    });
    if (generation !== indexGenerationStamp(outputDir, input.surface)) {
      return snapshotRetry === 0
        ? explainRetrievalMiss(directory, input, 1)
        : { error: 'Retrieval index changed during diagnosis. Retry the request.', retryable: true };
    }

    // search_code consults literal text only when the symbol path returns zero.
    if (input.target.kind === 'file' && candidates.length === 0) {
      const { TextLineIndex } = await import('../../analyzer/text-line-index.js');
      if (TextLineIndex.exists(outputDir)) {
        const textCandidates = await TextLineIndex.searchText(outputDir, input.query, {
          limit,
          traceCandidates: true,
          vocabularyExpansion: cfg?.retrieval?.vocabularyExpansion !== false,
        });
        const textRank = textCandidates.findIndex((result) => result.filePath === input.target.value);
        if (textRank >= 0) {
          const rank = textRank + 1;
          if (rank > limit) return { cause: 'outranked', target: input.target, rank, cutoff: limit };
          return { surfaced: true, target: input.target, rank, matchEvidence: textCandidates[textRank].matchEvidence };
        }
        if (await TextLineIndex.hasFile(outputDir, input.target.value)) {
          return { cause: 'no-term-matched', target: input.target };
        }
      }
    }
    if (eligible.length === 0) return { cause: 'not-indexed', target: input.target };
    const rankIndex = candidates.findIndex((result) => ids.has(result.record.id));
    if (rankIndex < 0 && !hasLexicalMatch(eligible, input.query, searchableFieldsForFunctionRow)) {
      return { cause: 'no-term-matched', target: input.target };
    }
    if (rankIndex < 0) return { cause: 'budget-truncated', target: input.target, budget: 'candidate-window' };
    const rank = rankIndex + 1;
    if (rank > limit) return { cause: 'outranked', target: input.target, rank, cutoff: limit };
    const result = candidates[rankIndex];
    return { surfaced: true, target: input.target, rank, matchEvidence: requireMatchEvidence(result.matchEvidence) };
  }

  if (!SpecVectorIndex.exists(outputDir)) return { cause: 'not-indexed', target: input.target };
  const rows = await readIndexRows(outputDir, 'specs', `id = ${sql(input.target.value)}`);
  if (generation !== indexGenerationStamp(outputDir, input.surface)) {
    return snapshotRetry === 0
      ? explainRetrievalMiss(directory, input, 1)
      : { error: 'Retrieval index changed during diagnosis. Retry the request.', retryable: true };
  }
  const resolved = resolveSpecRows(rows, input.target);
  if (!Array.isArray(resolved)) return resolved;
  if (resolved.length === 0) return { cause: 'not-indexed', target: input.target };
  if (input.domain && resolved.every((row) => row.domain !== input.domain)) {
    return { cause: 'filtered-out', target: input.target, filter: 'domain', value: input.domain };
  }
  if (input.section && resolved.every((row) => row.section !== input.section)) {
    return { cause: 'filtered-out', target: input.target, filter: 'section', value: input.section };
  }

  const ids = targetIds(resolved);
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const cfg = await readOpenLoreConfig(absDir);
  const embedSvc = await resolveEmbedder(cfg);
  const candidates = await SpecVectorIndex.search(outputDir, input.query, embedSvc, {
    limit,
    domain: input.domain,
    section: input.section,
    traceCandidates: true,
    vocabularyExpansion: cfg?.retrieval?.vocabularyExpansion !== false,
  });
  if (generation !== indexGenerationStamp(outputDir, input.surface)) {
    return snapshotRetry === 0
      ? explainRetrievalMiss(directory, input, 1)
      : { error: 'Retrieval index changed during diagnosis. Retry the request.', retryable: true };
  }
  const rankIndex = candidates.findIndex((result) => ids.has(result.record.id));
  if (rankIndex < 0 && !hasLexicalMatch(resolved, input.query, searchableFieldsForSpecRow)) {
    return { cause: 'no-term-matched', target: input.target };
  }
  if (rankIndex < 0) return { cause: 'budget-truncated', target: input.target, budget: 'candidate-window' };
  const rank = rankIndex + 1;
  if (rank > limit) return { cause: 'outranked', target: input.target, rank, cutoff: limit };
  const result = candidates[rankIndex];
  return {
    surfaced: true,
    target: input.target,
    rank,
    matchEvidence: requireMatchEvidence(result.matchEvidence),
  };
}

export async function handleExplainRetrievalMiss(
  directory: string,
  input: ExplainRetrievalMissInput,
): Promise<unknown> {
  return explainRetrievalMiss(directory, input);
}
