/**
 * Declarative language-support registry (change: add-declarative-language-support-registry).
 *
 * Consolidates the per-language capability knowledge OpenLore already encodes — scattered
 * across the call-graph extractor, the CFG `SPECS` table, the signature extractor, the
 * type-inference engine, and the IaC projector — behind one declarative, queryable
 * registry, and makes per-language coverage an observable fact.
 *
 * Faithfulness is the whole point: an over-claimed coverage matrix is worse than none. So
 * this registry is DERIVED, not hand-listed — each capability flag is computed from the
 * SAME authoritative structure the corresponding extractor consults at run time:
 *   - `signatures`     ← {@link SIGNATURE_LANGUAGES}        (signature-extractor.ts)
 *   - `callGraph`      ← {@link CALLGRAPH_LANGUAGES}        (call-graph.ts)
 *   - `imports`        ← {@link IMPORT_RESOLUTION_LANGUAGES} (import-resolver-bridge.ts)
 *   - `cfgOverlay`     ← {@link cfgSupportsLanguage}        (cfg.ts)
 *   - `typeInference`  ← {@link TYPE_INFERENCE_LANGUAGES}   (type-inference-engine.ts)
 *   - `iacProjection`  ← {@link isIacLanguage}              (iac/types.ts)
 *   - `styleFingerprint`← {@link STYLE_FINGERPRINT_LANGUAGES} (style-fingerprint.ts)
 * A behavioral test (`language-support.test.ts`) cross-checks each flag against the live
 * extractor on a fixture, so the registry cannot silently drift from reality.
 *
 * Fail-soft is a uniform contract: a language with no record — or a record that does not
 * back a capability — yields nothing for that capability, never an error or a guess. This
 * change does NOT alter extraction output for any language; it only organizes and exposes
 * support that already exists.
 *
 * Deterministic, no LLM, no graph-schema change.
 */

import { cfgSupportsLanguage } from './cfg.js';
import { isIacLanguage, IAC_LANGUAGES } from './iac/types.js';
import { CALLGRAPH_LANGUAGES } from './call-graph.js';
import { SIGNATURE_LANGUAGES } from './signature-extractor.js';
import { TYPE_INFERENCE_LANGUAGES } from './type-inference-engine.js';
import { IMPORT_RESOLUTION_LANGUAGES } from './import-resolver-bridge.js';
import { STYLE_FINGERPRINT_LANGUAGES } from './style-fingerprint.js';
import { CROSS_SERVICE_HTTP_LANGUAGES } from './http-capability.js';
import { ERROR_PROPAGATION_LANGUAGES } from './exception-flow.js';

/** The closed set of capabilities the registry tracks, in deterministic column order. */
export const CAPABILITIES = [
  'signatures',
  'callGraph',
  'imports',
  'cfgOverlay',
  'typeInference',
  'styleFingerprint',
  'iacProjection',
  'crossServiceHttp',
  'errorPropagation',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Human-readable, agent-facing description of what each capability means. */
export const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  signatures: 'A dedicated signature extractor (parameters, return shape) rather than the best-effort generic fallback.',
  callGraph: 'Function/method node + call-edge extraction (the substrate every reachability conclusion rests on).',
  imports: 'Relative-import resolution into the `import`-confidence cross-file edge path (raises call-resolution recall).',
  cfgOverlay: 'A control-flow-graph overlay (branches/loops) via the data-driven CFG SPECS table.',
  typeInference: 'Lightweight receiver-type inference, used to resolve method calls to their class.',
  styleFingerprint: 'Descriptive idiom fingerprint (function form, binding, naming case, …) with an evidence floor + enforcement-awareness.',
  iacProjection: 'Infrastructure-as-code projection (resources/edges) onto the unified graph.',
  crossServiceHttp: 'Cross-service API topology: outbound HTTP client call sites and/or server route registrations matched into `http_endpoint` edges across the process (and, under federation, the repo) boundary.',
  errorPropagation: 'Exception escape/handled analysis (`analyze_error_propagation`): static throw/raise + typed/untyped catch extraction, so the exceptions that escape a function vs. those caught within it can be computed.',
};

/**
 * General-purpose code languages — `detectLanguage`'s outputs excluding the `unknown`
 * fallback. (Terraform and Bicep are extension-detected too, so they live here.) A
 * completeness test asserts `detectLanguage` maps a representative extension to each.
 */
export const CODE_LANGUAGES: readonly string[] = [
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Ruby', 'Java', 'Kotlin', 'PHP',
  'C#', 'C++', 'C', 'Swift', 'Scala', 'Dart', 'Lua', 'Elixir', 'Bash', 'Terraform', 'Bicep',
];

/**
 * IaC ecosystem tags a node can carry that are NOT extension-detected code languages —
 * derived from the IaC projector's authoritative {@link IAC_LANGUAGES} so it can't drift.
 * These include Pulumi/CDK/CDKTF: although they ride on general-purpose host files, the
 * IaC projector tags the resource nodes it derives with the ecosystem name, so a node CAN
 * have these languages (confirmed by dogfooding) and the registry must represent them
 * (their only backed capability is `iacProjection`).
 */
export const IAC_TAG_LANGUAGES: readonly string[] = IAC_LANGUAGES.filter(
  l => !CODE_LANGUAGES.includes(l),
);

