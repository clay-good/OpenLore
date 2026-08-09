/**
 * Deterministic schema validation for `.openlore/config.json`
 * (change: add-config-schema-validation).
 *
 * `readOpenLoreConfig` parses the file with a bare `JSON.parse(...) as OpenLoreConfig`
 * — a type *assertion* checked by nothing at runtime. A typo'd key (`pancResponse`,
 * `embeding`) is silently dropped and the default wins, so the user believes a feature
 * is configured when it is not. This module closes that gap the way the rest of the
 * substrate already does (the decision store validates on load, the index attests
 * integrity): a shallow, allocation-light, dependency-free validator that DISCLOSES
 * unknown keys, type mismatches, and version skew — never a hard failure, and never a
 * behavior change for a currently-valid config.
 *
 * Two honesty invariants:
 *  - Forward-compatible: an unknown key (including one written by a *newer* OpenLore) is
 *    disclosed and then ignored, so a newer config under an older openlore degrades
 *    gracefully rather than crashing.
 *  - Bound to the type: {@link CONFIG_FIELD_KINDS} is `Record<keyof OpenLoreConfig, …>`,
 *    so adding a field to `OpenLoreConfig` without a validator entry fails the build; a
 *    completeness test names any residual drift.
 */

import type { OpenLoreConfig } from '../../types/index.js';

/** The current config-schema version stamped into `.openlore/config.json`. */
export const CONFIG_SCHEMA_VERSION = '1.0.0';

/**
 * Top-level value shapes the validator checks. Deliberately shallow — validation runs
 * on every read of a ~45-caller hub, so it stays allocation-light and does not recurse
 * into nested objects (a mistyped nested field is out of scope, disclosed as such).
 */
export type ConfigFieldKind = 'string' | 'string-or-null' | 'object';

/**
 * The known keys of `OpenLoreConfig` and the shape each holds. Typed as
 * `Record<keyof OpenLoreConfig, …>` so a field added to the interface without an entry
 * here fails `tsc` (and CI); {@link config-schema.test.ts} binds it at runtime too.
 */
export const CONFIG_FIELD_KINDS: Record<keyof OpenLoreConfig, ConfigFieldKind> = {
  version: 'string',
  projectType: 'string',
  openspecPath: 'string',
  analysis: 'object',
  generation: 'object',
  llm: 'object',
  embedding: 'object',
  panicResponse: 'object',
  createdAt: 'string',
  lastRun: 'string-or-null',
  blastRadius: 'object',
  specStore: 'object',
  governance: 'object',
  impactCertificate: 'object',
  contextInjection: 'object',
  enforcement: 'object',
  secretRedaction: 'object',
};

/** The known top-level config keys, derived from the type-bound field map. */
export const KNOWN_CONFIG_KEYS: readonly string[] = Object.keys(CONFIG_FIELD_KINDS);

/**
 * A registered non-additive config-schema change: reading a config stamped *before*
 * `since` should disclose that `fields` need attention (rename/removal). Empty today —
 * the schema has only ever grown with optional, forward- and backward-compatible fields,
 * so no older config is misread. An entry is added here (and {@link CONFIG_SCHEMA_VERSION}
 * bumped) only when a breaking shape change lands.
 */
export interface ConfigMigration {
  /** The version at which the breaking change landed (semver). */
  since: string;
  /** The affected fields, for the recovery message. */
  fields: string[];
  /** Human recovery guidance. */
  note: string;
}

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [];

/** A single deterministic finding from validating a config object. */
export interface ConfigValidationFinding {
  kind: 'unknown-key' | 'type-mismatch' | 'version-older' | 'version-newer';
  /** The offending key, when the finding is about one. */
  key?: string;
  /** Human-readable message. */
  message: string;
  /** For unknown-key: the closest known key within the edit-distance bound, if any. */
  suggestion?: string;
}

/**
 * The maximum edit distance for a did-you-mean suggestion. Fixed, deterministic, and
 * small so a suggestion is only offered for a plausible typo (`pancResponse` →
 * `panicResponse` is distance 1) — not for an arbitrary unrelated key.
 */
const MAX_SUGGESTION_DISTANCE = 2;

/** Iterative Levenshtein distance. Dependency-free; O(a·b) on short config keys. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * The closest known key to `unknown` within {@link MAX_SUGGESTION_DISTANCE}, or undefined.
 * Ties broken alphabetically so the suggestion is deterministic.
 */
