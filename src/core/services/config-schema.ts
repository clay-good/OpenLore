/**
 * Deterministic schema validation for `.openlore/config.json`
 * (changes: add-config-schema-validation, fix-config-validation-completeness).
 *
 * `readOpenLoreConfig` parses the file with a bare `JSON.parse(...) as OpenLoreConfig`
 * — a type *assertion* checked by nothing at runtime. A typo'd key (`pancResponse`,
 * `embeding`) is silently dropped and the default wins, so the user believes a feature
 * is configured when it is not. This module closes that gap the way the rest of the
 * substrate already does (the decision store validates on load, the index attests
 * integrity): an allocation-light, dependency-free validator that recursively checks
 * every declared field. Unknown keys and version skew remain advisory; missing required
 * fields and known fields with unusable types are rejected at the read boundary before a
 * caller can dereference them.
 *
 * Two honesty invariants:
 *  - Forward-compatible: an unknown key (including one written by a *newer* OpenLore) is
 *    disclosed and then ignored, so a newer config under an older openlore degrades
 *    gracefully rather than crashing.
 *  - Bound to the type: {@link CONFIG_FIELD_KINDS} is `Record<keyof OpenLoreConfig, …>`,
 *    so adding a field to `OpenLoreConfig` without a validator entry fails the build; a
 *    completeness test names any residual drift.
 */

import type {
  AnalysisConfig,
  BlastRadiusConfig,
  BundleConfig,
  BundleTrustedSigner,
  CoveringSurfaceConfig,
  CoveringSurfaceMember,
  ContextInjectionConfig,
  EmbeddingConfig,
  EnforcementConfig,
  GenerationConfig,
  ImpactCertificateConfig,
  LLMConfig,
  OpenLoreConfig,
  PiConfig,
  RetrievalConfig,
  SpecStoreConfig,
  WorkspaceConfig,
  WorkspaceShardConfig,
} from '../../types/index.js';

/** The current config-schema version stamped into `.openlore/config.json`. */
export const CONFIG_SCHEMA_VERSION = '1.2.0';

/**
 * Top-level value shapes retained as the public compatibility map for callers and tests.
 * The recursive schema below refines object fields without changing this exported shape.
 */
export type ConfigFieldKind = 'string' | 'string-or-null' | 'object';

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K
}[keyof T];

type RequiredFieldMap<T> = Record<RequiredKeys<T>, true>
  & Partial<Record<Exclude<keyof T, RequiredKeys<T>>, never>>;

type ConfigRuleMetadata = {
  /** Missing values written by older releases may be copied from canonical defaults. */
  compatibilityDefault?: true;
};

type ConfigRule = ConfigRuleMetadata & (
  | { kind: 'string' | 'number' | 'boolean' | 'string-or-null' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array'; element: ConfigRule }
  | { kind: 'string-or-string-array' }
  | { kind: 'record-enum'; values: readonly string[] }
  | { kind: 'object'; fields: Record<string, ConfigRule>; required: readonly string[]; strict?: boolean }
);

function fieldsFor<T>(fields: Record<keyof T, ConfigRule>): Record<string, ConfigRule> {
  return fields as Record<string, ConfigRule>;
}

function requiredFor<T>(required: RequiredFieldMap<T>): readonly string[] {
  return Object.keys(required);
}

const stringRule: ConfigRule = { kind: 'string' };
const numberRule: ConfigRule = { kind: 'number' };
const booleanRule: ConfigRule = { kind: 'boolean' };
const stringArrayRule: ConfigRule = { kind: 'array', element: stringRule };

const analysisRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<AnalysisConfig>({
    maxFiles: numberRule,
    includePatterns: stringArrayRule,
    excludePatterns: stringArrayRule,
  }),
  required: requiredFor<AnalysisConfig>({ maxFiles: true, includePatterns: true, excludePatterns: true }),
};

const generationRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<GenerationConfig>({
    provider: { kind: 'enum', values: ['anthropic', 'openai', 'openai-compat', 'copilot', 'gemini', 'claude-code', 'codex-cli', 'mistral-vibe', 'gemini-cli', 'antigravity-cli', 'cursor-agent'] },
    model: stringRule,
    openaiCompatBaseUrl: stringRule,
    skipSslVerify: booleanRule,
    disableResponseFormat: booleanRule,
    timeout: numberRule,
    chunkMaxChars: numberRule,
    domains: { kind: 'string-or-string-array', compatibilityDefault: true },
  }),
  required: requiredFor<GenerationConfig>({ domains: true }),
};

const llmRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<LLMConfig>({ apiBase: stringRule, sslVerify: booleanRule }),
  required: requiredFor<LLMConfig>({}),
};

const embeddingRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<EmbeddingConfig>({
    provider: { kind: 'enum', values: ['remote', 'local'] },
    baseUrl: stringRule,
    model: stringRule,
    apiKey: stringRule,
    batchSize: numberRule,
    skipSslVerify: booleanRule,
  }),
  required: requiredFor<EmbeddingConfig>({}),
};

const retrievalRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<RetrievalConfig>({ vocabularyExpansion: booleanRule }),
  required: requiredFor<RetrievalConfig>({}),
};

const panicRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<NonNullable<OpenLoreConfig['panicResponse']>>({
    mode: { kind: 'enum', values: ['off', 'observe', 'advisory', 'experimental_blocking'] },
  }),
  required: requiredFor<NonNullable<OpenLoreConfig['panicResponse']>>({ mode: true }),
};

const blastRadiusRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<BlastRadiusConfig>({
    block: { kind: 'array', element: { kind: 'enum', values: ['orphans-anchored-memory', 'orphans-anchored-decision'] } },
  }),
  required: requiredFor<BlastRadiusConfig>({}),
};

const specStoreRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<SpecStoreConfig>({
    name: stringRule,
    path: stringRule,
    targets: stringArrayRule,
    references: stringArrayRule,
  }),
  required: requiredFor<SpecStoreConfig>({ name: true, path: true, targets: true }),
};

const governanceRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<NonNullable<OpenLoreConfig['governance']>>({ autopilot: booleanRule }),
  required: requiredFor<NonNullable<OpenLoreConfig['governance']>>({}),
};

const coveringMemberRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<CoveringSurfaceMember>({ symbol: stringRule, file: stringRule }),
  required: requiredFor<CoveringSurfaceMember>({}),
};

const coveringSurfaceRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<CoveringSurfaceConfig>({
    name: stringRule,
    members: { kind: 'array', element: coveringMemberRule },
    severity: { kind: 'enum', values: ['info', 'warn', 'critical'] },
  }),
  required: requiredFor<CoveringSurfaceConfig>({ name: true, members: true }),
};

const impactCertificateRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<ImpactCertificateConfig>({
    surfaces: { kind: 'array', element: coveringSurfaceRule },
    block: { kind: 'array', element: { kind: 'enum', values: ['info', 'warn', 'critical'] } },
  }),
  required: requiredFor<ImpactCertificateConfig>({}),
};

const contextInjectionRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<ContextInjectionConfig>({
    mode: { kind: 'enum', values: ['off', 'task-scoped'] },
    tokenBudget: numberRule,
    relevanceMinMatches: numberRule,
    relevanceMinFanIn: numberRule,
    relevanceMinScore: numberRule,
    intentGate: booleanRule,
  }),
  required: requiredFor<ContextInjectionConfig>({}),
};

const enforcementRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<EnforcementConfig>({
    policy: { kind: 'record-enum', values: ['blocking', 'frozen', 'advisory', 'off'] },
  }),
  required: requiredFor<EnforcementConfig>({}),
};

const secretRedactionRule: ConfigRule = {
  kind: 'object',
  fields: fieldsFor<NonNullable<OpenLoreConfig['secretRedaction']>>({ toolOutput: booleanRule }),
  required: requiredFor<NonNullable<OpenLoreConfig['secretRedaction']>>({}),
};

const bundleTrustedSignerRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<BundleTrustedSigner>({ publicKey: stringRule, label: stringRule }),
  required: requiredFor<BundleTrustedSigner>({ publicKey: true }),
};

const bundleRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<BundleConfig>({
    trustedSigners: { kind: 'array', element: bundleTrustedSignerRule },
  }),
  required: requiredFor<BundleConfig>({}),
};

const workspaceShardRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<WorkspaceShardConfig>({ name: stringRule, root: stringRule }),
  required: requiredFor<WorkspaceShardConfig>({ name: true, root: true }),
};

const workspaceRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<WorkspaceConfig>({
    shards: { kind: 'array', element: workspaceShardRule },
  }),
  required: requiredFor<WorkspaceConfig>({}),
};

