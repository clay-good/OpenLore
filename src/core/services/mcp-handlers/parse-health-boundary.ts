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
import { readArtifactBytesBounded } from '../../../utils/bounded-artifact-read.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH } from '../../../constants.js';
import { EXCLUSION_REASON_LABEL, type ParseHealthReport, type FileParseHealth } from '../../analyzer/parse-health.js';
import { UNREADABLE_CAUSES, type ReadabilityShortfall, type UnreadableCause } from '../../analyzer/retrieval-evidence.js';
import { describeMemoryDegradation } from '../../analyzer/memory-strategy.js';
import { describeScriptContainerBoundaries } from '../../analyzer/sfc-script-extractor.js';

/**
 * One parse-health read, with the one distinction a bare `null` cannot carry (change:
 * fix-retrieval-coverage-over-unread-content).
 *
 * An ABSENT artifact means a clean repository: every consumer reads it as "nothing degraded",
 * which is correct and is why clean repos pay nothing. An artifact that is PRESENT and could
 * not be read — refused (symlink / FIFO / oversized), truncated, or malformed — means the
 * opposite: the record of what was unreadable is itself unreadable, so "nothing degraded"
 * is a claim no one can make. Collapsing the two is how a corrupt record silences the very
 * disclosure it exists to carry.
 */
export interface ParseHealthLoad {
  report: ParseHealthReport | null;
  /** The artifact exists and could not be read or parsed. */
  artifactUnreadable: boolean;
}

/** Load the persisted parse-health report and say whether a present artifact was unreadable. */
export async function loadParseHealth(absDir: string): Promise<ParseHealthLoad> {
  const path = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH);
  // Bounded read: repository-controlled artifact (symlink / FIFO / oversized all fail closed).
  let raw: Awaited<ReturnType<typeof readArtifactBytesBounded>>;
  try {
    raw = await readArtifactBytesBounded(path);
  } catch {
    return { report: null, artifactUnreadable: true };
  }
  if (raw.state === 'absent') return { report: null, artifactUnreadable: false };
  if (raw.state === 'refused') return { report: null, artifactUnreadable: true };
  try {
    const parsed = JSON.parse(raw.bytes.toString('utf8')) as ParseHealthReport;
    return Array.isArray(parsed.files)
      ? { report: parsed, artifactUnreadable: false }
      : { report: null, artifactUnreadable: true };
  } catch {
    return { report: null, artifactUnreadable: true };
  }
}

