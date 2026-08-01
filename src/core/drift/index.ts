/**
 * Drift detection module
 *
 * Detects when code changes diverge from existing OpenSpec specifications.
 */

export { getChangedFiles, getFileDiff, getCommitMessages, isGitRepository, isGitRepositoryRoot, getRepoPrefix, reframeRepoPath, getCurrentBranch, resolveBaseRef, resolveBaseRefDisclosed, classifyFile, validateGitRef } from './git-diff.js';
export type { GitDiffOptions, GitDiffResult } from './git-diff.js';

export { buildSpecMap, matchFileToDomains, getSpecContent, parseSpecHeader, parseSpecReferences, inferDomainFromPath, buildADRMap, parseADRRelated } from './spec-mapper.js';
export type { SpecMapperOptions, ADRMapping, ADRMap } from './spec-mapper.js';

export { detectDrift, detectGaps, detectStaleSpecs, detectUncoveredFiles, detectOrphanedSpecs, isSpecRelevantChange, computeSeverity, extractChangedSpecDomains, enhanceGapsWithLLM, detectADRGaps, detectADROrphaned, extractChangedADRIds, normalizeADRId } from './drift-detector.js';
export type { DriftDetectorOptions } from './drift-detector.js';
