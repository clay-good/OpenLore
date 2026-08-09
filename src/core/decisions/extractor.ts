/**
 * Decision extractor — fallback path
 *
 * When an agent hasn't called record_decision during development,
 * this module extracts architectural decisions directly from the git diff.
 * Produces decisions at status 'consolidated' (lower confidence than
 * manually recorded drafts, but immediately ready for verification).
 */

import {
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
  DECISIONS_CONSOLIDATION_MAX_TOKENS,
} from '../../constants.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getChangedFiles, getFileDiff, resolveBaseRef } from '../drift/git-diff.js';
import { gitPathArgs } from '../../utils/git-args.js';
const execFileAsync = promisify(execFile);
import { matchFileToDomains, getSpecContent } from '../drift/spec-mapper.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision, SpecMap, DecisionScope } from '../../types/index.js';
import { makeDecisionId } from './store.js';
import { parseJSON } from '../../utils/misc.js';
import { createPromptBoundary } from '../../utils/prompt-boundary.js';

const SYSTEM_PROMPT = `You are an architectural decision extractor for a software project.

You receive git diffs for source files belonging to one spec domain, along with the existing requirements for that domain.

Your task: identify architectural decisions embedded in these changes — choices about structure, technology, contracts, or behavior that a future developer should understand.

Rules:
- Only surface decisions with architectural significance (not style fixes, typo patches, comment changes, test updates)
- A single diff may yield 0, 1, or 2 decisions
- For trivial changes return []
- proposedRequirement: one sentence in imperative form ("The system SHALL …"), or null

SCOPE CLASSIFICATION (required):
Each extraction call processes one spec domain at a time, so cross-domain scope cannot be
determined here. Classify only within the local/component axis:
- "local": single file, no cross-cutting concern (refactors, extractions, renames)
- "component": this component/service/module, may affect its public interface

Scope upgrade to "cross-domain" or "system" happens at consolidation time when the full
session context across all domains is visible.

Respond with a JSON array only. Each element:
{
  "title": string,
  "rationale": string,
  "consequences": string,
  "affectedFiles": string[],
  "proposedRequirement": string | null,
  "scope": string
}`;

interface ExtractedRaw {
  title: string;
  rationale: string;
  consequences: string;
  affectedFiles: string[];
  proposedRequirement: string | null;
  scope?: string;
}

export interface ExtractFromDiffOptions {
  rootPath: string;
  baseRef?: string;
  /** When true, use git diff --cached (staged changes only). Overrides baseRef. */
  stagedOnly?: boolean;
  specMap: SpecMap;
  sessionId: string;
  llm: LLMService;
}

function isRelevantStagedFile(filePath: string): boolean {
  const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
  if (ext === '.md' || ext === '.txt' || ext === '.json' || ext === '.lock') return false;
  if (filePath.startsWith('openspec/') || filePath.startsWith('.openlore/')) return false;
  if (filePath.includes('.test.') || filePath.includes('.spec.') || filePath.includes('/__tests__/')) return false;
  if (filePath.includes('/dist/') || filePath.includes('/node_modules/')) return false;
  return true;
}

async function getStagedFiles(rootPath: string): Promise<Array<{ path: string; status: string }>> {
  const { stdout } = await execFileAsync(
    'git', gitPathArgs('diff', '--cached', '--name-status', '--diff-filter=ACDMR'),
    { cwd: rootPath },
  );
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { path: rest.join('\t'), status: status ?? 'M' };
  });
}

async function getStagedFileDiff(rootPath: string, filePath: string, maxChars: number): Promise<string> {
  const { stdout } = await execFileAsync(
    'git', ['diff', '--cached', '--', filePath],
    { cwd: rootPath },
  );
  return stdout.length > maxChars ? stdout.slice(0, maxChars) + '\n... (truncated)' : stdout;
}

/**
 * Extract architectural decisions from the current git diff.
 * Used as fallback when the agent produced no record_decision drafts.
 * Returns decisions at status 'consolidated', ready for verification.
 */
export async function extractFromDiff(options: ExtractFromDiffOptions): Promise<PendingDecision[]> {
  const { rootPath, specMap, sessionId, llm, stagedOnly } = options;

  let files: Array<{ path: string; status: string }>;
  let getDiff: (filePath: string) => Promise<string>;

  if (stagedOnly) {
    files = await getStagedFiles(rootPath);
    getDiff = (f) => getStagedFileDiff(rootPath, f, DECISIONS_DIFF_MAX_CHARS);
  } else {
    const baseRef = await resolveBaseRef(rootPath, options.baseRef ?? 'auto');
    const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });
    files = gitResult.files;
    getDiff = (f) => getFileDiff(rootPath, f, baseRef, DECISIONS_DIFF_MAX_CHARS);
  }

  const relevant = files
    .filter((f) => isRelevantStagedFile(f.path))
    .slice(0, DECISIONS_EXTRACTION_MAX_FILES);

  if (relevant.length === 0) return [];

  // Group files by domain for coherent LLM calls
  const byDomain = new Map<string, typeof relevant>();
  for (const file of relevant) {
    const domains = matchFileToDomains(file.path, specMap);
    const key = domains[0] ?? 'unknown';
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key)!.push(file);
  }

  const results: PendingDecision[] = [];
  const now = new Date().toISOString();

  for (const [domain, domainFiles] of byDomain) {
    const diffs = await Promise.all(
      domainFiles.map((f) => getDiff(f.path))
    );

    const specExcerpt = await getSpecContent(domain, specMap, rootPath, 2_000) ?? '';
    const requirementsExcerpt = extractRequirements(specExcerpt);

    const userContent = [
      `Domain: ${domain}`,
      requirementsExcerpt ? `Existing requirements (excerpt):\n${requirementsExcerpt}` : '',
      '',
      ...domainFiles.map((f, i) => `=== ${f.path} ===\n${diffs[i]}`),
    ].filter(Boolean).join('\n\n');
    const boundary = createPromptBoundary();

    const response = await llm.complete({
      systemPrompt: `${SYSTEM_PROMPT}\n\n${boundary.instruction}`,
      userPrompt: boundary.wrap(userContent),
      maxTokens: DECISIONS_CONSOLIDATION_MAX_TOKENS,
      temperature: 0.1,
    });

    const extracted = parseJSON<ExtractedRaw[]>(response.content, []);

    for (const e of extracted) {
      const id = makeDecisionId(sessionId, domain, e.title);
      results.push({
        id,
        status: 'consolidated',
        title: e.title,
        rationale: e.rationale,
        consequences: e.consequences,
        proposedRequirement: e.proposedRequirement,
        scope: (e.scope as DecisionScope) ?? 'component',
        affectedDomains: [domain],
        affectedFiles: e.affectedFiles.length ? e.affectedFiles : domainFiles.map((f) => f.path),
        sessionId,
        recordedAt: now,
        consolidatedAt: now,
        confidence: 'medium',
        contentOrigin: 'llm-extracted',
        syncedToSpecs: [],
      });
    }
  }

  return results;
}

function extractRequirements(specContent: string): string {
  const lines = specContent.split('\n');
  const reqLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('### Requirement:') || (reqLines.length > 0 && line.startsWith('  '))) {
      reqLines.push(line);
      if (reqLines.length > 30) break;
    }
  }
  return reqLines.join('\n');
}