const piRule: ConfigRule = {
  kind: 'object',
  strict: true,
  fields: fieldsFor<PiConfig>({ spawnDaemon: booleanRule }),
  required: requiredFor<PiConfig>({}),
};

const CONFIG_RULE: Extract<ConfigRule, { kind: 'object' }> = {
  kind: 'object',
  fields: fieldsFor<OpenLoreConfig>({
    version: stringRule,
    projectType: { kind: 'enum', values: ['nodejs', 'python', 'rust', 'go', 'java', 'ruby', 'php', 'unknown'] },
    openspecPath: stringRule,
    analysis: analysisRule,
    generation: generationRule,
    llm: llmRule,
    embedding: embeddingRule,
    retrieval: retrievalRule,
    panicResponse: panicRule,
    createdAt: stringRule,
    lastRun: { kind: 'string-or-null' },
    blastRadius: blastRadiusRule,
    specStore: specStoreRule,
    governance: governanceRule,
    impactCertificate: impactCertificateRule,
    contextInjection: contextInjectionRule,
    enforcement: enforcementRule,
    secretRedaction: secretRedactionRule,
    bundle: bundleRule,
    workspace: workspaceRule,
    pi: piRule,
  }),
  required: requiredFor<OpenLoreConfig>({
    version: true,
    projectType: true,
    openspecPath: true,
    analysis: true,
    generation: true,
    createdAt: true,
    lastRun: true,
  }),
};

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
  retrieval: 'object',
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
  bundle: 'object',
  workspace: 'object',
  pi: 'object',
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
  kind: 'unknown-key' | 'missing-required' | 'type-mismatch' | 'version-older' | 'version-newer' | 'default-added';
  /** The offending key, when the finding is about one. */
  key?: string;
  /** Human-readable message. */
  message: string;
  /** For unknown-key: the closest known key within the edit-distance bound, if any. */
  suggestion?: string;
  /** Whether returning the parsed object would expose an unsafe required runtime shape. */
  fatal?: boolean;
}

