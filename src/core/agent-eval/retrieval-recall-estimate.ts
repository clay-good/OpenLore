/** Deterministic, no-agent retrieval-recall estimate for `openlore prove --estimate`. */

import { buildBm25Corpus, bm25Score } from '../analyzer/vector-index.js';
import { tokenize } from '../analyzer/bm25-tokenizer.js';
import { compareVocabularyRank, expandVocabularyQuery } from '../analyzer/repo-vocabulary.js';

const RECALL_AT = 10;
const MAX_ESTIMATE_PAIRS = 100;

export interface RetrievalRecallEstimate {
  label: 'estimate';
  recallAt: number;
  evaluatedPairs: number;
  availablePairs: number;
  pairsOmitted: number;
  vocabularyAvailable: boolean;
  baselineHits: number;
  vocabularyHits: number;
  baselineRecall: number;
  vocabularyRecall: number;
  deltaPercentagePoints: number;
}

export interface RetrievalRecallNode {
  id: string;
  name: string;
  filePath: string;
  className?: string;
  signature?: string;
  docstring?: string;
}

function pct(hits: number, total: number): number {
  return total === 0 ? 0 : Math.round((hits / total) * 10_000) / 100;
}

export function estimateVocabularyRecall(
  outputDir: string,
  rawNodes: readonly RetrievalRecallNode[],
): RetrievalRecallEstimate {
  const nodes = [...rawNodes]
    .filter((node) => tokenize(node.docstring ?? '').length >= 2 && tokenize(node.name).length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const pairs = nodes.slice(0, MAX_ESTIMATE_PAIRS);
  const records = rawNodes
    .filter((node) => node.id && node.name)
    .map((node) => ({
      id: node.id,
      text: [node.name, node.className ?? '', node.signature ?? '', node.filePath].join(' '),
    }));
  const corpus = buildBm25Corpus(records);
  const indexById = new Map(corpus.docs.map((doc, index) => [doc.id, index]));
  let baselineHits = 0;
  let vocabularyHits = 0;
  let vocabularyAvailable = false;

  for (const pair of pairs) {
    const targetIndex = indexById.get(pair.id);
    if (targetIndex === undefined) continue;
    const queryTokens = tokenize(pair.docstring ?? '');
    const expanded = expandVocabularyQuery(outputDir, queryTokens);
    vocabularyAvailable ||= expanded.vocabularyAvailable;
    const scored = corpus.docs
      .map((doc, index) => ({
        id: doc.id,
        index,
        score: bm25Score(corpus, queryTokens, index),
        expansionScore: bm25Score(corpus, expanded.expansionTokens, index),
      }))
      .filter(({ score, expansionScore }) => score > 0 || expansionScore > 0);
    const baselineRanked = scored
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const vocabularyRanked = [...scored].sort(compareVocabularyRank);
    if (baselineRanked.slice(0, RECALL_AT).some(({ index }) => index === targetIndex)) {
      baselineHits++;
    }
    if (vocabularyRanked.slice(0, RECALL_AT).some(({ index }) => index === targetIndex)) vocabularyHits++;
  }

  const baselineRecall = pct(baselineHits, pairs.length);
  const vocabularyRecall = pct(vocabularyHits, pairs.length);
  return {
    label: 'estimate',
    recallAt: RECALL_AT,
    evaluatedPairs: pairs.length,
    availablePairs: nodes.length,
    pairsOmitted: Math.max(0, nodes.length - pairs.length),
    vocabularyAvailable,
    baselineHits,
    vocabularyHits,
    baselineRecall,
    vocabularyRecall,
    deltaPercentagePoints: Math.round((vocabularyRecall - baselineRecall) * 100) / 100,
  };
}