/** Load the persisted parse-health report, or `null` when absent/unreadable (a clean repo). */
export async function loadParseHealthReport(absDir: string): Promise<ParseHealthReport | null> {
  return (await loadParseHealth(absDir)).report;
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
 *  2. language grammars that were unavailable for the whole analysis;
 *  3. a whole-analysis memory-pressure reduction (change: make-analyze-scale-to-any-repo). When the
 *     degradation ladder shed the CFG overlay and/or deep-analysis breadth, that reduction has NO
 *     per-file record — it affects every result over this index — so it is surfaced REGARDLESS of
 *     which files the result touched. Without this the shed coverage would read as genuine absence,
 *     the exact `NoFalseCompleteness` failure the disclosure exists to prevent.
 */
export function parseHealthBoundary(
  report: ParseHealthReport | null,
  touchedFiles: Iterable<string>,
  options: { repoWide?: boolean; artifactUnreadable?: boolean } = {},
): string | undefined {
  const sentences: string[] = [];
  // An artifact that is present and could not be read is itself a boundary, and it is the one
  // case with no report to describe. Returning "no boundary" here would let a corrupt record
  // silence the disclosure it exists to carry.
  if (options.repoWide && options.artifactUnreadable) {
    sentences.push(
      'Parse health: the parse-health record is present and could not be read, so what this '
      + 'index failed to read cannot be counted. Re-run "openlore analyze" to rebuild it.',
    );
  }
  if (!report) return sentences.length > 0 ? sentences.join(' ') : undefined;
  const perFile = perFileBoundary(report, touchedFiles);
  if (perFile) sentences.push(perFile);
  // The REPOSITORY-wide sentence, for the surfaces whose answer is a search over the whole index
  // (`orient`, `search_code`). The per-file sentence above is scoped to files the result set
  // surfaced, so it structurally cannot fire for the worst case: a file that produced zero
  // symbols never surfaces, and its silence is exactly what a confident empty answer rests on
  // (change: fix-retrieval-coverage-over-unread-content).
  if (options.repoWide) {
    const shortfall = readabilityShortfall(report, false);
    if (shortfall) {
      // NAME the files, not just the counts. A count tells an agent its answer is incomplete;
      // the paths tell it which question it should not trust. Bounded and sorted, and files
      // already named in the per-result sentence above are not repeated.
      const alreadyNamed = new Set(touchedFiles);
      const unnamed = report.files
        .filter(f => !alreadyNamed.has(f.filePath))
        .sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
      const shown = unnamed.slice(0, BOUNDARY_FILE_CAP).map(describe);
      const extra = unnamed.length - shown.length;
      sentences.push(
        `Repository-wide readability: ${shortfall.summary} `
        + 'A symbol that never parsed cannot appear in these results, so this answer is a LOWER '
        + 'BOUND over the readable part of the index, not proof of absence.'
        + (shown.length > 0
          ? ` Elsewhere in this repository: ${shown.join('; ')}${extra > 0 ? `; and ${extra} more` : ''}.`
          : ''),
      );
    }
  }
  if (report.grammarUnavailable?.length) {
    const boundaries = [...report.grammarUnavailable]
      .sort((a, b) => a.language < b.language ? -1 : a.language > b.language ? 1 : 0)
      .map(boundary =>
        `${boundary.language}: ${boundary.fileCount} file${boundary.fileCount === 1 ? '' : 's'} indexed for search but not graphed`);
    sentences.push(
      `Grammar unavailable — call-graph conclusions are a LOWER BOUND, not proof of absence (${boundaries.join('; ')}).`,
    );
  }
  const degradation = describeMemoryDegradation(report.memoryDegradation);
  if (degradation) sentences.push(`${degradation}.`);
  const containers = describeScriptContainerBoundaries(report.scriptContainers);
  if (containers) sentences.push(`Script-container boundary — ${containers}.`);
  return sentences.length > 0 ? sentences.join(' ') : undefined;
}

// ─── Repository-wide readability (change: fix-retrieval-coverage-over-unread-content) ────────

/** Per-cause phrasing, so every surface words the same shortfall the same way. */
const CAUSE_LABEL: Record<UnreadableCause, (n: number) => string> = {
  'parse-errors': n => `${n} file${n === 1 ? '' : 's'} parsed with errors`,
  'parse-failed': n => `${n} file${n === 1 ? '' : 's'} produced no usable tree`,
  'size-cap': n => `${n} file${n === 1 ? '' : 's'} exceeded a size cap and were never read`,
  'parse-budget': n => `${n} file${n === 1 ? '' : 's'} were abandoned at the per-file parse budget`,
  'lossy-encoding': n => `${n} file${n === 1 ? '' : 's'} decoded lossily`,
  'grammar-unavailable': n => `${n} file${n === 1 ? '' : 's'} were indexed for search but not graphed (grammar unavailable)`,
  'reduced-analysis': () => 'analysis breadth was reduced under memory pressure',
  'health-record-unreadable': () =>
    'the parse-health record itself is present and could not be read, so what went unread cannot be counted',
};

/**
 * Roll the persisted parse-health report up into the repository-wide readability shortfall the
 * coverage verdict reads, or `undefined` when nothing in the repository was unreadable.
 *
 * Cheap by construction: a pure fold over records the analyzer already wrote — no file is
 * re-read, no tree is re-parsed, and a clean repository has no artifact at all, so the whole
 * path costs one absent-file read. Nothing here is recomputed per result.
 *
 * Script-container boundaries are deliberately NOT a cause: a recognized `.vue`/`.svelte` file
 * whose script blocks WERE extracted is recorded there too, so counting it would degrade every
 * single-file-component repository's verdict and make the signal worthless. It stays in the
 * boundary text, where it belongs.
 */
export function readabilityShortfall(
  report: ParseHealthReport | null | undefined,
  artifactUnreadable = false,
): ReadabilityShortfall | undefined {
  const counts = new Map<UnreadableCause, number>();
  if (artifactUnreadable) counts.set('health-record-unreadable', 1);
  if (!report) {
    return counts.size === 0 ? undefined : {
      causes: ['health-record-unreadable'],
      degradedFiles: 0,
      excludedFiles: 0,
      summary: `${CAUSE_LABEL['health-record-unreadable'](1)}.`,
    };
  }
  const bump = (c: UnreadableCause, n = 1): void => { counts.set(c, (counts.get(c) ?? 0) + n); };
  let excludedFiles = 0;
  for (const f of report.files) {
    if (f.exclusion) {
      excludedFiles++;
      if (f.exclusion === 'size-cap') bump('size-cap');
      else if (f.exclusion === 'budget-exceeded') bump('parse-budget');
      else bump('parse-failed');
      continue;
    }
    if (f.parseFailed) { excludedFiles++; bump('parse-failed'); continue; }
    if (f.errorCount > 0 || f.missingCount > 0) bump('parse-errors');
    if (f.encodingFallback) bump('lossy-encoding');
  }
  for (const g of report.grammarUnavailable ?? []) bump('grammar-unavailable', g.fileCount);
  if (report.memoryDegradation) bump('reduced-analysis');
  if (counts.size === 0) return undefined;
  const causes = UNREADABLE_CAUSES.filter(c => counts.has(c));
  return {
    causes,
    degradedFiles: report.files.length,
    excludedFiles,
    summary: `${causes.map(c => CAUSE_LABEL[c](counts.get(c)!)).join('; ')}.`,
  };
}
