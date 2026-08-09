/**
 * Decision consolidator
 *
 * Calls LLM to merge/resolve draft decisions from a session into a clean set.
 * Resolves contradictions and collapses superseded decisions.
 */

import {
  DECISIONS_CONSOLIDATION_MAX_TOKENS,
} from '../../constants.js';
import { logger } from '../../utils/logger.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision, DecisionStore, SpecMap, DecisionScope } from '../../types/index.js';
import { makeDecisionId } from './store.js';
import { parseJSON } from '../../utils/misc.js';
import { matchFileToDomains } from '../drift/spec-mapper.js';
import { createPromptBoundary } from '../../utils/prompt-boundary.js';

const SYSTEM_PROMPT = `You are an architectural decision consolidator for a software project.

You receive a list of architectural decision drafts recorded by an AI agent during a coding session, plus the set of decisions already recorded in prior sessions (with their stable IDs). Some decisions may contradict each other or be superseded by later decisions. Your task is to produce a clean, consolidated set representing the final architectural state after the session.

Rules:
- Keep only decisions that represent the FINAL state (most recent wins for contradictions)
- If a decision has a "supersedes" field, mark the referenced decision as resolved
- Merge related decisions about the same topic into one when they are complementary
- Typically produce 1-3 consolidated decisions; never more than 5
- Preserve the original rationale and consequences from the drafts
- proposedRequirement should be a single sentence starting with "The system SHALL", or null

ID REUSE (critical for traceability):
- If a consolidated decision covers the same concept as an existing decision (provided in the "existing" section of the input), set "id" to that decision's exact ID string
- Only reuse an ID if you are confident the concept is the same — same architectural choice, same affected area
- If the consolidated decision is genuinely new, omit "id" entirely
- Never invent a new ID — either reuse an existing one or omit the field

Keep a decision if it describes ANY of:
- A new feature, command, flag, or capability added to the system
- A change to where responsibility lives (which module/command owns what)
- A choice between two viable approaches (even if the choice seems obvious in hindsight)
- A behaviour that would surprise a future developer reading the code
- A constraint or limitation deliberately introduced

Only discard decisions that are ALL of:
- Pure refactors with no behaviour change (rename, extract helper, fix types)
- AND already obvious from the surrounding code without explanation
- AND recorded no rationale beyond "follow existing patterns"

Good examples: "Move hook installation from decisions to setup command", "Use system prompt injection instead of tool-output blocking for completion guard", "Prefer local dist/cli/index.js over global openlore in pre-commit hook"
Bad examples: "Use TypeScript interfaces for type safety", "Add error handling", "Follow existing service pattern"

SCOPE CLASSIFICATION (required):
Classify each consolidated decision with one of these scopes:
- "local": single file, no cross-cutting concern (refactors, extractions, renames)
- "component": single component/service/module, no cross-boundary contract impact
- "cross-domain": touches multiple spec domains AND changes behavioral contracts or public interfaces
- "system": global architectural constraint (auth strategy, data model, infra, API protocol)

Only "cross-domain" and "system" decisions will generate ADR files. Be conservative.

DO NOT classify as "cross-domain" when:
- multiple files changed but within one logical module
- helper utilities were extracted to a shared file
- tests were updated alongside implementation
- config/constants changed
- middleware was added inside a single service
- internal refactors touched shared code without changing contracts

Respond with a JSON array only. Each element:
{
  "id": string (optional — only set when reusing an existing decision ID),
  "title": string,
  "rationale": string,
  "consequences": string,
  "affectedDomains": string[],
  "affectedFiles": string[],
  "proposedRequirement": string | null,
  "supersededIds": string[],
  "scope": string
}

If there are genuinely no decisions worth keeping, return [].`;

interface ConsolidatedRaw {
  id?: string;
  title: string;
  rationale: string;
  consequences: string;
  affectedDomains: string[];
  affectedFiles: string[];
  proposedRequirement: string | null;
  supersededIds?: string[];
  scope?: DecisionScope;
}

const DECISION_SCOPES = new Set<DecisionScope>(['local', 'component', 'cross-domain', 'system']);

function isConsolidatedRaw(value: unknown): value is ConsolidatedRaw {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const strings = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string');
  return (item.id === undefined || typeof item.id === 'string')
    && typeof item.title === 'string'
    && typeof item.rationale === 'string'
    && typeof item.consequences === 'string'
    && strings(item.affectedDomains)
    && strings(item.affectedFiles)
    && (item.proposedRequirement === null || typeof item.proposedRequirement === 'string')
    && (item.supersededIds === undefined || strings(item.supersededIds))
    && (item.scope === undefined || DECISION_SCOPES.has(item.scope as DecisionScope));
}

export interface ConsolidateResult {
  decisions: PendingDecision[];
  supersededIds: string[];
}

