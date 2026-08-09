/**
 * Drift Detection Engine
 *
 * Compares code changes (from git) against existing specs (from spec-mapper)
 * to detect gaps, stale specs, uncovered files, and orphaned specs.
 */

import { access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { DRIFT_CLASSIFICATION_MAX_TOKENS, OPENLORE_DIR, OPENSPEC_DIR } from '../../constants.js';
import type {
  ChangedFile,
  DriftIssue,
  DriftIssueKind,
  DriftResult,
  DriftSeverity,
  SpecMap,
} from '../../types/index.js';
import { matchFileToDomains, getSpecContent, type ADRMap } from './spec-mapper.js';
import { getFileDiff } from './git-diff.js';
import type { LLMService } from '../services/llm-service.js';
import logger from '../../utils/logger.js';
import { loadDecisionStore, INACTIVE_STATUSES } from '../decisions/store.js';
import { loadMemoryStore } from '../decisions/memory-store.js';
import { AnchorContext } from '../decisions/anchor-adapter.js';
import { memoryFreshness, decisionAnchors, isStaleRegionOnly } from '../decisions/anchor.js';
import type { StructuralAnchor, AnchorVerdict } from '../../types/index.js';
import { createPromptBoundary } from '../../utils/prompt-boundary.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DriftDetectorOptions {
  rootPath: string;
  specMap: SpecMap;
  changedFiles: ChangedFile[];
  failOn: DriftSeverity;
  llm?: LLMService;
  domainFilter?: string[];
  /** Relative path to the openspec directory (e.g. "openspec"). Used for spec-change detection. */
  openspecRelPath?: string;
  /** Git base ref for fetching file diffs (needed for LLM enhancement). */
  baseRef?: string;
  /** Maximum number of LLM calls per run (default: 10). */
  maxLlmCalls?: number;
  /** Optional ADR map for ADR drift detection. */
  adrMap?: ADRMap;
}

// ============================================================================
// FILE RELEVANCE
// ============================================================================

/** High-value filename patterns that indicate spec-relevant source files */
const HIGH_VALUE_PATTERNS = [
  /service/i, /controller/i, /handler/i, /middleware/i,
  /model/i, /schema/i, /entity/i, /repository/i,
  /route/i, /api/i, /auth/i, /database/i,
];

/**
 * Determine if a changed file is relevant for spec drift detection.
 * Filters out test files, generated files, lock files, assets, etc.
 * @param openspecRelPath - relative path to the openspec directory (default: "openspec")
 */
