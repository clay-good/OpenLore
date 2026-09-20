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

// ─── Coverage verdict (change: abstain-when-retrieval-is-uncovered) ──────────

/**
 * Fields whose match means the query named the thing itself, rather than
 * appearing somewhere inside it. A hit on a symbol name, a path, or a signature
 * is the caller's own vocabulary meeting the code's; a hit in `body` or `doc`
 * is a word that happens to occur in the text.
 */
const STRONG_MATCH_FIELDS: ReadonlySet<MatchField> = new Set<MatchField>(['symbol', 'path', 'signature']);

/**
 * How well the retrieval covers the question asked.
 *
 * `covered` — at least one result matched the caller's own terms, or matched on a
 * field that names the thing.
 * `weak` — results exist, but every one rests on incidental evidence: body text, a
 * vocabulary expansion the caller never typed, or vector proximity alone.
 * `uncovered` — nothing matched at all.
 */
export type CoverageVerdict = 'covered' | 'weak' | 'uncovered';

/**
 * Fold the evidence already attached to each result into a coverage verdict.
 *
 * Derived, not tuned: no relevance threshold, no score, no configuration. Two runs
 * over the same index cannot disagree, and no repository needs calibrating. A
 * ranked list of incidental matches is shaped exactly like an answer, which is how
 * an agent acts on three confidently-ranked symbols that have nothing to do with
 * the question (spec `mcp-quality` NoFalseCoverage).
 */
export function coverageVerdict(evidence: readonly MatchEvidence[]): CoverageVerdict {
  if (evidence.length === 0) return 'uncovered';
  const strong = evidence.some(e => STRONG_MATCH_FIELDS.has(e.field) || e.tier === 1);
  return strong ? 'covered' : 'weak';
}

/**
 * The kinds of question the substrate can be asked. Closed on purpose: a caller
 * told "not covered" needs to know WHICH question went unanswered, and an
 * open-ended label would drift into free-text intent guessing.
 */
export const QUESTION_KINDS = [
  'where-is',
  'who-calls',
  'what-gates',
  'what-order',
  'is-it-tested',
  'why-decided',
] as const;

export type QuestionKind = (typeof QUESTION_KINDS)[number];

/**
 * The tool that answers each kind, or `null` where the product does not answer it
 * yet. `what-gates` is deliberately null: a caller asking what makes a piece of
 * interface appear is told the question is not served, instead of being handed a
 * ranked list of components (see change `add-render-guard-index`).
 */
export const QUESTION_KIND_TOOL: Readonly<Record<QuestionKind, string | null>> = {
  'where-is': 'search_code',
  'who-calls': 'analyze_impact',
  'what-gates': null,
  'what-order': 'trace_execution_path',
  'is-it-tested': 'select_tests',
  'why-decided': 'recall',
};

export function isQuestionKind(value: unknown): value is QuestionKind {
  return typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value);
}

/** The disclosure a `weak` or `uncovered` conclusion carries. */
export interface CoverageDisclosure {
  verdict: CoverageVerdict;
  questionKind: QuestionKind;
  /** The tool that answers this kind, when one exists. */
  answeredBy?: string;
  /** Why the caller is seeing this, in one sentence. */
  reason: string;
}

/**
 * Build the disclosure for a non-`covered` verdict. The wording never implies a
 * substitute: when no tool answers the kind, it says so.
 */
export function coverageDisclosure(verdict: CoverageVerdict, kind: QuestionKind): CoverageDisclosure {
  const tool = QUESTION_KIND_TOOL[kind];
  const reason = verdict === 'uncovered'
    ? (tool
      ? `Nothing in the index matched this query. "${kind}" questions are answered by ${tool}.`
      : `Nothing in the index matched this query, and no shipped tool answers "${kind}" questions.`)
    : 'Every result rests on incidental evidence — body text, a vocabulary expansion, or vector proximity — not on the terms you used.';
  return { verdict, questionKind: kind, ...(tool ? { answeredBy: tool } : {}), reason };
}