export async function consolidateDrafts(
  store: DecisionStore,
  llm: LLMService,
  specMap?: SpecMap,
): Promise<ConsolidateResult> {
  const drafts = store.decisions.filter((d) => d.status === 'draft');
  if (drafts.length === 0) return { decisions: [], supersededIds: [] };

  // Non-draft decisions are context only. Their durable IDs may not be reused by
  // LLM output because replaceDecisions() overwrites matching records.
  const existing = store.decisions.filter((d) => d.status !== 'draft' && d.status !== 'rejected' && d.status !== 'phantom');
  const existingIds = new Set(existing.map((d) => d.id));
  // A consolidated decision that echoes back its source DRAFT's id should keep that
  // id — replaceDecisions() assumes consolidated decisions share ids with their
  // drafts. Without this, a single-draft consolidation re-mints a fresh id from the
  // (LLM-reworded) title, so the gate advertises an id that no longer maps to the
  // recorded draft, and approve/sync operate on a different logical record.
  const draftIds = new Set(drafts.map((d) => d.id));
  const knownIds = new Set([...existingIds, ...draftIds]);
  const declaredSupersessionIds = new Set(
    drafts
      .map((d) => d.supersedes)
      .filter((id): id is string => typeof id === 'string' && knownIds.has(id)),
  );

  const userContent = JSON.stringify(
    {
      drafts: drafts.map((d) => ({
        id: d.id,
        title: d.title,
        rationale: d.rationale,
        consequences: d.consequences,
        affectedDomains: d.affectedDomains,
        affectedFiles: d.affectedFiles,
        supersedes: d.supersedes,
        recordedAt: d.recordedAt,
      })),
      existing: existing.map((d) => ({
        id: d.id,
        title: d.title,
        rationale: d.rationale,
        status: d.status,
      })),
    },
    null,
    2,
  );

  const boundary = createPromptBoundary();
  const response = await llm.complete({
    systemPrompt: `${SYSTEM_PROMPT}\n\n${boundary.instruction}`,
    userPrompt: boundary.wrap(userContent),
    maxTokens: DECISIONS_CONSOLIDATION_MAX_TOKENS,
    temperature: 0.1,
  });
  const raw = response.content;

  const parsed = parseJSON<unknown>(raw, null);
  if (!Array.isArray(parsed) || !parsed.every(isConsolidatedRaw)) {
    throw new Error('decision consolidation returned invalid structured output');
  }
  const consolidated = parsed;

  if (consolidated.length === 0 && drafts.length > 0) {
    logger.warning(`consolidation returned 0 decisions from ${drafts.length} drafts — LLM response: ${raw.slice(0, 300)}`);
  }

  const now = new Date().toISOString();
  // Supersession is a durable state transition. The LLM may preserve a target
  // explicitly declared by a recorded draft, but may never invent one merely
  // because it knows a real decision id.
  const allSupersededIds = consolidated
    .flatMap((c) => c.supersededIds ?? [])
    .filter((id) => declaredSupersessionIds.has(id));

  const decisions = consolidated.map((c): PendingDecision => {
    // Remap LLM-produced domain names to spec-map ground truth using affectedFiles.
    // Falls back to LLM names if specMap is absent or files yield no match.
    const resolvedDomains = resolveDomainsFromFiles(c.affectedFiles, c.affectedDomains, specMap);
    const domain = resolvedDomains[0] ?? 'unknown';
    // Reuse only the source draft's ID. A known durable ID from the context is
    // never a replacement target unless an explicit draft supersession retires it.
    const id =
      c.id && draftIds.has(c.id)
        ? c.id
        : makeDecisionId(store.sessionId, domain, c.title);
    return {
      id,
      status: 'consolidated',
      title: c.title,
      rationale: c.rationale,
      consequences: c.consequences,
      proposedRequirement: c.proposedRequirement,
      affectedDomains: resolvedDomains,
      affectedFiles: c.affectedFiles,
      scope: c.scope ?? 'component',
      confidence: 'medium',
      contentOrigin: 'llm-extracted',
      sessionId: store.sessionId,
      recordedAt: now,
      consolidatedAt: now,
      syncedToSpecs: [],
    };
  });

  return { decisions, supersededIds: allSupersededIds };
}

/**
 * Remap LLM-produced domain names to spec-map ground truth.
 * Uses affectedFiles as the anchor: if files can be matched to known spec domains,
 * those names take precedence over whatever the LLM suggested.
 */
function resolveDomainsFromFiles(
  files: string[],
  llmDomains: string[],
  specMap?: SpecMap,
): string[] {
  if (!specMap || files.length === 0) return llmDomains.length > 0 ? llmDomains : ['unknown'];

  const matched = new Set<string>();
  for (const file of files) {
    for (const domain of matchFileToDomains(file, specMap)) {
      matched.add(domain);
    }
  }

  if (matched.size > 0) return [...matched];

  // Files didn't match — try normalising LLM names against known domains
  const knownDomains = [...specMap.byDomain.keys()];
  const normalised = llmDomains
    .map((d) => knownDomains.find((k) => k.toLowerCase() === d.toLowerCase()) ?? null)
    .filter((d): d is string => d !== null);

  return normalised.length > 0 ? normalised : llmDomains.length > 0 ? llmDomains : ['unknown'];
}
