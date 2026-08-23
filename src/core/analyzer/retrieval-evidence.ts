/** change: add-retrieval-match-evidence */

export const LEXICAL_MATCH_FIELDS = [
  'symbol',
  'path',
  'signature',
  'doc',
  'body',
] as const;

export type LexicalMatchField = (typeof LEXICAL_MATCH_FIELDS)[number];
export type MatchField = LexicalMatchField | 'vector';
export type RetrievalTier = 1 | 2 | 3;

export interface MatchEvidence {
  field: MatchField;
  terms: string[];
  tier: RetrievalTier;
}

export type SearchableFields = Partial<Record<LexicalMatchField, string>>;
export type FieldTermFrequencies = Partial<Record<LexicalMatchField, Map<string, number>>>;

export function vectorMatchEvidence(tier: 2 | 3): MatchEvidence {
  return { field: 'vector', terms: [], tier };
}

/** Fail closed if a retriever violates the additive evidence contract. */
export function requireMatchEvidence(evidence: MatchEvidence | undefined): MatchEvidence {
  if (!evidence) throw new Error('Retrieval result is missing match evidence. Rebuild the index and retry.');
  return evidence;
}
