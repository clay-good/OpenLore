import {
  parseOpenSpecRequirements,
  structuralMarkdownLines,
  type ParsedOpenSpecRequirement,
} from '../generator/openspec-compat.js';

export type CorpusIntentCode =
  | 'corpus-normative-weakened'
  | 'corpus-scenario-removed'
  | 'corpus-requirement-removed'
  | 'corpus-specificity-lost'
  | 'corpus-boundary-clause-removed'
  | 'corpus-decision-status-regressed'
  | 'corpus-delta-orphaned';

export const CORPUS_INTENT_SOURCE_FIELDS = [
  'requirement.name',
  'requirement.text',
  'requirement.normativeRank',
  'requirement.scenarios',
  'decision.status',
  'decision.supersedes',
  'delta.modifiedRequirement',
] as const;
export type CorpusIntentSourceField = typeof CORPUS_INTENT_SOURCE_FIELDS[number];

export interface CorpusIntentRule {
  code: CorpusIntentCode;
  sourceFields: readonly CorpusIntentSourceField[];
}

/** Closed rule inventory used by policy registration and completeness tests. */
export const CORPUS_INTENT_RULES: readonly CorpusIntentRule[] = [
  { code: 'corpus-normative-weakened', sourceFields: ['requirement.normativeRank'] },
  { code: 'corpus-scenario-removed', sourceFields: ['requirement.scenarios'] },
  { code: 'corpus-requirement-removed', sourceFields: ['requirement.name', 'requirement.scenarios'] },
  { code: 'corpus-specificity-lost', sourceFields: ['requirement.text'] },
  { code: 'corpus-boundary-clause-removed', sourceFields: ['requirement.text'] },
  { code: 'corpus-decision-status-regressed', sourceFields: ['decision.status', 'decision.supersedes'] },
  { code: 'corpus-delta-orphaned', sourceFields: ['delta.modifiedRequirement', 'requirement.name'] },
] as const;

export interface CorpusIntentFinding {
  code: CorpusIntentCode;
  artifact: string;
  message: string;
  requirement?: string;
  baseValue?: string | string[];
  headValue?: string | string[];
}

export interface CorpusIntentReviewResult {
  verdict: 'review-recommended' | 'no-review-needed';
  findings: CorpusIntentFinding[];
  /** Each reason is the source-rich finding that produced the verdict. */
  reasons: CorpusIntentFinding[];
}

/** Public shorthand used by CLI and API adapters. */
export type CorpusIntentReview = CorpusIntentReviewResult;

interface CorpusRequirement {
  artifact: string;
  parsed: ParsedOpenSpecRequirement;
}

interface DecisionRecord {
  artifact: string;
  id: string;
  identifiers: string[];
  status: string;
  supersedes: string[];
  supersededBy: string[];
  explicitId: string | null;
}

const BASELINE_SPEC_PATH = /^openspec\/specs\/[^/]+\/spec\.md$/;
const DELTA_SPEC_PATH = /^openspec\/changes\/(?!archive\/)[^/]+\/specs\/[^/]+\/spec\.md$/;
const DECISION_PATH = /^openspec\/decisions\/[^/]+\.md$/;
const AUTHORITATIVE_DECISION_STATUSES = new Set(['accepted', 'approved', 'verified', 'synced', 'auto-approved']);

/**
 * Compare two already-materialized governance corpora without filesystem, git,
 * network, clock, or model access.
 */