export function isSpecRelevantChange(file: ChangedFile, openspecRelPath: string = OPENSPEC_DIR): boolean {
  // Always skip tests and generated files
  if (file.isTest || file.isGenerated) return false;

  // Skip openspec directory changes (those are spec updates, not drift)
  // Normalize leading "./" from config paths to match git-reported paths
  const normalizedSpecPath = openspecRelPath.replace(/^\.\//, '').replace(/\/$/, '');
  const specPrefix = normalizedSpecPath + '/';
  if (file.path.startsWith(specPrefix) || file.path.startsWith(`${OPENLORE_DIR}/`)) return false;

  // Skip markdown files: docs, changelogs, readmes, contributing guides, etc.
  // Only source-embedded .md in non-root src directories could be spec-relevant.
  if (file.extension === '.md') {
    const fileName = basename(file.path).toLowerCase();
    const dir = file.path.split('/')[0];
    // Skip docs directories
    if (dir === 'docs' || dir === 'doc') return false;
    // Skip common standalone markdown files
    if (/^(readme|changelog|changes|history|contributing|license|authors|code.of.conduct|security|todo)/i.test(fileName)) {
      return false;
    }
    // Skip root-level markdown (not inside src/)
    if (!file.path.includes('/')) return false;
  }

  // Skip static assets and lock files (already filtered by git-diff, but double-check)
  const skipExtensions = new Set([
    '.lock', '.lockb', '.map', '.min.js', '.min.css',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.woff', '.woff2', '.ttf',
  ]);
  if (skipExtensions.has(file.extension)) return false;

  // Skip CI/CD configs
  const fileName = basename(file.path);
  if (fileName === '.github' || file.path.startsWith('.github/')) return false;
  if (fileName === '.gitlab-ci.yml' || fileName === 'Dockerfile') return false;

  // Config files: some are relevant (config.ts, settings.ts), some aren't
  if (file.isConfig) {
    // Manifest files with new dependencies can signal new capabilities
    if (fileName === 'package.json') return true;
    // Build configs are not spec-relevant
    if (/tsconfig|eslint|prettier|babel|jest|vitest|webpack|rollup|vite\.config/i.test(fileName)) {
      return false;
    }
    // App config files are relevant
    return true;
  }

  return true;
}

/**
 * Check if a file is a high-value source file (services, controllers, models, etc.)
 */
function isHighValueFile(filePath: string): boolean {
  const fileName = basename(filePath);
  return HIGH_VALUE_PATTERNS.some(p => p.test(fileName));
}

/**
 * Compute severity based on issue kind and change magnitude
 */
export function computeSeverity(kind: DriftIssueKind, file: ChangedFile): DriftSeverity {
  const totalChanges = file.additions + file.deletions;

  switch (kind) {
    case 'gap':
      if (totalChanges > 30 && isHighValueFile(file.path)) return 'error';
      if (totalChanges > 5) return 'warning';
      return 'info';
    case 'stale':
      if (file.status === 'deleted') return 'error';
      return 'warning';
    case 'uncovered':
      if (isHighValueFile(file.path)) return 'warning';
      return 'info';
    case 'orphaned-spec':
      return 'warning';
    default:
      return 'info';
  }
}

// ============================================================================
// DETECTION ALGORITHMS
// ============================================================================

/**
 * Extract domain names whose specs were also changed in this changeset.
 * Must be called on the FULL changedFiles list (before isSpecRelevantChange
 * filtering), because spec files live under openspec/ which isSpecRelevantChange
 * intentionally excludes from source-drift analysis.
 *
 * @param openspecRelPath - relative path prefix for spec files (default: "openspec")
 */
export function extractChangedSpecDomains(changedFiles: ChangedFile[], openspecRelPath: string = OPENSPEC_DIR): Set<string> {
  const domains = new Set<string>();
  // Normalize: strip leading "./" and trailing slash, escape for regex
  const prefix = openspecRelPath.replace(/^\.\//, '').replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${prefix}/specs/([^/]+)/`);
  for (const file of changedFiles) {
    const specMatch = file.path.match(pattern);
    if (specMatch) {
      domains.add(specMatch[1]);
    }
  }
  return domains;
}

/**
 * Detect gaps: code changed in a domain but spec wasn't updated.
 * Pass pre-computed changedSpecDomains to avoid depending on openspec/ files
 * being present in changedFiles (they are excluded by isSpecRelevantChange).
 */
export function detectGaps(changedFiles: ChangedFile[], specMap: SpecMap, changedSpecDomains?: Set<string>, openspecRelPath?: string): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // Use pre-computed set if available, otherwise extract from full list
  const updatedSpecDomains = changedSpecDomains ?? extractChangedSpecDomains(changedFiles);

  for (const file of changedFiles) {
    if (!isSpecRelevantChange(file, openspecRelPath)) continue;
    if (file.status === 'deleted') continue; // Deletions handled by detectStaleSpecs

    const domains = matchFileToDomains(file.path, specMap);
    if (domains.length === 0) continue; // No spec coverage — handled by detectUncoveredFiles

    for (const domain of domains) {
      // If the spec was also updated, no gap
      if (updatedSpecDomains.has(domain)) continue;

      const mapping = specMap.byDomain.get(domain);
      const severity = computeSeverity('gap', file);

      issues.push({
        id: `gap:${file.path}:${domain}`,
        kind: 'gap',
        severity,
        message: `File \`${file.path}\` changed (+${file.additions}/-${file.deletions} lines) but spec \`${mapping?.specPath ?? domain}\` was not updated`,
        filePath: file.path,
        domain,
        specPath: mapping?.specPath ?? null,
        changedLines: { added: file.additions, removed: file.deletions },
        suggestion: `Review the ${domain} spec to ensure it still accurately describes the behavior in ${file.path}`,
      });
    }
  }

  return issues;
}

/**
 * Detect stale specs: spec references files that were deleted or heavily modified
 */
export function detectStaleSpecs(changedFiles: ChangedFile[], specMap: SpecMap): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // Build a lookup of changed files by path
  const changedByPath = new Map<string, ChangedFile>();
  for (const file of changedFiles) {
    changedByPath.set(file.path, file);
    if (file.oldPath) {
      changedByPath.set(file.oldPath, file);
    }
  }

  for (const [domain, mapping] of specMap.byDomain) {
    for (const sourceFile of mapping.declaredSourceFiles) {
      const changed = changedByPath.get(sourceFile);
      if (!changed) continue;

      if (changed.status === 'deleted') {
        issues.push({
          id: `stale:${sourceFile}:${domain}`,
          kind: 'stale',
          severity: 'error',
          message: `Spec \`${mapping.specPath}\` references deleted file \`${sourceFile}\``,
          filePath: sourceFile,
          domain,
          specPath: mapping.specPath,
          suggestion: `Update the ${domain} spec to remove references to ${sourceFile}`,
        });
      } else if (changed.status === 'renamed') {
        issues.push({
          id: `stale:${sourceFile}:${domain}`,
          kind: 'stale',
          severity: 'warning',
          message: `Spec \`${mapping.specPath}\` references \`${sourceFile}\` which was renamed to \`${changed.path}\``,
          filePath: sourceFile,
          domain,
          specPath: mapping.specPath,
          suggestion: `Update the ${domain} spec to reference the new path \`${changed.path}\``,
        });
      }
    }
  }

  return issues;
}