export interface ConfigCompatibilityResult {
  config: unknown;
  findings: ConfigValidationFinding[];
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Backfill only required fields explicitly marked as upgrade-safe. Nested sections
 * must already exist in the parsed config; marked top-level fields may be introduced.
 * This keeps malformed legacy-required structure fatal while allowing deliberate,
 * default-backed schema additions to remain backward compatible.
 */
export function backfillRequiredConfigDefaults(
  parsed: unknown,
  defaults: unknown,
): ConfigCompatibilityResult {
  if (!isConfigObject(parsed) || !isConfigObject(defaults)) {
    return { config: parsed, findings: [] };
  }

  const config = structuredClone(parsed) as Record<string, unknown>;
  const findings: ConfigValidationFinding[] = [];

  const visit = (
    target: Record<string, unknown>,
    fallback: Record<string, unknown>,
    rule: Extract<ConfigRule, { kind: 'object' }>,
    path: string,
  ): void => {
    for (const key of rule.required) {
      const childRule = rule.fields[key];
      if (childRule?.compatibilityDefault !== true) continue;
      if (!Object.prototype.hasOwnProperty.call(target, key)
        && Object.prototype.hasOwnProperty.call(fallback, key)) {
        const childPath = path ? `${path}.${key}` : key;
        target[key] = structuredClone(fallback[key]);
        findings.push({
          kind: 'default-added',
          key: childPath,
          fatal: false,
          message: `added missing config key '${childPath}' = ${JSON.stringify(fallback[key])} from the current default (file unchanged)`,
        });
      }
    }

    for (const [key, childRule] of Object.entries(rule.fields)) {
      if (childRule.kind !== 'object') continue;
      const childTarget = target[key];
      const childFallback = fallback[key];
      if (!isConfigObject(childTarget) || !isConfigObject(childFallback)) continue;
      visit(childTarget, childFallback, childRule, path ? `${path}.${key}` : key);
    }
  };

  visit(config, defaults, CONFIG_RULE, '');
  return { config, findings };
}

/**
 * Required fields missing from sections emitted by the canonical defaults. This is a
 * schema-evolution guard: adding a required field to a default section must update the
 * defaults in the same change, otherwise older configs cannot be backfilled safely.
 */
export function findRequiredFieldsWithoutDefaults(defaults: unknown): string[] {
  if (!isConfigObject(defaults)) return CONFIG_RULE.required.map(key => key);
  const missing: string[] = [];

  const visit = (
    fallback: Record<string, unknown>,
    rule: Extract<ConfigRule, { kind: 'object' }>,
    path: string,
  ): void => {
    for (const key of rule.required) {
      if (!Object.prototype.hasOwnProperty.call(fallback, key)) {
        missing.push(path ? `${path}.${key}` : key);
      }
    }
    for (const [key, childRule] of Object.entries(rule.fields)) {
      if (childRule.kind !== 'object') continue;
      const childFallback = fallback[key];
      if (!isConfigObject(childFallback)) continue;
      visit(childFallback, childRule, path ? `${path}.${key}` : key);
    }
  };

  visit(defaults, CONFIG_RULE, '');
  return missing;
}

/** Upgrade-safe fields whose canonical fallback is absent at the same schema path. */
export function findCompatibilityFieldsWithoutDefaults(defaults: unknown): string[] {
  const missing: string[] = [];

  const visit = (
    fallback: unknown,
    rule: Extract<ConfigRule, { kind: 'object' }>,
    path: string,
  ): void => {
    const fallbackRecord = isConfigObject(fallback) ? fallback : undefined;
    for (const [key, childRule] of Object.entries(rule.fields)) {
      const childPath = path ? `${path}.${key}` : key;
      if (childRule.compatibilityDefault === true
        && !Object.prototype.hasOwnProperty.call(fallbackRecord ?? {}, key)) {
        missing.push(childPath);
      }
      if (childRule.kind === 'object') {
        visit(fallbackRecord?.[key], childRule, childPath);
      }
    }
  };

  visit(defaults, CONFIG_RULE, '');
  return missing;
}

/** Findings that make the parsed object unsafe to expose as `OpenLoreConfig`. */
export function isFatalConfigFinding(finding: ConfigValidationFinding): boolean {
  return finding.fatal === true;
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
export function suggestKey(unknown: string, knownKeys: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = MAX_SUGGESTION_DISTANCE + 1;
  for (const known of knownKeys) {
    // A candidate farther away by length alone cannot fall within the bound.
    // Skip it before allocating the O(a*b) Levenshtein rows for hostile keys.
    if (Math.abs(unknown.length - known.length) > MAX_SUGGESTION_DISTANCE) continue;
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

function expectedDescription(rule: ConfigRule): string {
  switch (rule.kind) {
    case 'string': return 'a string';
    case 'number': return 'a number';
    case 'boolean': return 'a boolean';
    case 'string-or-null': return 'a string or null';
    case 'enum': return `one of ${rule.values.join(', ')}`;
    case 'array': return 'an array';
    case 'string-or-string-array': return 'a string or an array of strings';
    case 'record-enum': return `an object whose values are one of ${rule.values.join(', ')}`;
    case 'object': return 'an object';
  }
}

function typeFinding(path: string, rule: ConfigRule, value: unknown, fatal: boolean): ConfigValidationFinding {
  return {
    kind: 'type-mismatch',
    key: path,
    fatal,
    message: `config key '${path}' should be ${expectedDescription(rule)}, got ${actualKind(value)} — correct it or re-run 'openlore init'`,
  };
}

function validateRule(
  value: unknown,
  rule: ConfigRule,
  path: string,
  findings: { unknown: ConfigValidationFinding[]; missing: ConfigValidationFinding[]; mismatches: ConfigValidationFinding[] },
  fatal = false,
): void {
  if (rule.kind === 'string' || rule.kind === 'number' || rule.kind === 'boolean') {
    if (typeof value !== rule.kind) findings.mismatches.push(typeFinding(path, rule, value, fatal));
    return;
  }
  if (rule.kind === 'string-or-null') {
    if (value !== null && typeof value !== 'string') findings.mismatches.push(typeFinding(path, rule, value, fatal));
    return;
  }
  if (rule.kind === 'enum') {
    if (typeof value !== 'string' || !rule.values.includes(value)) findings.mismatches.push(typeFinding(path, rule, value, fatal));
    return;
  }
  if (rule.kind === 'string-or-string-array') {
    if (typeof value === 'string') return;
    if (!Array.isArray(value)) {
      findings.mismatches.push(typeFinding(path, rule, value, fatal));
      return;
    }
    value.forEach((item, index) => {
      if (typeof item !== 'string') findings.mismatches.push(typeFinding(`${path}[${index}]`, stringRule, item, fatal));
    });
    return;
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(value)) {
      findings.mismatches.push(typeFinding(path, rule, value, fatal));
      return;
    }
    value.forEach((item, index) => validateRule(item, rule.element, `${path}[${index}]`, findings, fatal));
    return;
  }
  if (rule.kind === 'record-enum') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      findings.mismatches.push(typeFinding(path, rule, value, fatal));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string' || !rule.values.includes(item)) {
        findings.mismatches.push(typeFinding(`${path}.${key}`, { kind: 'enum', values: rule.values }, item, fatal));
      }
    }
    return;
  }