export function reviewCorpusIntent(
  baseFiles: ReadonlyMap<string, string>,
  headFiles: ReadonlyMap<string, string>,
): CorpusIntentReviewResult {
  const findings: CorpusIntentFinding[] = [];
  const baseRequirements = collectRequirements(baseFiles);
  const headRequirements = collectRequirements(headFiles);
  // Only an archive record introduced by this compared change can explain a
  // removal. A historical archive entry must not permanently exempt a later,
  // reintroduced requirement from review.
  const baseArchivedRemovals = collectArchivedRemovalRecords(baseFiles);
  const archivedRemovals = new Set(
    [...collectArchivedRemovalRecords(headFiles)]
      .filter((removal) => !baseArchivedRemovals.has(removal)),
  );

  for (const [base, head] of matchRequirementContinuity(baseRequirements, headRequirements)) {
    if (!head) {
      if (archivedRemovals.has(`${specDomain(base.artifact)}\0${base.parsed.name}`)) continue;
      findings.push({
        code: 'corpus-requirement-removed',
        artifact: base.artifact,
        requirement: base.parsed.name,
        message: `Requirement "${base.parsed.name}" disappeared without exact-name or unique identical-scenario continuity.`,
        baseValue: base.parsed.name,
      });
      continue;
    }

    if (head.parsed.normativeRank < base.parsed.normativeRank) {
      findings.push({
        code: 'corpus-normative-weakened',
        artifact: head.artifact,
        requirement: head.parsed.name,
        message: `Requirement "${head.parsed.name}" weakened from ${base.parsed.normativeKeyword ?? 'none'} to ${head.parsed.normativeKeyword ?? 'none'}.`,
        baseValue: base.parsed.normativeKeyword ?? 'none',
        headValue: head.parsed.normativeKeyword ?? 'none',
      });
    }

    if (head.parsed.scenarios.length < base.parsed.scenarios.length) {
      const headScenarioNames = new Set(head.parsed.scenarios.map((scenario) => scenario.name));
      const removedScenarios = base.parsed.scenarios
        .map((scenario) => scenario.name)
        .filter((name) => !headScenarioNames.has(name))
        .sort(compareText);
      findings.push({
        code: 'corpus-scenario-removed',
        artifact: head.artifact,
        requirement: head.parsed.name,
        message: `Requirement "${head.parsed.name}" reduced its scenario count from ${base.parsed.scenarios.length} to ${head.parsed.scenarios.length}${removedScenarios.length > 0 ? ` (removed: ${removedScenarios.join(', ')})` : ''}.`,
        baseValue: removedScenarios.length > 0 ? removedScenarios : String(base.parsed.scenarios.length),
        headValue: head.parsed.scenarios.map((scenario) => scenario.name).sort(compareText),
      });
    }

    const headSpecificity = new Set(extractSpecificityClauses(head.parsed.text)
      .map(canonicalSpecificityClause));
    const lostSpecificity = extractSpecificityClauses(base.parsed.text)
      .filter((clause) => !headSpecificity.has(canonicalSpecificityClause(clause)));
    if (lostSpecificity.length > 0) {
      findings.push({
        code: 'corpus-specificity-lost',
        artifact: head.artifact,
        requirement: head.parsed.name,
        message: `Requirement "${head.parsed.name}" lost measurable or named specificity: ${lostSpecificity.join('; ')}.`,
        baseValue: lostSpecificity,
      });
    }

    const unmatchedHeadBoundaries = extractBoundaryClauses(head.parsed.text);
    const removedBoundaryClauses = extractBoundaryClauses(base.parsed.text)
      .filter((clause) => {
        const match = unmatchedHeadBoundaries.findIndex((candidate) => boundaryClauseCovers(clause, candidate));
        if (match === -1) return true;
        unmatchedHeadBoundaries.splice(match, 1);
        return false;
      }).sort(compareText);
    if (removedBoundaryClauses.length > 0) {
      findings.push({
        code: 'corpus-boundary-clause-removed',
        artifact: head.artifact,
        requirement: head.parsed.name,
        message: `Requirement "${head.parsed.name}" removed a disclosed-boundary or honesty clause.`,
        baseValue: removedBoundaryClauses,
      });
    }
  }

  findings.push(...reviewDecisionStatuses(baseFiles, headFiles));
  findings.push(...reviewDeltaTargets(headFiles, baseRequirements, headRequirements));
  findings.sort(compareFindings);

  const reasons = findings.map((finding) => ({ ...finding }));
  return {
    verdict: findings.length > 0 ? 'review-recommended' : 'no-review-needed',
    findings,
    reasons,
  };
}

function collectRequirements(files: ReadonlyMap<string, string>): CorpusRequirement[] {
  const requirements: CorpusRequirement[] = [];
  for (const [artifact, content] of [...files].sort(([a], [b]) => compareText(a, b))) {
    if (!BASELINE_SPEC_PATH.test(normalizePath(artifact))) continue;
    for (const parsed of parseOpenSpecRequirements(content)) requirements.push({ artifact: normalizePath(artifact), parsed });
  }
  return requirements;
}