/**
 * Detect uncovered files: new files that don't map to any spec domain
 */
export function detectUncoveredFiles(changedFiles: ChangedFile[], specMap: SpecMap, openspecRelPath?: string): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const file of changedFiles) {
    if (!isSpecRelevantChange(file, openspecRelPath)) continue;
    if (file.status !== 'added') continue;

    const domains = matchFileToDomains(file.path, specMap);
    if (domains.length > 0) continue; // Already covered by a domain

    const severity = computeSeverity('uncovered', file);

    issues.push({
      id: `uncovered:${file.path}`,
      kind: 'uncovered',
      severity,
      message: `New file \`${file.path}\` has no matching spec domain`,
      filePath: file.path,
      domain: null,
      specPath: null,
      changedLines: { added: file.additions, removed: 0 },
      suggestion: `Consider adding \`${file.path}\` to an existing spec domain or creating a new spec`,
    });
  }

  return issues;
}

/** Meta-domains that describe architecture/overview rather than owning source files */
const META_DOMAINS = new Set(['overview', 'architecture']);

/**
 * Detect orphaned specs: spec declares source files that don't exist on disk.
 * Skips meta-domains (overview, architecture) which often have generic paths.
 */
export async function detectOrphanedSpecs(specMap: SpecMap, rootPath: string): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];

  for (const [domain, mapping] of specMap.byDomain) {
    // Skip meta-domains — their "source files" are structural, not ownable
    if (META_DOMAINS.has(domain)) continue;

    for (const sourceFile of mapping.declaredSourceFiles) {
      const fullPath = join(rootPath, sourceFile);
      try {
        await access(fullPath);
      } catch {
        issues.push({
          id: `orphaned-spec:${sourceFile}:${domain}`,
          kind: 'orphaned-spec',
          severity: 'warning',
          message: `Spec \`${mapping.specPath}\` declares source file \`${sourceFile}\` which does not exist`,
          filePath: sourceFile,
          domain,
          specPath: mapping.specPath,
          suggestion: `Update the ${domain} spec to remove the reference to \`${sourceFile}\`, or restore the file`,
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// ADR DRIFT DETECTION
// ============================================================================

/**
 * Canonical ADR id form so that zero-padded and unpadded spellings of the same
 * decision ("ADR-23", "ADR-023", "ADR-0023") compare equal. Applied on BOTH sides
 * of ADR drift detection — the ids extracted from changed files and the ids keyed
 * in the ADR map — so a padding mismatch can never defeat adr-gap suppression.
 */
export function normalizeADRId(id: string): string {
  const match = id.match(/ADR-0*(\d+)/i);
  if (!match) return id;
  return `ADR-${match[1]}`;
}

/**
 * Extract ADR IDs that were changed in this changeset.
 * Matches files like: openspec/decisions/adr-0001-foo.md
 */
export function extractChangedADRIds(changedFiles: ChangedFile[], openspecRelPath: string = OPENSPEC_DIR): Set<string> {
  const ids = new Set<string>();
  const prefix = openspecRelPath.replace(/^\.\//, '').replace(/\/$/, '');
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/decisions/adr-(\\d+)-`);
  for (const file of changedFiles) {
    const match = file.path.match(pattern);
    if (match) {
      ids.add(normalizeADRId(`ADR-${match[1]}`));
    }
  }
  return ids;
}

/**
 * Detect ADR gaps: code changed in a domain referenced by an ADR,
 * but the ADR wasn't updated. Reports once per ADR, not per file.
 * Severity is always 'info' — most code changes don't invalidate decisions.
 */
export function detectADRGaps(
  changedFiles: ChangedFile[],
  adrMap: ADRMap,
  specMap: SpecMap,
  changedADRIds: Set<string>,
  openspecRelPath?: string,
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const reportedADRs = new Set<string>();

  // Normalize the changed-ADR ids so suppression compares canonical forms on both
  // sides — a zero-padding mismatch (map key "ADR-0023" vs extracted "ADR-23") must
  // not defeat the "you updated the ADR" suppression below.
  const changedADRIdsNormalized = new Set<string>();
  for (const cid of changedADRIds) changedADRIdsNormalized.add(normalizeADRId(cid));

  // Collect all domains that have changed code
  const changedDomains = new Set<string>();
  for (const file of changedFiles) {
    if (!isSpecRelevantChange(file, openspecRelPath)) continue;
    if (file.status === 'deleted') continue;
    const domains = matchFileToDomains(file.path, specMap);
    for (const d of domains) changedDomains.add(d);
  }

  // For each ADR, check if any of its related domains had code changes
  for (const [id, mapping] of adrMap.byId) {
    if (changedADRIdsNormalized.has(normalizeADRId(id))) continue;
    if (reportedADRs.has(id)) continue;

    const affectedDomains = mapping.relatedDomains.filter(d => changedDomains.has(d));
    if (affectedDomains.length === 0) continue;

    reportedADRs.add(id);
    issues.push({
      id: `adr-gap:${mapping.adrPath}:${id}`,
      kind: 'adr-gap',
      severity: 'info',
      message: `Code changed in domain(s) ${affectedDomains.join(', ')} referenced by ${id}: "${mapping.title}"`,
      filePath: mapping.adrPath,
      domain: affectedDomains[0],
      specPath: mapping.adrPath,
      suggestion: `Review ${id} to ensure the decision still applies after changes to ${affectedDomains.join(', ')}`,
    });
  }

  return issues;
}

/**
 * Detect orphaned ADRs: ADR references domains that no longer exist in specs.
 */
export function detectADROrphaned(adrMap: ADRMap, specMap: SpecMap): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const [id, mapping] of adrMap.byId) {
    const orphanedDomains = mapping.relatedDomains.filter(d => !specMap.byDomain.has(d));
    if (orphanedDomains.length === 0) continue;

    issues.push({
      id: `adr-orphaned:${mapping.adrPath}:${id}`,
      kind: 'adr-orphaned',
      severity: 'info',
      message: `${id}: "${mapping.title}" references domain(s) ${orphanedDomains.join(', ')} which no longer exist in specs`,
      filePath: mapping.adrPath,
      domain: null,
      specPath: mapping.adrPath,
      suggestion: `Review ${id} — the referenced domain(s) ${orphanedDomains.join(', ')} may have been removed or renamed`,
    });
  }

  return issues;
}

// ============================================================================
// SEVERITY COMPARISON
// ============================================================================

const SEVERITY_RANK: Record<DriftSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

/**
 * Check if an issue meets or exceeds the given severity threshold
 */
function meetsThreshold(issue: DriftIssue, threshold: DriftSeverity): boolean {
  return SEVERITY_RANK[issue.severity] >= SEVERITY_RANK[threshold];
}

// ============================================================================
// LLM ENHANCEMENT
// ============================================================================

const LLM_SYSTEM_PROMPT = `You are a spec drift analyzer. Given a code diff and a specification, determine if the code change affects behavior described in the spec.

Respond with JSON only: { "relevant": boolean, "confidence": "high" | "medium" | "low", "reason": "one sentence explanation" }

- relevant=true: The change modifies, adds, or removes behavior covered by the spec
- relevant=false: The change is internal (refactoring, formatting, comments, test-only, perf optimization) and doesn't affect spec-described behavior

Be conservative: if unsure, mark as relevant.`;

interface LLMClassification {
  relevant: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * Post-process gap issues using an LLM to determine if code changes
 * actually affect spec-documented behavior. This reduces false positives
 * by dismissing purely internal changes (refactoring, formatting, etc.).
 *
 * Only processes 'gap' issues. Other issue types (stale, uncovered, orphaned)
 * are structural and don't benefit from semantic analysis.
 */
export async function enhanceGapsWithLLM(
  issues: DriftIssue[],
  options: {
    llm: LLMService;
    rootPath: string;
    specMap: SpecMap;
    baseRef: string;
    maxLlmCalls?: number;
    /** Override diff fetching (for testing) */
    _getDiff?: (rootPath: string, filePath: string, baseRef: string) => Promise<string>;
    /** Override spec content fetching (for testing) */
    _getSpec?: (domain: string, specMap: SpecMap, rootPath: string) => Promise<string | null>;
  },
): Promise<DriftIssue[]> {
  const { llm, rootPath, specMap, baseRef, maxLlmCalls = 10 } = options;
  const getDiff = options._getDiff ?? getFileDiff;
  const getSpec = options._getSpec ?? getSpecContent;

  // Separate gap issues from non-gap issues
  const gapIssues = issues.filter(i => i.kind === 'gap');
  const nonGapIssues = issues.filter(i => i.kind !== 'gap');

  if (gapIssues.length === 0) {
    return issues;
  }

  // Prioritize: errors first, then warnings, then info
  const sortedGaps = [...gapIssues].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  // Cap at maxLlmCalls
  const toProcess = sortedGaps.slice(0, maxLlmCalls);
  const skipped = sortedGaps.slice(maxLlmCalls);

  const enhancedGaps: DriftIssue[] = [];

  for (const issue of toProcess) {
    try {
      // Get the code diff for this file
      const diff = await getDiff(rootPath, issue.filePath, baseRef);
      if (!diff) {
        enhancedGaps.push(issue);
        continue;
      }

      // Get the spec content for this domain
      const specContent = issue.domain
        ? await getSpec(issue.domain, specMap, rootPath)
        : null;
      if (!specContent) {
        enhancedGaps.push(issue);
        continue;
      }

      // Ask the LLM
      const boundary = createPromptBoundary();
      const userPrompt = boundary.wrap(
        `## Code Diff\n${diff}\n\n## Specification (${issue.domain})\n${specContent}`,
      );

      const response = await llm.complete({
        systemPrompt: `${LLM_SYSTEM_PROMPT}\n\n${boundary.instruction}`,
        userPrompt,
        temperature: 0.1,
        maxTokens: DRIFT_CLASSIFICATION_MAX_TOKENS,
        responseFormat: 'json',
      });

      // Parse LLM response
      const classification = parseLLMClassification(response.content);

      if (classification) {
        if (!classification.relevant && classification.confidence === 'high') {
          // Downgrade to info — change is not spec-relevant
          enhancedGaps.push({
            ...issue,
            severity: 'info',
            suggestion: `[LLM-extracted] Not spec-relevant: ${classification.reason}`,
          });
        } else if (classification.relevant) {
          // Keep severity, enrich suggestion with LLM reasoning
          enhancedGaps.push({
            ...issue,
            suggestion: `${issue.suggestion} [LLM-extracted: ${classification.reason}]`,
          });
        } else {
          // Low/medium confidence non-relevant — keep as-is but annotate
          enhancedGaps.push({
            ...issue,
            suggestion: `${issue.suggestion} [LLM-extracted (${classification.confidence} confidence): possibly not spec-relevant — ${classification.reason}]`,
          });
        }
      } else {
        // Could not parse LLM response — keep issue unchanged
        enhancedGaps.push(issue);
      }
    } catch (error) {
      logger.debug(`LLM enhancement failed for ${issue.filePath}: ${(error as Error).message}`);
      enhancedGaps.push(issue);
    }
  }

  // Recombine: non-gap issues + enhanced gaps + skipped gaps (unchanged)
  return [...nonGapIssues, ...enhancedGaps, ...skipped];
}

/**
 * Parse the LLM's JSON response into a classification object.
 * Handles markdown code blocks, extra whitespace, etc.
 */
function parseLLMClassification(content: string): LLMClassification | null {
  try {
    // Strip markdown code blocks if present
    let jsonStr = content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    // Validate expected shape
    if (typeof parsed.relevant !== 'boolean') return null;
    if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
      parsed.confidence = 'medium'; // Default if invalid
    }
    if (typeof parsed.reason !== 'string') {
      parsed.reason = 'No reason provided';
    }

    return {
      relevant: parsed.relevant,
      confidence: parsed.confidence,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// MAIN DETECTION
// ============================================================================

/**
 * Run all drift detection algorithms and produce a combined result
 */
/**
 * Detect code-anchored memory that has gone stale against the current call graph
 * (change: add-code-anchored-memory-staleness). Scans active decisions and
 * `remember` notes, computing a deterministic freshness verdict per memory:
 *   - orphaned (anchored code gone)    → `memory-orphaned` (warning)
 *   - drifted  (anchored code changed) → `memory-drifted`  (info)
 *   - fresh                            → no issue
 *
 * Unlike the diff-based detectors this is a full-store scan of the current state,
 * not a function of the changeset — a memory is stale because the code moved,
 * regardless of what this commit touched. Returns [] when no analysis exists
 * (freshness is unverifiable without the graph) — never a false "stale".
 */
export async function detectMemoryStaleness(rootPath: string): Promise<DriftIssue[]> {
  const ctx = AnchorContext.open(rootPath);
  if (!ctx) return [];
  try {
    const view = ctx.freshnessView();
    const [decisionStore, memStore] = await Promise.all([
      loadDecisionStore(rootPath),
      loadMemoryStore(rootPath),
    ]);
    const issues: DriftIssue[] = [];

    for (const d of decisionStore.decisions) {
      if (INACTIVE_STATUSES.has(d.status)) continue;
      const anchors = decisionAnchors(d);
      if (anchors.length === 0) continue;
      const f = memoryFreshness(anchors, view);
      if (f.freshness === 'fresh') continue;
      // A pure stale-region downgrade is NOT code-drift — the anchored code is
      // byte-identical; an incremental update just hasn't recomputed its topology
      // yet (it self-heals). Reporting "the code changed" here would be a false
      // claim, so skip it (recall surfaces the stale-region state separately).
      if (isStaleRegionOnly(f.verdicts)) continue;
      issues.push(makeMemoryStalenessIssue('decision', d.id, d.title, f.freshness, f.verdicts, d.affectedDomains[0] ?? null));
    }

    for (const m of memStore.memories) {
      // Invalidated (superseded) notes are history, not current state — they have left
      // the authoritative set per the memory-integrity invariant, exactly as recall and
      // orient exclude them. Flagging a retired note as stale would tell the user to
      // re-record or reject something already superseded.
      // (add-bitemporal-typed-memory-operations)
      if (m.invalidatedAt) continue;
      if (m.anchors.length === 0) continue;
      const f = memoryFreshness(m.anchors, view);
      if (f.freshness === 'fresh') continue;
      if (isStaleRegionOnly(f.verdicts)) continue; // not code-drift (see above)
      issues.push(makeMemoryStalenessIssue('note', m.id, m.content, f.freshness, f.verdicts, null));
    }

    return issues;
  } finally {
    ctx.close();
  }
}

/** Build a DriftIssue for a stale (orphaned/drifted) memory. */
function makeMemoryStalenessIssue(
  memKind: 'decision' | 'note',
  id: string,
  text: string,
  freshness: 'drifted' | 'orphaned',
  verdicts: AnchorVerdict[],
  domain: string | null,
): DriftIssue {
  const kind: DriftIssueKind = freshness === 'orphaned' ? 'memory-orphaned' : 'memory-drifted';
  const offending = verdicts.find((v) => v.freshness === freshness)?.anchor as StructuralAnchor | undefined;
  const label = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  const subject = offending?.symbolName ?? offending?.filePath ?? 'its anchored code';
  return {
    id: `${kind}:${memKind}:${id}`,
    kind,
    severity: freshness === 'orphaned' ? 'warning' : 'info',
    message:
      freshness === 'orphaned'
        ? `${memKind === 'decision' ? 'Decision' : 'Memory'} "${label}" is anchored to ${subject}, which no longer exists.`
        : `${memKind === 'decision' ? 'Decision' : 'Memory'} "${label}" is anchored to ${subject}, which changed since it was recorded.`,
    filePath: offending?.filePath ?? '',
    domain,
    specPath: null,
    suggestion:
      freshness === 'orphaned'
        ? `Re-record this ${memKind} against current code, or reject it — its subject was renamed, moved, or deleted.`
        : `Verify this ${memKind} still holds and re-record it; the code it describes was modified.`,
  };
}

export async function detectDrift(options: DriftDetectorOptions): Promise<DriftResult> {
  const startTime = Date.now();
  const { specMap, changedFiles, failOn, rootPath, domainFilter, openspecRelPath } = options;

  // Pre-compute which spec domains were also updated in this changeset.
  // This must happen before any filtering, since openspec/ files are excluded
  // by isSpecRelevantChange but needed for gap detection.
  const changedSpecDomains = extractChangedSpecDomains(changedFiles, openspecRelPath);

  // Run all detection algorithms
  const gaps = detectGaps(changedFiles, specMap, changedSpecDomains, openspecRelPath);
  const stale = detectStaleSpecs(changedFiles, specMap);
  const uncovered = detectUncoveredFiles(changedFiles, specMap, openspecRelPath);
  const orphaned = await detectOrphanedSpecs(specMap, rootPath);

  // ADR drift detection (when ADR map is provided)
  let adrGaps: DriftIssue[] = [];
  let adrOrphanedIssues: DriftIssue[] = [];
  if (options.adrMap) {
    const changedADRIds = extractChangedADRIds(changedFiles, openspecRelPath);
    adrGaps = detectADRGaps(changedFiles, options.adrMap, specMap, changedADRIds, openspecRelPath);
    adrOrphanedIssues = detectADROrphaned(options.adrMap, specMap);
  }

  // Code-anchored memory staleness (full-state scan, independent of the diff).
  const memoryStaleness = await detectMemoryStaleness(rootPath);

  // Combine all issues
  let allIssues = [...gaps, ...stale, ...uncovered, ...orphaned, ...adrGaps, ...adrOrphanedIssues, ...memoryStaleness];

  // Apply domain filter if provided — exclude null-domain issues too,
  // since the user only wants results for the specified domains
  if (domainFilter && domainFilter.length > 0) {
    allIssues = allIssues.filter(
      issue => issue.domain !== null && domainFilter.includes(issue.domain)
    );
  }

  // Deduplicate by id
  const seen = new Set<string>();
  let dedupedIssues: DriftIssue[] = [];
  for (const issue of allIssues) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      dedupedIssues.push(issue);
    }
  }

  // LLM enhancement: post-process gap issues to reduce false positives
  if (options.llm && options.baseRef) {
    dedupedIssues = await enhanceGapsWithLLM(dedupedIssues, {
      llm: options.llm,
      rootPath,
      specMap,
      baseRef: options.baseRef,
      maxLlmCalls: options.maxLlmCalls,
    });
  }

  // Sort by severity (error > warning > info), then domain, then file path
  dedupedIssues.sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) return severityDiff;
    const domainDiff = (a.domain ?? '').localeCompare(b.domain ?? '');
    if (domainDiff !== 0) return domainDiff;
    return a.filePath.localeCompare(b.filePath);
  });

  // Count spec-relevant changed files
  const specRelevantFiles = changedFiles.filter(f => isSpecRelevantChange(f, openspecRelPath)).length;

  // Determine if drift was detected based on failOn threshold
  const hasDrift = dedupedIssues.some(issue => meetsThreshold(issue, failOn));

  const duration = Date.now() - startTime;

  return {
    timestamp: new Date().toISOString(),
    baseRef: options.baseRef ?? '',
    totalChangedFiles: changedFiles.length,
    specRelevantFiles,
    issues: dedupedIssues,
    summary: {
      gaps: dedupedIssues.filter(i => i.kind === 'gap').length,
      stale: dedupedIssues.filter(i => i.kind === 'stale').length,
      uncovered: dedupedIssues.filter(i => i.kind === 'uncovered').length,
      orphanedSpecs: dedupedIssues.filter(i => i.kind === 'orphaned-spec').length,
      adrGaps: dedupedIssues.filter(i => i.kind === 'adr-gap').length,
      adrOrphaned: dedupedIssues.filter(i => i.kind === 'adr-orphaned').length,
      memoryDrifted: dedupedIssues.filter(i => i.kind === 'memory-drifted').length,
      memoryOrphaned: dedupedIssues.filter(i => i.kind === 'memory-orphaned').length,
      total: dedupedIssues.length,
    },
    hasDrift,
    duration,
    mode: options.llm ? 'llm-enhanced' : 'static',
  };
}
