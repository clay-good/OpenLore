/**
 * `get_language_support` — the queryable coverage answer for the declarative
 * language-support registry (change: add-declarative-language-support-registry).
 *
 * Turns "is language L supported, and for what?" from tribal knowledge into a
 * conclusion-shaped, honest answer. With a named `language` it is a pure registry
 * lookup (fail-soft: an unknown language returns an all-unsupported record, never an
 * error). With no language it reports the coverage matrix for the repo's DETECTED
 * languages, so a quiet result elsewhere is interpretable ("calls unsupported for L"
 * vs. "no callers"). Read-only, deterministic, opt-in. No LLM.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import {
  CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  languageSupport,
  languageCoverageMatrix,
  resolveLanguageName,
  type Capability,
} from '../../analyzer/language-support.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { grammarStatus as liveGrammarStatus, type GrammarStatus } from '../../analyzer/call-graph.js';
import { compactParseHealthSummary } from '../../analyzer/parse-health.js';
import { loadParseHealthReport } from './parse-health-boundary.js';
import { describeMemoryDegradation } from '../../analyzer/memory-strategy.js';

export interface GetLanguageSupportInput {
  directory: string;
  /** A specific language name (e.g. "Go", "Rust"). Omit to report the repo's detected languages. */
  language?: string;
}

/** One language's support, rendered for the conclusion. */
export interface LanguageSupportView {
  language: string;
  /** Whether the language is a known registry key (false → fail-soft "nothing claimed"). */
  known: boolean;
  /** Whether the language was detected in the analyzed repo (repo mode only). */
  detectedInRepo?: boolean;
  /** Supported capabilities, in canonical order. */
  supported: Capability[];
  /** The capabilities this language does NOT back (the rest). */
  unsupported: Capability[];
  supportedCount: number;
  /** Runtime availability of the grammar behind `callGraph`. */
  grammarStatus: GrammarStatus;
  /** Recognized script-container scope and the framework semantics still outside extraction. */
  container?: {
    recognized: true;
    extraction: 'script-blocks';
    limitations: string[];
  };
}

export interface GetLanguageSupportResult {
  mode: 'language' | 'repo';
  /** The repo's detected languages (repo mode). */
  detectedLanguages?: string[];
  languages: LanguageSupportView[];
  /** The closed capability set + what each means. */
  capabilities: Array<{ name: Capability; description: string }>;
  /**
   * Parse-health summary (change: add-parse-health-boundary-disclosure): the files where extraction
   * silently under-produced (parse errors, grammar drift, lossy encoding), per language. Absent on
   * a clean repo — a supported capability is not the same as a clean parse, and this says which.
   */
  parseHealth?: {
    totalDegradedFiles: number;
    byLanguage: string[];
    /** Language-level boundaries where no source file reached graph extraction. */
    grammarUnavailable?: string[];
    /**
     * One-line disclosure of a graceful-degradation-ladder reduction under memory pressure (change:
     * make-analyze-scale-to-any-repo). Present only when a tier was shed — a shed CFG overlay leaves
     * `totalDegradedFiles: 0`, so without this a reduced index would read as genuinely full.
     */
    memoryPressure?: string;
  };
  summary: string;
  disclosure: string;
}

const DISCLOSURE =
  'A capability is present and exercised, or absent (fail-soft) — an absent capability yields nothing ' +
  'for that language, never a guess or an error. So a quiet result from another tool ("no callers for X" ' +
  'in a Kotlin file) is interpretable here: if `callGraph` is supported the quiet means "no callers"; if ' +
  'it is unsupported the quiet means "calls are not extracted for this language." Likewise, an empty ' +
  '`select_tests` result is only interpretable as "no tests found" when `testDetection` is supported. `styleFingerprint` is ' +
  'not built for any language yet. The matrix is the true backing of the generic extractors, not a roadmap.';

function viewFor(
  language: string,
  detectedInRepo?: boolean,
  persistedGrammarStatus?: GrammarStatus,
): LanguageSupportView {
  const rec = languageSupport(language);
  return {
    language,
    known: rec.known,
    ...(detectedInRepo === undefined ? {} : { detectedInRepo }),
    supported: rec.capabilities,
    unsupported: CAPABILITIES.filter(c => !rec.capabilities.includes(c)),
    supportedCount: rec.capabilities.length,
    grammarStatus: persistedGrammarStatus ?? liveGrammarStatus(language),
    ...(rec.container ? { container: rec.container } : {}),
  };
}