function matchRequirementContinuity(
  base: CorpusRequirement[],
  head: CorpusRequirement[],
): Array<readonly [CorpusRequirement, CorpusRequirement | undefined]> {
  const unmatchedBase = new Set(base);
  const unmatchedHead = new Set(head);
  const matched = new Map<CorpusRequirement, CorpusRequirement>();

  const pair = (baseRequirement: CorpusRequirement, headRequirement: CorpusRequirement): void => {
    matched.set(baseRequirement, headRequirement);
    unmatchedBase.delete(baseRequirement);
    unmatchedHead.delete(headRequirement);
  };

  // Reserve the strongest identity first so an earlier rename candidate cannot
  // consume a later requirement's exact match.
  for (const baseRequirement of base) {
    const exact = head.find((candidate) => unmatchedHead.has(candidate)
      && candidate.artifact === baseRequirement.artifact
      && candidate.parsed.name === baseRequirement.parsed.name);
    if (exact) pair(baseRequirement, exact);
  }

  for (const baseRequirement of [...unmatchedBase]) {
    const baseWithName = [...unmatchedBase].filter((candidate) => candidate.parsed.name === baseRequirement.parsed.name);
    const headWithName = [...unmatchedHead].filter((candidate) => candidate.parsed.name === baseRequirement.parsed.name);
    if (baseWithName.length === 1 && headWithName.length === 1) pair(baseRequirement, headWithName[0]);
  }

  for (const baseRequirement of [...unmatchedBase]) {
    const signature = scenarioSetSignature(baseRequirement.parsed);
    if (signature === null) continue;
    const baseWithSignature = [...unmatchedBase]
      .filter((candidate) => scenarioSetSignature(candidate.parsed) === signature);
    const headWithSignature = [...unmatchedHead]
      .filter((candidate) => scenarioSetSignature(candidate.parsed) === signature);
    if (baseWithSignature.length === 1 && headWithSignature.length === 1) pair(baseRequirement, headWithSignature[0]);
  }

  return base.map((baseRequirement) => [baseRequirement, matched.get(baseRequirement)] as const);
}

function scenarioSetSignature(requirement: ParsedOpenSpecRequirement): string | null {
  if (requirement.scenarios.length === 0) return null;
  return JSON.stringify(requirement.scenarios
    .map((scenario) => `${normalizeWhitespace(scenario.name)}\n${normalizeWhitespace(scenario.text)}`)
    .sort(compareText));
}