  if (rule.kind !== 'object') return;

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    findings.mismatches.push(typeFinding(path || '<root>', rule, value, fatal));
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const childRule = rule.fields[key];
    const childPath = path ? `${path}.${key}` : key;
    if (!childRule) {
      const suggestion = suggestKey(key, Object.keys(rule.fields));
      findings.unknown.push({
        kind: 'unknown-key',
        key: childPath,
        fatal: false,
        suggestion,
        message: suggestion
          ? `unknown config key '${childPath}' — did you mean '${path ? `${path}.` : ''}${suggestion}'? (ignored)`
          : `unknown config key '${childPath}' — possibly from a newer OpenLore (ignored)`,
      });
      continue;
    }
    const childFatal = rule.strict === true || (path === '' && rule.required.includes(key));
    validateRule(obj[key], childRule, childPath, findings, childFatal);
  }
  for (const key of rule.required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      const childPath = path ? `${path}.${key}` : key;
      findings.missing.push({
        kind: 'missing-required',
        key: childPath,
        fatal: rule.strict === true || path === '',
        message: `required config key '${childPath}' is missing — restore it or re-run 'openlore init'`,
      });
    }
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
 * deterministic: returns findings ordered as unknown keys, missing required fields,
 * type mismatches, then version skew. Never throws or mutates; the config read boundary
 * decides which findings are fatal.
 */
export function validateOpenLoreConfig(
  parsed: unknown,
  opts: { current?: string; migrations?: readonly ConfigMigration[] } = {}
): ConfigValidationFinding[] {
  const findings = {
    unknown: [] as ConfigValidationFinding[],
    missing: [] as ConfigValidationFinding[],
    mismatches: [] as ConfigValidationFinding[],
  };
  validateRule(parsed, CONFIG_RULE, '', findings, true);
  if (isConfigObject(parsed)) {
    const workspace = parsed.workspace;
    const shards = isConfigObject(workspace) && Array.isArray(workspace.shards)
      ? workspace.shards
      : null;
    if (shards) {
      const names = new Set<string>();
      const roots = new Set<string>();
      if (shards.length > 5_000) {
        findings.mismatches.push({
          kind: 'type-mismatch', key: 'workspace.shards', fatal: true,
          message: "config key 'workspace.shards' supports at most 5,000 entries — reduce the configured shard set",
        });
      }
      shards.forEach((value, index) => {
        if (!isConfigObject(value) || typeof value.name !== 'string' || typeof value.root !== 'string') return;
        const nameHasControl = [...value.name].some(char => {
          const code = char.codePointAt(0) ?? 0;
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        });
        const rootHasControl = [...value.root].some(char => {
          const code = char.codePointAt(0) ?? 0;
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        });
        const name = value.name.trim();
        const root = value.root.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
        if (!name || name === 'root' || nameHasControl || Buffer.byteLength(name, 'utf8') > 256 || names.has(name)) {
          findings.mismatches.push({
            kind: 'type-mismatch', key: `workspace.shards[${index}].name`, fatal: true,
            message: `config key 'workspace.shards[${index}].name' must be unique, non-empty, at most 256 characters, and not reserved name 'root'`,
          });
        }
        const absolute = root.startsWith('/') || /^[A-Za-z]:\//.test(root) || root.startsWith('//');
        if (!root || absolute || rootHasControl || Buffer.byteLength(root, 'utf8') > 1_024 || roots.has(root)) {
          findings.mismatches.push({
            kind: 'type-mismatch', key: `workspace.shards[${index}].root`, fatal: true,
            message: `config key 'workspace.shards[${index}].root' must be repository-relative, unique, non-empty, and at most 1,024 UTF-8 bytes`,
          });
        }
        names.add(name);
        roots.add(root);
      });
    }
  }
  const versionFindings = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? checkConfigVersion((parsed as Record<string, unknown>).version, opts)
    : [];
  return [...findings.unknown, ...findings.missing, ...findings.mismatches, ...versionFindings];
}
