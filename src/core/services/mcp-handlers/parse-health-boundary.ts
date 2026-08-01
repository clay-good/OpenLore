/**
 * Parse-health boundary surfacing (change: add-parse-health-boundary-disclosure).
 *
 * The analyzer records per-file parse health into `parse-health.json`. This module is the read side
 * shared by every MCP surface that discloses it: it loads the report and, given the files a
 * conclusion's result set touches, produces a single disclosed boundary string when any of them
 * parsed with errors — so a conclusion built on a degraded file says *"symbols/edges there are a
 * lower bound"* instead of implying the missing symbols are genuinely absent (the `NoFalseCompleteness`
 * failure mode). A clean repo has no artifact, so every helper here fails open to "no boundary".
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH } from '../../../constants.js';
import { EXCLUSION_REASON_LABEL, type ParseHealthReport, type FileParseHealth } from '../../analyzer/parse-health.js';
import { describeMemoryDegradation } from '../../analyzer/memory-strategy.js';

/** Load the persisted parse-health report, or `null` when absent/unreadable (a clean repo). */
export async function loadParseHealthReport(absDir: string): Promise<ParseHealthReport | null> {
  const path = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as ParseHealthReport;
    return Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

/** How many files listed in a boundary before it collapses to "and N more". */
const BOUNDARY_FILE_CAP = 5;

function describe(h: FileParseHealth): string {
  // An EXCLUDED file names its cause (change: fix-analyze-native-abort-and-file-cost-budget) —
  // "abandoned at the per-file parse budget of 20.0s" is actionable in a way "parse failed" is
  // not, and it distinguishes a file the analyzer gave up on from one the grammar rejected.
  //
  // The reason comes off a file on disk, which a newer OpenLore (or a hand edit) may have written
  // with a value this build has no label for. Echoing the raw reason beats rendering `undefined`.
  if (h.exclusion) {
    const bound = h.budgetMs !== undefined ? ` of ${(h.budgetMs / 1000).toFixed(1)}s` : '';
    return `${h.filePath} (${EXCLUSION_REASON_LABEL[h.exclusion] ?? h.exclusion}${bound})`;
  }
  if (h.parseFailed) return `${h.filePath} (parse failed — contributed no symbols)`;
  const parts: string[] = [];
  if (h.errorCount) parts.push(`${h.errorCount} error region${h.errorCount === 1 ? '' : 's'}`);
  if (h.missingCount) parts.push(`${h.missingCount} missing token${h.missingCount === 1 ? '' : 's'}`);
  if (h.encodingFallback) parts.push('lossy encoding');
  return `${h.filePath} (${parts.join(', ') || 'parse-health signal'})`;
}

/**
 * The per-file boundary: files in THIS result set that parsed with errors, or `undefined`.
 * Deterministic (sorted); bounded file list.
 */
function perFileBoundary(
  report: ParseHealthReport,
  touchedFiles: Iterable<string>,
): string | undefined {
  if (report.files.length === 0) return undefined;
  const byPath = new Map(report.files.map(f => [f.filePath, f]));
  const hits: FileParseHealth[] = [];
  const seen = new Set<string>();
  for (const f of touchedFiles) {
    if (seen.has(f)) continue;
    seen.add(f);
    const h = byPath.get(f);
    if (h) hits.push(h);
  }
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  const shown = hits.slice(0, BOUNDARY_FILE_CAP).map(describe);
  const extra = hits.length - shown.length;
  return (
    `Parse health: ${hits.length} file${hits.length === 1 ? '' : 's'} in this result parsed with errors — ` +
    `symbols and edges there are a LOWER BOUND, not proof of absence: ${shown.join('; ')}` +
    `${extra > 0 ? `; and ${extra} more` : ''}.`
  );
}

/**
 * Given the files a conclusion's result set touches, return a disclosed boundary string, else
 * `undefined`. Two disclosures ride the same string:
 *
 *  1. the per-file boundary — files IN THIS result that parsed with errors;
 *  2. a whole-analysis memory-pressure reduction (change: make-analyze-scale-to-any-repo). When the
 *     degradation ladder shed the CFG overlay and/or deep-analysis breadth, that reduction has NO
 *     per-file record — it affects every result over this index — so it is surfaced REGARDLESS of
 *     which files the result touched. Without this the shed coverage would read as genuine absence,
 *     the exact `NoFalseCompleteness` failure the disclosure exists to prevent.
 */
export function parseHealthBoundary(
  report: ParseHealthReport | null,
  touchedFiles: Iterable<string>,
): string | undefined {
  if (!report) return undefined;
  const sentences: string[] = [];
  const perFile = perFileBoundary(report, touchedFiles);
  if (perFile) sentences.push(perFile);
  const degradation = describeMemoryDegradation(report.memoryDegradation);
  if (degradation) sentences.push(`${degradation}.`);
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}