function extractSpecificityClauses(text: string): string[] {
  const clauses: string[] = [];
  const normalized = normalizeWhitespace(text);
  const numberWithUnit = /\b\d+(?:\.\d+)?\s*(?:%|(?:ms|milliseconds?|s|seconds?|minutes?|hours?|bytes?|kib|mib|gib|kb|mb|gb|items?|files?|results?|characters?|tokens?|lines?|calls?|requests?)\b)/gi;
  for (const match of normalized.matchAll(numberWithUnit)) clauses.push(match[0]);

  const enumeratedSet = /\b(?:one of|exactly one of|any of)\s+`[^`]+`(?:\s*,\s*`[^`]+`)*(?:\s*,?\s*(?:or|and)\s*`[^`]+`)/gi;
  for (const match of normalized.matchAll(enumeratedSet)) clauses.push(match[0]);
  const plainEnumeratedSet = /\b(?:one of|exactly one of|any of)\s+[A-Za-z][\w.-]*(?:(?:\s*,\s*[A-Za-z][\w.-]*)*\s*,?\s*(?:or|and)\s*[A-Za-z][\w.-]*)/gi;
  for (const match of normalized.matchAll(plainEnumeratedSet)) clauses.push(match[0]);

  const namedThreshold = /`[A-Za-z_$][\w$]*(?:_THRESHOLD|_BUDGET|_LIMIT|_CEILING|_CAP)`/g;
  for (const match of normalized.matchAll(namedThreshold)) clauses.push(match[0]);
  const namedThresholdPhrase = /\b(?:threshold|budget|limit|ceiling|cap)\s+(?:named|called)\s+`?[A-Za-z_$][\w$]*`?/gi;
  for (const match of normalized.matchAll(namedThresholdPhrase)) clauses.push(match[0]);
  return [...new Set(clauses)];
}

function canonicalSpecificityClause(clause: string): string {
  return clause.toLowerCase().replace(/(\d)\s+(?=%|[a-z])/g, '$1').replace(/\s+/g, ' ').trim();
}

function extractBoundaryClauses(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      if (/\b(?:SHALL|MUST)\s+(?:\w+\s+){0,3}disclose\b/i.test(sentence)) return true;
      if (/\b(?:SHALL|MUST)\s+NOT\s+(?:\w+\s+){0,3}claim\b/i.test(sentence)) return true;
      return /\b(?:SHALL|MUST)\s+(?:\w+\s+){0,3}(?:report|surface|state|name)\b/i.test(sentence)
        && /\b(?:boundary|bounded|limit|limitation|truncat\w*|omission|omitted|incomplete|unsupported|unresolved|lower bound|confidence)\b/i.test(sentence);
    });
}

function boundaryClauseShape(clause: string): { action: string; terms: Set<string> } {
  const normalized = clause.toLowerCase();
  const action = /\b(?:shall|must)\s+not\s+(?:\w+\s+){0,3}claim\b/.test(normalized)
    ? 'not-claim'
    : normalized.match(/\b(?:disclose|report|surface|state|name)\b/)?.[0] ?? 'boundary';
  const ignored = new Set(['the', 'a', 'an', 'system', 'shall', 'must', 'not', 'clearly', 'explicitly', 'all', action, 'claim']);
  const terms = new Set((normalized.match(/[a-z][a-z0-9-]*/g) ?? [])
    .filter((token) => !ignored.has(token)));
  return { action, terms };
}

function boundaryClauseCovers(base: string, head: string): boolean {
  const baseShape = boundaryClauseShape(base);
  const headShape = boundaryClauseShape(head);
  return baseShape.action === headShape.action
    && [...baseShape.terms].every((term) => headShape.terms.has(term));
}

function reviewDecisionStatuses(
  baseFiles: ReadonlyMap<string, string>,
  headFiles: ReadonlyMap<string, string>,
): CorpusIntentFinding[] {
  const base = collectDecisions(baseFiles);
  const head = collectDecisions(headFiles);
  const headByArtifact = new Map(head.map((decision) => [decision.artifact, decision]));
  const authoritativeIdentifiers = new Set(head
    .filter((decision) => AUTHORITATIVE_DECISION_STATUSES.has(decision.status))
    .flatMap((decision) => decision.identifiers));
  const superseded = new Set(head
    .filter((decision) => AUTHORITATIVE_DECISION_STATUSES.has(decision.status))
    .flatMap((decision) => decision.supersedes));

  return base.flatMap((baseDecision): CorpusIntentFinding[] => {
    const stableMatches = baseDecision.explicitId === null ? [] : head.filter((candidate) =>
      candidate.identifiers.includes(baseDecision.explicitId!));
    const headDecision = stableMatches.length === 1
      ? stableMatches[0]
      : headByArtifact.get(baseDecision.artifact);
    if (!headDecision
      || !AUTHORITATIVE_DECISION_STATUSES.has(baseDecision.status)
      || AUTHORITATIVE_DECISION_STATUSES.has(headDecision.status)
      || baseDecision.identifiers.some((id) => superseded.has(id))
      || headDecision.supersededBy.some((id) => authoritativeIdentifiers.has(id))) return [];
    return [{
      code: 'corpus-decision-status-regressed',
      artifact: headDecision.artifact,
      message: `Decision ${baseDecision.id} regressed from ${baseDecision.status} to ${headDecision.status} without an authoritative superseder.`,
      baseValue: baseDecision.status,
      headValue: headDecision.status,
    }];
  });
}

function collectDecisions(files: ReadonlyMap<string, string>): DecisionRecord[] {
  const decisions: DecisionRecord[] = [];
  for (const [rawArtifact, content] of [...files].sort(([a], [b]) => compareText(a, b))) {
    const artifact = normalizePath(rawArtifact);
    if (!DECISION_PATH.test(artifact)) continue;
    const structuralContent = structuralMarkdownLines(content).join('\n');
    const id = decisionId(artifact, structuralContent);
    const status = structuralContent.match(/^##\s+Status\s*$\n+\s*([^\n]+)/im)?.[1].trim().toLowerCase();
    if (!id || !status) continue;
    const supersedes = [...structuralContent.matchAll(/^(?:>\s*)?Supersedes\s*:\s*(?:ADR-)?([A-Za-z0-9_-]+)/gim)]
      .map((match) => normalizeDecisionId(match[1]));
    const supersededBy = [...status.matchAll(/\bsuperseded\s+by\s+(?:ADR-)?([A-Za-z0-9_-]+)/gi)]
      .map((match) => normalizeDecisionId(match[1]));
    const filenameId = artifact.split('/').pop()?.match(/^adr-([0-9]+)(?:-|\.)/i)?.[1];
    const identifiers = [id, ...(filenameId ? [normalizeDecisionId(filenameId)] : [])];
    decisions.push({
      artifact,
      id,
      identifiers: [...new Set(identifiers)],
      status,
      supersedes: [...new Set(supersedes)],
      supersededBy: [...new Set(supersededBy)],
      explicitId: explicitDecisionId(structuralContent),
    });
  }
  return decisions;
}

function decisionId(artifact: string, content: string): string | null {
  const explicit = explicitDecisionId(content);
  if (explicit) return explicit;
  const adr = artifact.split('/').pop()?.match(/^adr-([0-9]+)(?:-|\.)/i)?.[1];
  return adr ? normalizeDecisionId(adr) : null;
}

function explicitDecisionId(content: string): string | null {
  const explicit = content.match(/^>\s*Decision ID:\s*([A-Za-z0-9_-]+)/im)?.[1];
  return explicit ? normalizeDecisionId(explicit) : null;
}

function normalizeDecisionId(id: string): string {
  return id.toLowerCase().replace(/^adr-/, '').replace(/^0+(?=\d)/, '');
}

function reviewDeltaTargets(
  headFiles: ReadonlyMap<string, string>,
  baseRequirements: CorpusRequirement[],
  headRequirements: CorpusRequirement[],
): CorpusIntentFinding[] {
  const baseNames = new Set(baseRequirements.map(requirementKey));
  const baselineNames = new Set(headRequirements.map(requirementKey));
  const findings: CorpusIntentFinding[] = [];
  for (const [rawArtifact, content] of [...headFiles].sort(([a], [b]) => compareText(a, b))) {
    const artifact = normalizePath(rawArtifact);
    if (!DELTA_SPEC_PATH.test(artifact)) continue;
    const domain = artifact.match(/\/specs\/([^/]+)\/spec\.md$/)?.[1] ?? '';
    for (const requirement of parseModifiedDeltaRequirements(content)) {
      const key = `${domain}\0${requirement}`;
      if (!baseNames.has(key) || baselineNames.has(key)) continue;
      findings.push({
        code: 'corpus-delta-orphaned',
        artifact,
        requirement,
        message: `MODIFIED delta target "${requirement}" does not exist in the head baseline corpus.`,
        baseValue: requirement,
      });
    }
  }
  return findings;
}

function collectArchivedRemovalRecords(files: ReadonlyMap<string, string>): Set<string> {
  const removals = new Set<string>();
  for (const [rawArtifact, content] of files) {
    const artifact = normalizePath(rawArtifact);
    if (!/^openspec\/changes\/archive\/[^/]+\/specs\/[^/]+\/spec\.md$/.test(artifact)) continue;
    const domain = artifact.match(/\/specs\/([^/]+)\/spec\.md$/)?.[1] ?? '';
    for (const name of parseDeltaRequirementNames(content, 'REMOVED')) removals.add(`${domain}\0${name}`);
  }
  return removals;
}

function parseModifiedDeltaRequirements(content: string): string[] {
  return parseDeltaRequirementNames(content, 'MODIFIED');
}

function parseDeltaRequirementNames(content: string, targetSection: string): string[] {
  const names = parseOpenSpecRequirements(content)
    .filter((requirement) => requirement.deltaKind === targetSection)
    .map((requirement) => requirement.name);
  return [...new Set(names)].sort(compareText);
}

function compareFindings(a: CorpusIntentFinding, b: CorpusIntentFinding): number {
  return compareText(a.artifact, b.artifact)
    || compareText(a.code, b.code)
    || compareText(a.requirement ?? '', b.requirement ?? '')
    || compareText(a.message, b.message);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function specDomain(artifact: string): string {
  return artifact.match(/^openspec\/specs\/([^/]+)\/spec\.md$/)?.[1] ?? '';
}

function requirementKey(requirement: CorpusRequirement): string {
  return `${specDomain(requirement.artifact)}\0${requirement.parsed.name}`;
}
