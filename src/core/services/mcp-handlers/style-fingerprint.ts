/**
 * `get_style_fingerprint` MCP handler (change: add-codebase-style-fingerprint).
 *
 * Returns the DESCRIPTIVE, deterministic idiom profile computed during analysis (see
 * `src/core/analyzer/style-fingerprint.ts`) as a CONCLUSION — the measured idiom set with sample
 * sizes and honest null signals — never a graph or a source dump. Repository profile by default; a
 * named community/region, or a single file, on request.
 *
 * It does NOT re-parse or re-derive: it reads the persisted `style-fingerprint.json`. So the answer
 * is exactly what the analyzer measured, byte-for-byte, and stays cheap.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validateDirectory } from './utils.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_STYLE_FINGERPRINT } from '../../../constants.js';
import {
  fileProfile,
  STYLE_SCHEMA_VERSION,
  type StyleFingerprint,
  type LanguageProfile,
} from '../../analyzer/style-fingerprint.js';

export interface GetStyleFingerprintInput {
  directory: string;
  /** Profile for one community/region id (from `get_map`). */
  communityId?: string;
  /**
   * Profile for a single file (exact path or unique path suffix). Most specific scope: when both
   * `filePath` and `communityId` are supplied, `filePath` wins.
   */
  filePath?: string;
  /** Restrict the returned languages to this one (canonical name, e.g. "TypeScript"). */
  language?: string;
}

const DESCRIPTIVE_NOTE =
  'Descriptive, not prescriptive: these are MEASURED idiom frequencies (what the code is), not a ' +
  'style rule. Ratios carry sample sizes; an idiom below the evidence floor or enforced by the ' +
  'language/formatter reports a null signal rather than a misleading or tautological ratio.';

/**
 * Read the persisted fingerprint, fail-soft (null when absent/unreadable/wrong shape). The shape
 * check validates EVERY field the handler later dereferences — `byLanguage`/`files`/`regions`
 * (arrays) and `fileRegions` (object) — so a truncated or stale partial artifact degrades to the
 * graceful "run analyze" guidance rather than throwing a raw TypeError downstream.
 */
function isWellFormed(fp: unknown): fp is StyleFingerprint {
  if (!fp || typeof fp !== 'object') return false;
  const o = fp as Record<string, unknown>;
  // Reject an artifact from a future, incompatible schema rather than silently mis-reading it
  // (a same-shape v2 with different inner semantics would otherwise slip past the structural
  // checks). An absent version is treated as the current schema for backward tolerance.
  if (o.schemaVersion !== undefined && o.schemaVersion !== STYLE_SCHEMA_VERSION) return false;
  return (
    Array.isArray(o.byLanguage) &&
    Array.isArray(o.files) &&
    Array.isArray(o.regions) &&
    typeof o.fileRegions === 'object' && o.fileRegions !== null && !Array.isArray(o.fileRegions)
  );
}

async function readStyleFingerprint(absDir: string): Promise<StyleFingerprint | null> {
  try {
    const path = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_STYLE_FINGERPRINT);
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
    return isWellFormed(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function filterByLanguage(profiles: LanguageProfile[], language?: string): LanguageProfile[] {
  if (!language) return profiles;
  const want = language.trim().toLowerCase();
  return profiles.filter(p => p.language.toLowerCase() === want);
}

/**
 * Resolve a file profile. `filePath` may be an exact key or a unique suffix (so an agent can pass
 * a repo-relative path even if the index keys differ slightly). An ambiguous suffix is reported.
 */
function resolveFileProfile(fp: StyleFingerprint, filePath: string): unknown {
  const exact = fp.files.find(f => f.filePath === filePath);
  const matches = exact ? [exact] : fp.files.filter(f => f.filePath.endsWith(filePath));
  if (matches.length === 0) {
    return { error: `No style fingerprint for a file matching "${filePath}". It may be an unsupported language or below the evidence floor.` };
  }
  if (matches.length > 1) {
    return {
      error: `"${filePath}" is ambiguous — matches ${matches.length} files.`,
      candidates: matches.slice(0, 10).map(f => f.filePath),
    };
  }
  const raw = matches[0];
  return {
    scope: 'file',
    filePath: raw.filePath,
    region: fp.fileRegions[raw.filePath],
    evidenceFloor: fp.evidenceFloor,
    profile: fileProfile(raw, fp.evidenceFloor),
    note: DESCRIPTIVE_NOTE,
  };
}

/**
 * Return the measured idiom profile. Read-only, deterministic, offline. Conclusion-shaped
 * (`unknown` by additive cast), never a node-and-edge graph.
 */
export async function handleGetStyleFingerprint(input: GetStyleFingerprintInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const fp = await readStyleFingerprint(absDir);
  if (!fp) {
    return {
      error:
        'No style fingerprint found. Run `openlore analyze` first. (A fingerprint is produced only ' +
        'for supported languages: TypeScript, JavaScript, Python, Go.)',
    };
  }

  // Single file.
  if (input.filePath) return resolveFileProfile(fp, input.filePath);

  // A community/region.
  if (input.communityId) {
    const region = fp.regions.find(r => r.communityId === input.communityId);
    if (!region) {
      return {
        error: `No region "${input.communityId}". Use get_map to list community ids; a region appears only when its files have a supported language.`,
        availableRegions: fp.regions.slice(0, 25).map(r => ({ communityId: r.communityId, label: r.label })),
      };
    }
    return {
      scope: 'region',
      communityId: region.communityId,
      label: region.label,
      evidenceFloor: fp.evidenceFloor,
      byLanguage: filterByLanguage(region.byLanguage, input.language),
      note: DESCRIPTIVE_NOTE,
    };
  }

  // Default: the whole repository, sliced per language.
  return {
    scope: 'repository',
    evidenceFloor: fp.evidenceFloor,
    languagesAnalyzed: fp.generatedLanguages,
    byLanguage: filterByLanguage(fp.byLanguage, input.language),
    regionCount: fp.regions.length,
    note: DESCRIPTIVE_NOTE,
  };
}
