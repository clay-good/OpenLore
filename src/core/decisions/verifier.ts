/**
 * Decision verifier
 *
 * Cross-checks consolidated decisions against the actual git diff to:
 *  - "verified"  — decision has clear code evidence
 *  - "phantom"   — recorded but no matching change found in diff
 *  - "missing"   — significant diff change not covered by any decision
 */

import { DECISIONS_VERIFICATION_MAX_TOKENS } from '../../constants.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision } from '../../types/index.js';
import { parseJSON } from '../../utils/misc.js';
import { createPromptBoundary } from '../../utils/prompt-boundary.js';

const SYSTEM_PROMPT = `You are an architectural decision verifier for a software project.

You receive a list of architectural decisions. Each decision includes a "targetedDiff" field containing the git diff hunks for its affected files (or a sample of the overall diff if no specific files matched). You may also receive commit messages for context.

Your task: for each decision, determine if its targetedDiff contains clear evidence that it was implemented. Also identify significant changes not covered by any decision.

Respond with JSON only:
{
  "verified": [{ "id": string, "evidenceFile": string, "confidence": "high" | "medium" | "low" }],
  "phantom":  [{ "id": string }],
  "missing":  [{ "file": string, "description": string }]
}

Rules:
- "verified": the diff clearly shows this decision being implemented (matching patterns, types, function names, config keys, commit messages)
- "phantom": no sign of implementation in the diff (may have been rolled back or not yet committed)
- "missing": a structurally significant change (new interface, new function, dependency added, API change) that no decision covers
- Only report "missing" for architectural-level changes, not trivial ones`;

interface VerificationRaw {
  verified: Array<{ id: string; evidenceFile: string; confidence: 'high' | 'medium' | 'low' }>;
  phantom: Array<{ id: string }>;
  missing: Array<{ file: string; description: string }>;
}

function isVerificationRaw(value: unknown): value is VerificationRaw {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const verified = Array.isArray(item.verified) && item.verified.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.id === 'string'
      && typeof candidate.evidenceFile === 'string'
      && ['high', 'medium', 'low'].includes(candidate.confidence as string);
  });
  const phantom = Array.isArray(item.phantom) && item.phantom.every((entry) =>
    !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string');
  const missing = Array.isArray(item.missing) && item.missing.every((entry) =>
    !!entry && typeof entry === 'object'
      && typeof (entry as Record<string, unknown>).file === 'string'
      && typeof (entry as Record<string, unknown>).description === 'string');
  return verified && phantom && missing;
}

export interface VerificationResult {
  verified: PendingDecision[];
  phantom: PendingDecision[];
  missing: Array<{ file: string; description: string }>;
}

/** Maximum chars to include per file hunk in targeted diff */
const FILE_HUNK_LIMIT = 4_000;
/** Maximum total diff chars passed to LLM across all targeted hunks */
const TARGETED_DIFF_LIMIT = 16_000;

/**
 * Parse a combined git diff into a map of { filePath → hunk text }.
 * File paths are normalised to strip the leading a/ or b/ prefix.
 */
function parseDiffByFile(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = diff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const header = section.match(/^diff --git a\/(.+?) b\//);
    if (!header) continue;
    const file = header[1];
    result.set(file, section.length > FILE_HUNK_LIMIT ? section.slice(0, FILE_HUNK_LIMIT) + '\n... (truncated)' : section);
  }
  return result;
}

/**
 * Build a targeted diff string for a single decision.
 * Includes only hunks for files listed in affectedFiles.
 * Falls back to a slice of the full diff if no files match.
 */
function buildTargetedDiff(
  decision: PendingDecision,
  diffByFile: Map<string, string>,
  fallbackDiff: string,
): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of decision.affectedFiles) {
    const normalised = file.replace(/^[ab]\//, '');
    const hunk = diffByFile.get(normalised);
    if (!hunk) continue;
    const chunk = hunk.length > FILE_HUNK_LIMIT ? hunk.slice(0, FILE_HUNK_LIMIT) + '\n... (truncated)' : hunk;
    if (total + chunk.length > TARGETED_DIFF_LIMIT) break;
    parts.push(chunk);
    total += chunk.length;
  }
  if (parts.length > 0) return parts.join('\n');
  // No matching files — pass a slice of the global diff so the LLM can still check
  return fallbackDiff.slice(0, 4_000);
}

/** A changed hunk is "substantive" once it carries at least this many +/- lines. */
const SUBSTANTIVE_MIN_CHANGED_LINES = 2;

/** Count real added/removed lines in a diff hunk (excluding the +++/--- file markers). */
function countChangedLines(hunk: string): number {
  let n = 0;
  for (const line of hunk.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      n++;
    }
  }
  return n;
}