function suggestKnownKey(unknown: string): string | undefined {
  let best: string | undefined;
  let bestDist = MAX_SUGGESTION_DISTANCE + 1;
  for (const known of KNOWN_CONFIG_KEYS) {
    const d = editDistance(unknown, known);
    if (d < bestDist || (d === bestDist && best !== undefined && known < best)) {
      bestDist = d;
      best = known;
    }
  }
  return bestDist <= MAX_SUGGESTION_DISTANCE ? best : undefined;
}

function actualKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function kindMatches(kind: ConfigFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'string-or-null':
      return value === null || typeof value === 'string';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

/** Parse a `a.b.c` semver into a numeric tuple, or null when it isn't one. */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 | 0 | 1 comparing two semver tuples. */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Check the `version` stamp against the running schema version. A newer stamp is
 * disclosed (unknown content is handled by the unknown-key path); an older stamp is
 * reported only when a registered {@link ConfigMigration} affects the (stamp, current]
 * range — a purely additive gap stays silent because the config is still forward- and
 * backward-compatible. Never a hard failure. Exported so the pure version logic is
 * testable with an injected current version / migration set.
 */
export function checkConfigVersion(
  stamp: unknown,
  opts: { current?: string; migrations?: readonly ConfigMigration[] } = {}
): ConfigValidationFinding[] {
  const current = opts.current ?? CONFIG_SCHEMA_VERSION;
  const migrations = opts.migrations ?? CONFIG_MIGRATIONS;
  if (typeof stamp !== 'string') return []; // handled by the type-mismatch path
  const parsed = parseSemver(stamp);
  const currentParsed = parseSemver(current);
  if (!parsed || !currentParsed) return [];
  const cmp = compareSemver(parsed, currentParsed);
  if (cmp > 0) {
    return [
      {
        kind: 'version-newer',
        message: `config version ${stamp} is newer than this OpenLore knows (${current}); unknown settings are disclosed and ignored`,
      },
    ];
  }
  if (cmp < 0) {
    const affected = migrations.filter(mig => {
      const migParsed = parseSemver(mig.since);
      return migParsed && compareSemver(parsed, migParsed) < 0 && compareSemver(migParsed, currentParsed) <= 0;
    });
    if (affected.length === 0) return []; // additive-only gap — forward compatible, silent
    const fields = [...new Set(affected.flatMap(m => m.fields))].join(', ');
    const notes = affected.map(m => m.note).join('; ');
    return [
      {
        kind: 'version-older',
        message: `config was written by an older OpenLore (v${stamp}); ${fields ? `fields changed: ${fields}. ` : ''}${notes} — update it or re-run 'openlore init'`,
      },
    ];
  }
  return [];
}

/**
 * Validate a parsed config object against the type-derived schema. Pure and
 * deterministic: returns findings ordered as unknown-keys (in file order), then
 * type-mismatches, then version skew. Never throws, never mutates, never a hard failure.
 * A non-object input yields no findings (the JSON parse already reported a syntax error).
 */
export function validateOpenLoreConfig(
  parsed: unknown,
  opts: { current?: string; migrations?: readonly ConfigMigration[] } = {}
): ConfigValidationFinding[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const findings: ConfigValidationFinding[] = [];

  const unknownKeys: ConfigValidationFinding[] = [];
  const mismatches: ConfigValidationFinding[] = [];
  for (const key of Object.keys(obj)) {
    const kind = CONFIG_FIELD_KINDS[key as keyof OpenLoreConfig];
    if (kind === undefined) {
      const suggestion = suggestKnownKey(key);
      unknownKeys.push({
        kind: 'unknown-key',
        key,
        suggestion,
        message: suggestion
          ? `unknown config key '${key}' — did you mean '${suggestion}'? (ignored)`
          : `unknown config key '${key}' — possibly from a newer OpenLore (ignored)`,
      });
      continue;
    }
    if (!kindMatches(kind, obj[key])) {
      mismatches.push({
        kind: 'type-mismatch',
        key,
        message: `config key '${key}' should be ${kind === 'object' ? 'an object' : kind === 'string-or-null' ? 'a string or null' : 'a string'}, got ${actualKind(obj[key])}`,
      });
    }
  }

  findings.push(...unknownKeys, ...mismatches);
  findings.push(...checkConfigVersion(obj.version, opts));
  return findings;
}
