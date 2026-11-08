/** change: add-retrieval-match-evidence */

export const LEXICAL_MATCH_FIELDS = [
  'symbol',
  'path',
  'signature',
  'doc',
  'body',
  // The language marker the code corpus writes beside the path (`[TypeScript] src/index.ts`).
  // It is its OWN field because it is its own text: folded into `path`, a hit on `TypeScript`
  // was attributed to a path that contains no such token, and the receipt named evidence the
  // file does not contain (change: fix-retrieval-coverage-over-unread-content).
  'language',
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
 * Fields whose match is never the caller's vocabulary meeting the code's, whatever tier it
 * arrived in. A query term that matched only the LANGUAGE marker (`type` inside `TypeScript`)
 * tells you the file's language, not that it has anything to do with the question — and because
 * the marker rides the keyword corpus, such a hit arrived as `tier: 1` and was read as strong.
 * That is what let `search_code {"query":"type"}` rank two unrelated TypeScript functions as a
 * confident answer (change: fix-retrieval-coverage-over-unread-content).
 */
const INCIDENTAL_MATCH_FIELDS: ReadonlySet<MatchField> = new Set<MatchField>(['language']);

/**
 * How well the retrieval covers the question asked.
 *
 * `covered` — at least one result matched the caller's own terms, or matched on a
 * field that names the thing.
 * `weak` — results exist, but every one rests on incidental evidence: body text, a
 * vocabulary expansion the caller never typed, or vector proximity alone.
 * `uncovered` — nothing matched at all.
 * `partial` — the retrieval ran over material it could not read, so neither a hit list nor an
 * empty result can be taken at face value. Never folded from evidence alone: see
 * {@link resolveCoverage}.
 */
export type CoverageVerdict = 'covered' | 'weak' | 'uncovered' | 'partial';

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
  const strong = evidence.some(e =>
    !INCIDENTAL_MATCH_FIELDS.has(e.field) && (STRONG_MATCH_FIELDS.has(e.field) || e.tier === 1));
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

// ─── Readability: what the retrieval could not read ──────────────────────────
// (change: fix-retrieval-coverage-over-unread-content)

/**
 * Why material IN SCOPE of a retrieval could not be read. Closed on purpose, and every member
 * is a signal the analyzer already persisted — nothing here is recomputed at query time.
 *
 *  - `parse-errors`        a file parsed with tree-sitter ERROR/MISSING regions
 *  - `parse-failed`        the extractor produced no usable tree — the file contributed nothing
 *  - `size-cap`            the file exceeded a size bound and was never read
 *  - `parse-budget`        the parse was abandoned at the per-file budget
 *  - `lossy-encoding`      the source decoded lossily, so parse output may be garbage
 *  - `grammar-unavailable` a supported language's grammar produced no graph facts at all
 *  - `reduced-analysis`    the degradation ladder shed analysis breadth under memory pressure
 *  - `health-record-unreadable` the parse-health record is present and could not be read, so
 *                          what went unread cannot be counted — the one cause that is about the
 *                          disclosure rather than the code
 */
export const UNREADABLE_CAUSES = [
  'parse-errors',
  'parse-failed',
  'size-cap',
  'parse-budget',
  'lossy-encoding',
  'grammar-unavailable',
  'reduced-analysis',
  'health-record-unreadable',
] as const;

export type UnreadableCause = (typeof UNREADABLE_CAUSES)[number];

/**
 * Material in scope that the index could not read, rolled up repository-wide.
 *
 * Repository-wide is the load-bearing word. The per-result parse-health boundary is scoped to
 * the files a conclusion SURFACED, so by construction it can never fire for the worst case —
 * a file that produced zero symbols never surfaces, and its absence is exactly what a confident
 * empty answer is built on.
 */
export interface ReadabilityShortfall {
  /** Deterministic: in {@link UNREADABLE_CAUSES} order. */
  causes: UnreadableCause[];
  /** Files carrying any parse-health signal. */
  degradedFiles: number;
  /** Files excluded before or during extraction (size cap, budget, parse failure). */
  excludedFiles: number;
  /** One sentence naming each cause with its counts. */
  summary: string;
}

/** The coverage conclusion a retrieval handler returns. */
export interface CoverageConclusion {
  verdict: CoverageVerdict;
  questionKind: QuestionKind;
  answeredBy?: string;
  reason?: string;
  /** On `partial`: what the verdict would have been had everything in scope been readable. */
  evidenceVerdict?: CoverageVerdict;
  /** On `partial`: what could not be read, and why. */
  unreadable?: ReadabilityShortfall;
}

/**
 * Fold the evidence verdict together with what the retrieval could not read.
 *
 * The rule, stated once and shared by `orient` and `search_code` (spec `mcp-handlers`
 * RetrievalCannotClaimCoverageOverUnreadContent):
 *
 *  1. No shortfall → the evidence verdict stands, unchanged and shaped exactly as before.
 *  2. A shortfall → the verdict is `partial`, WHATEVER the evidence said, and the evidence
 *     verdict travels beside it as `evidenceVerdict`.
 *
 * `covered` becomes unsayable, because a ranked list drawn from material that was only partly
 * read is a lower bound. `uncovered` becomes unsayable too, and that is the more expensive half:
 * "nothing matched" over a repository where two of three files never parsed is the confident
 * empty answer that makes an agent stop looking. "I found nothing" and "I could not read it"
 * must not render identically.
 *
 * `weak` is not preserved as the verdict either — one enum member, consistently, beats two
 * tools disagreeing about which obstruction wins — but nothing is lost: it travels in
 * `evidenceVerdict` and is restated in the reason.
 */
export function resolveCoverage(
  evidenceVerdict: CoverageVerdict,
  kind: QuestionKind,
  shortfall?: ReadabilityShortfall,
): CoverageConclusion {
  if (!shortfall) {
    return evidenceVerdict === 'covered'
      ? { verdict: evidenceVerdict, questionKind: kind }
      : coverageDisclosure(evidenceVerdict, kind);
  }
  const tool = QUESTION_KIND_TOOL[kind];
  const head = evidenceVerdict === 'uncovered'
    ? 'Nothing in the READABLE part of the index matched this query'
    : evidenceVerdict === 'weak'
      ? 'The results that did come back rest on incidental evidence — body text, a vocabulary '
        + 'expansion, or vector proximity — not on the terms you used'
      : 'These results were searched out of the part of the index that could be read';
  return {
    verdict: 'partial',
    questionKind: kind,
    ...(tool ? { answeredBy: tool } : {}),
    reason:
      `${head}, and material in scope could not be read: ${shortfall.summary} `
      + 'A symbol that never parsed cannot appear here, so this answer is a LOWER BOUND and an '
      + 'empty one is not proof of absence. Re-run "openlore analyze" after fixing the files '
      + 'named in the parseHealth boundary.',
    evidenceVerdict,
    unreadable: shortfall,
  };
}