/** Every language a node can be tagged with — the registry's complete key universe (sorted). */
export const ALL_LANGUAGES: readonly string[] = [...CODE_LANGUAGES, ...IAC_TAG_LANGUAGES]
  .slice()
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** One language's declarative support record: the capabilities it backs. */
export interface LanguageSupportRecord {
  language: string;
  /** Supported capabilities, in {@link CAPABILITIES} order. */
  capabilities: Capability[];
  /** Whether the language is even a known registry key (false → fail-soft "nothing claimed"). */
  known: boolean;
}

/** Derive the live capability set for a language from the authoritative source structures. */
function deriveCapabilities(language: string): Capability[] {
  const out: Capability[] = [];
  if (SIGNATURE_LANGUAGES.has(language)) out.push('signatures');
  if (CALLGRAPH_LANGUAGES.has(language)) out.push('callGraph');
  if (IMPORT_RESOLUTION_LANGUAGES.has(language)) out.push('imports');
  if (cfgSupportsLanguage(language)) out.push('cfgOverlay');
  if (TYPE_INFERENCE_LANGUAGES.has(language)) out.push('typeInference');
  if (STYLE_FINGERPRINT_LANGUAGES.has(language)) out.push('styleFingerprint');
  if (isIacLanguage(language)) out.push('iacProjection');
  if (CROSS_SERVICE_HTTP_LANGUAGES.has(language)) out.push('crossServiceHttp');
  if (ERROR_PROPAGATION_LANGUAGES.has(language)) out.push('errorPropagation');
  // Return in canonical CAPABILITIES order for determinism.
  return CAPABILITIES.filter(c => out.includes(c));
}

/**
 * The declarative registry: language → its derived support record, for every known
 * language. Computed once from the authoritative capability sources — never hand-listed,
 * so it cannot drift from what the extractors actually do.
 */
export const LANGUAGE_SUPPORT: ReadonlyMap<string, LanguageSupportRecord> = new Map(
  ALL_LANGUAGES.map(language => [language, { language, capabilities: deriveCapabilities(language), known: true }]),
);

/**
 * The support record for a language, fail-soft: an unknown language (no record) yields a
 * record with NO capabilities and `known: false` — never an error, never a guess. This is
 * the uniform fail-soft contract: ask about Haskell and you get an honest "nothing
 * claimed", not a crash and not a fabricated capability.
 */
export function languageSupport(language: string): LanguageSupportRecord {
  return LANGUAGE_SUPPORT.get(language) ?? { language, capabilities: [], known: false };
}

/** Lower-cased canonical-name index, for case-insensitive lookup. */
const CANONICAL_BY_LOWER = new Map(ALL_LANGUAGES.map(l => [l.toLowerCase(), l]));

/**
 * Resolve a free-form language string to its canonical registry name, case-insensitively
 * and trimming surrounding whitespace (so `"go"`, `"GO"`, `" Go "` all resolve to `"Go"`).
 * Returns `null` when no known language matches — the caller decides the fail-soft response.
 * This keeps the named-language lookup from being a casing foot-gun for agents while still
 * being honest about genuinely-unknown languages.
 */
export function resolveLanguageName(input: string): string | null {
  return CANONICAL_BY_LOWER.get(input.trim().toLowerCase()) ?? null;
}

/** A single cell-resolved coverage matrix: deterministic language × capability booleans. */
export interface CoverageMatrix {
  /** Column order (== {@link CAPABILITIES}). */
  capabilities: Capability[];
  rows: Array<{
    language: string;
    known: boolean;
    /** capability → supported, for every capability in `capabilities`. */
    supported: Record<Capability, boolean>;
    supportedCount: number;
  }>;
}

/**
 * The coverage matrix (language × capability). With NO argument (`undefined`), every known
 * language; with a language list (e.g. a repo's detected languages), exactly those — an
 * unknown language yields an all-`false` row (fail-soft, labeled `known: false`). An EMPTY
 * list (`[]`) yields NO rows — distinct from `undefined`, so a repo with zero detected
 * languages does not silently expand to the whole registry (that bug let a docs-only repo
 * report every language as present). Deterministic: languages are sorted and capabilities
 * are in fixed order, so two derivations are byte-identical.
 */
export function languageCoverageMatrix(languages?: readonly string[]): CoverageMatrix {
  const keys = (languages === undefined
    ? [...ALL_LANGUAGES]
    : [...new Set(languages)]
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const rows = keys.map(language => {
    const rec = languageSupport(language);
    const supported = Object.fromEntries(
      CAPABILITIES.map(c => [c, rec.capabilities.includes(c)]),
    ) as Record<Capability, boolean>;
    return { language, known: rec.known, supported, supportedCount: rec.capabilities.length };
  });

  return { capabilities: [...CAPABILITIES], rows };
}

/** Render the coverage matrix as a deterministic Markdown table (for the analysis digest). */
export function renderCoverageMatrixMarkdown(matrix: CoverageMatrix): string[] {
  const header = `| Language | ${matrix.capabilities.join(' | ')} |`;
  const sep = `|${'---|'.repeat(matrix.capabilities.length + 1)}`;
  const lines = [header, sep];
  for (const row of matrix.rows) {
    const cells = matrix.capabilities.map(c => (row.supported[c] ? '✓' : '·'));
    lines.push(`| ${row.language} | ${cells.join(' | ')} |`);
  }
  return lines;
}