/**
 * Deterministic verification evidence: a decision is grounded when EVERY one of its
 * affectedFiles appears in the diff with a substantive hunk. Returns the evidence
 * file (the first affected file) when grounded, else null.
 *
 * This is the HF-1 fallback: the LLM `verify` step over-marks legitimate
 * tool-addition decisions as `phantom`, stalling the dogfood gate. When the code
 * is demonstrably in the diff, trust the diff over the LLM's "no evidence" call.
 */
export function substantiveEvidence(
  decision: PendingDecision,
  diffByFile: Map<string, string>,
): string | null {
  if (decision.affectedFiles.length === 0) return null;
  let totalChanged = 0;
  for (const file of decision.affectedFiles) {
    const normalised = file.replace(/^[ab]\//, '');
    const hunk = diffByFile.get(normalised);
    if (!hunk) return null; // require ALL affected files present
    totalChanged += countChangedLines(hunk);
  }
  return totalChanged >= SUBSTANTIVE_MIN_CHANGED_LINES ? decision.affectedFiles[0] : null;
}

export async function verifyDecisions(
  decisions: PendingDecision[],
  diff: string,
  llm: LLMService,
  commitMessages?: string,
): Promise<VerificationResult> {
  if (decisions.length === 0) {
    return { verified: [], phantom: [], missing: [] };
  }

  const diffByFile = parseDiffByFile(diff);

  const decisionSummary = decisions.map((d) => ({
    id: d.id,
    title: d.title,
    affectedFiles: d.affectedFiles,
    proposedRequirement: d.proposedRequirement,
    targetedDiff: buildTargetedDiff(d, diffByFile, diff),
  }));

  const commitSection = commitMessages ? `\nCommit messages:\n${commitMessages}\n` : '';
  const userContent = `Decisions:\n${JSON.stringify(decisionSummary, null, 2)}${commitSection}`;
  const boundary = createPromptBoundary();

  const response = await llm.complete({
    systemPrompt: `${SYSTEM_PROMPT}\n\n${boundary.instruction}`,
    userPrompt: boundary.wrap(userContent),
    maxTokens: DECISIONS_VERIFICATION_MAX_TOKENS,
    temperature: 0.1,
  });
  const raw = response.content;

  const parsed = parseJSON<unknown>(raw, null);
  if (!isVerificationRaw(parsed)) {
    throw new Error('decision verification returned invalid structured output');
  }
  const result = parsed;

  const byId = new Map(decisions.map((d) => [d.id, d]));
  const now = new Date().toISOString();

  const verified: PendingDecision[] = [];
  const phantom: PendingDecision[] = [];
  const classified = new Set<string>();
  for (const v of result.verified) {
    const d = byId.get(v.id);
    if (!d || classified.has(v.id)) continue;
    classified.add(v.id);
    const evidenceFile = v.evidenceFile.replace(/^[ab]\//, '');
    const targeted = d.affectedFiles.some((file) => file.replace(/^[ab]\//, '') === evidenceFile);
    const evidenceHunk = diffByFile.get(evidenceFile);
    if (targeted && evidenceHunk && countChangedLines(evidenceHunk) >= SUBSTANTIVE_MIN_CHANGED_LINES) {
      verified.push({ ...d, status: 'verified', confidence: v.confidence, verificationEvidence: 'git-diff', evidenceFile, verifiedAt: now });
      continue;
    }
    const deterministicEvidence = substantiveEvidence(d, diffByFile);
    if (deterministicEvidence) {
      verified.push({ ...d, status: 'verified', confidence: 'low', verificationEvidence: 'git-diff', evidenceFile: deterministicEvidence, verifiedAt: now });
    } else {
      phantom.push({ ...d, status: 'phantom', confidence: 'low', verifiedAt: now });
    }
  }

  // HF-1: rescue any LLM-marked phantom whose affected files are all present in the
  // diff with substantive hunks — trust the diff over the LLM's "no evidence" call.
  for (const p of result.phantom) {
    const d = byId.get(p.id);
    if (!d || classified.has(p.id)) continue;
    classified.add(p.id);
    const evidenceFile = substantiveEvidence(d, diffByFile);
    if (evidenceFile) {
      verified.push({ ...d, status: 'verified', confidence: 'low', verificationEvidence: 'git-diff', evidenceFile, verifiedAt: now });
    } else {
      phantom.push({ ...d, status: 'phantom', confidence: 'low', verifiedAt: now });
    }
  }

  return { verified, phantom, missing: result.missing };
}

/**
 * Mark decisions that could not be checked against a git diff without claiming evidence.
 * change: harden-api-decision-and-generate-safety
 */
export function markVerificationEvidenceAbsent(decisions: PendingDecision[]): PendingDecision[] {
  return decisions.map((decision) => ({
    ...decision,
    status: 'verified',
    confidence: 'medium',
    verificationEvidence: 'none',
  }));
}