/** Distinct, sorted languages tagged on the indexed internal nodes (the repo's real languages). */
function detectedLanguages(cg: SerializedCallGraph): string[] {
  const seen = new Set<string>();
  for (const n of cg.nodes) {
    if (n.isExternal) continue;
    if (n.language && n.language !== 'unknown') seen.add(n.language);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const CAP_META = CAPABILITIES.map(name => ({ name, description: CAPABILITY_DESCRIPTIONS[name] }));

export async function computeGetLanguageSupport(
  input: GetLanguageSupportInput,
): Promise<GetLanguageSupportResult | { error: string }> {
  const absDir = await validateDirectory(input.directory);

  // ── Named-language mode: a pure registry lookup, no analysis required (fail-soft). ──
  if (input.language && input.language.trim()) {
    const raw = input.language.trim();
    // Resolve case-insensitively ("go"/"GO"/" Go " → "Go") so the lookup is not a casing
    // foot-gun; a genuinely-unknown name stays fail-soft (known:false).
    const canon = resolveLanguageName(raw) ?? raw;
    const view = viewFor(canon);
    const summary = view.known
      ? `${canon} supports ${view.supportedCount}/${CAPABILITIES.length} capabilities: ${view.supported.join(', ') || 'none'}.`
      : `${raw} is not a recognized language; nothing is claimed for it (fail-soft).`;
    return { mode: 'language', languages: [view], capabilities: CAP_META, summary, disclosure: DISCLOSURE };
  }

  // ── Repo mode: coverage matrix over the languages actually detected in the index. ──
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;

  const phReport = await loadParseHealthReport(absDir);
  const unavailableLanguages = new Set(
    phReport?.grammarUnavailable?.map(boundary => boundary.language) ?? [],
  );
  const detected = [...new Set([...detectedLanguages(cg), ...unavailableLanguages])]
    .concat(phReport?.scriptContainers?.map(boundary => boundary.format) ?? [])
    .filter((language, index, all) => all.indexOf(language) === index)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // `detected` may be empty (a docs-only repo) — pass it straight through; an empty list
  // yields NO rows (not the whole registry), so `languages` never contradicts
  // `detectedLanguages`.
  const languages = languageCoverageMatrix(detected).rows.map(r => viewFor(
    r.language,
    true,
    unavailableLanguages.has(r.language) ? 'unavailable' : undefined,
  ));

  const fully = languages.filter(l => l.supportedCount === CAPABILITIES.length).length;
  const partial = languages.filter(l => l.known && l.supportedCount > 0 && l.supportedCount < CAPABILITIES.length).length;
  const summary = detected.length === 0
    ? 'No languages detected in the index — run analyze_codebase, or this repo has only unsupported file types.'
    : `${detected.length} language(s) detected: ${fully} fully covered, ${partial} partially covered. ` +
      `A partially-covered language means some conclusions (e.g. dead-code, type-resolved calls) are weaker there.`;

  // Parse-health overlay (change: add-parse-health-boundary-disclosure): a supported capability is
  // not the same as a clean parse. Absent on a clean repo (no artifact), so healthy repos are
  // unchanged. `memoryPressure` additionally discloses a graceful-degradation-ladder reduction
  // (change: make-analyze-scale-to-any-repo) — a shed CFG overlay leaves `totalDegradedFiles: 0`
  // yet weakens overlay-dependent conclusions, so a "looks clean" block here would otherwise read a
  // reduced index as genuinely full.
  const memoryPressure = describeMemoryDegradation(phReport?.memoryDegradation);
  const parseHealth = phReport
    ? {
        totalDegradedFiles: phReport.totalDegradedFiles,
        byLanguage: compactParseHealthSummary(phReport),
        ...(phReport.grammarUnavailable?.length
          ? {
              grammarUnavailable: phReport.grammarUnavailable.map(boundary =>
                `${boundary.language} grammar unavailable — ${boundary.fileCount} file${boundary.fileCount === 1 ? '' : 's'} indexed for search but not graphed (${boundary.reason})`),
            }
          : {}),
        ...(memoryPressure ? { memoryPressure } : {}),
      }
    : undefined;

  return {
    mode: 'repo',
    detectedLanguages: detected,
    languages,
    capabilities: CAP_META,
    ...(parseHealth ? { parseHealth } : {}),
    summary,
    disclosure: DISCLOSURE,
  };
}

/** MCP dispatch entry. */
export async function handleGetLanguageSupport(input: GetLanguageSupportInput): Promise<unknown> {
  return computeGetLanguageSupport(input);
}
