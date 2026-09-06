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
 *   - `testDetection`  ← {@link TEST_DETECTION_DECISIONS}   (test-file.ts)
 *   - `complexity`     ← {@link COMPLEXITY_LANGUAGES}       (call-graph-complexity.ts)
 *   - `imports`        ← {@link IMPORT_RESOLUTION_LANGUAGES} (import-resolver-bridge.ts)
 *   - `cfgOverlay`     ← {@link cfgSupportsLanguage}        (cfg.ts)
 *   - `typeInference`  ← {@link TYPE_INFERENCE_LANGUAGES}   (type-inference-engine.ts)
 *   - `iacProjection`  ← {@link isIacLanguage}              (iac/types.ts)
 *   - `styleFingerprint`← {@link STYLE_FINGERPRINT_LANGUAGES} (style-fingerprint.ts)
 *   - `dynamicBoundary`← {@link supportsDynamicBoundary}    (dynamic-boundary.ts)
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
import { supportsDynamicBoundary } from './dynamic-boundary.js';
import { CROSS_SERVICE_HTTP_LANGUAGES } from './http-capability.js';
import { ERROR_PROPAGATION_LANGUAGES } from './exception-flow.js';
import { RECEIVER_REGISTRY_LANGUAGES } from './receiver-registry.js';
import { TEST_DETECTION_DECISIONS } from './test-file.js';
import { COMPLEXITY_LANGUAGES } from './call-graph-complexity.js';
import {
  SCRIPT_CONTAINER_LIMITATIONS,
} from './sfc-script-extractor.js';
import {
  detectLanguage as detectCanonicalLanguage,
  SCRIPT_CONTAINER_FORMATS,
} from './language-detection.js';

/** The closed set of capabilities the registry tracks, in deterministic column order. */
export const CAPABILITIES = [
  'signatures',
  'callGraph',
  'testDetection',
  'complexity',
  'imports',
  'cfgOverlay',
  'typeInference',
  'receiverResolution',
  'styleFingerprint',
  'iacProjection',
  'crossServiceHttp',
  'errorPropagation',
  'dynamicBoundary',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Human-readable, agent-facing description of what each capability means. */
export const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
  signatures: 'A dedicated signature extractor (parameters, return shape) rather than the best-effort generic fallback.',
  callGraph: 'Function/method node + call-edge extraction (the substrate every reachability conclusion rests on).',
  testDetection: 'Path-based conventional test-file detection used for isTest nodes, tested_by edges, test selection, and coverage conclusions.',
  complexity: 'Grammar-shaped lexical estimation of per-function cyclomatic complexity for triage and ranking.',
  imports: 'Relative-import resolution into the `import`-confidence cross-file edge path (raises call-resolution recall).',
  cfgOverlay: 'A control-flow-graph overlay (branches/loops) via the data-driven CFG SPECS table.',
  typeInference: 'Lightweight receiver-type inference, used to resolve method calls to their class.',
  receiverResolution: 'Chained intra-object receiver resolution (`this.<field>.m()` / `self.<field>.m()`) through a per-file registry of declared field and return types, with the residue disclosed as a boundary rather than left silent. A language WITHOUT this does NOT bind that call shape; what it does instead varies by that language\'s own call query — Java, C# and Ruby capture the chained receiver and fall through to their ordinary member-call handling, while Go captures no chained receiver at all and so records nothing for it.',
  styleFingerprint: 'Descriptive idiom fingerprint (function form, binding, naming case, …) with an evidence floor + enforcement-awareness.',
  iacProjection: 'Infrastructure-as-code projection (resources/edges) onto the unified graph.',
  crossServiceHttp: 'Cross-service API topology: outbound HTTP client call sites and/or server route registrations matched into `http_endpoint` edges across the process (and, under federation, the repo) boundary.',
  errorPropagation: 'Error-flow analysis (`analyze_error_propagation`): exception escape/handler extraction for TS/JS/Python/Java/C#, plus Go returned-error and panic/recover value flow.',
  dynamicBoundary: 'Dynamic-boundary site recording: reflective invocation, computed-member dispatch, `eval`, dynamic import, metaprogrammed definition and DI-container resolution are recorded as disclosed boundaries. A language WITHOUT this reports no site because none is looked for — never because it contains no dynamic dispatch.',
};

/**
 * General-purpose code languages — `detectLanguage`'s outputs excluding the `unknown`
 * fallback. (Terraform and Bicep are extension-detected too, so they live here.) A
 * completeness test asserts `detectLanguage` maps a representative extension to each.
 */
export const CODE_LANGUAGES: readonly string[] = [
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Ruby', 'Java', 'Kotlin', 'PHP',
  'C#', 'C++', 'C', 'Swift', 'Scala', 'Dart', 'Lua', 'Elixir', 'Bash', 'Terraform', 'Bicep',
  ...SCRIPT_CONTAINER_FORMATS,
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

// The single canonical extension→language detector lives in the dependency-free
// `language-detection.ts` leaf (change: fix-language-detection-single-source) so the
// signature extractor and this registry can both import it without a module cycle — this
// registry derives its capability matrix eagerly from the extractor's SIGNATURE_LANGUAGES,
// so the extractor cannot import the registry back. The registry re-exports it as the
// public detection surface; every consumer resolves through this one definition.
export { detectLanguage, EXTENSION_TO_LANGUAGE } from './language-detection.js';

/** One language's declarative support record: the capabilities it backs. */
export interface LanguageSupportRecord {
  language: string;
  /** Supported capabilities, in {@link CAPABILITIES} order. */
  capabilities: Capability[];
  /** Whether the language is even a known registry key (false → fail-soft "nothing claimed"). */
  known: boolean;
  /** Script-container extraction scope, present only for Vue/Svelte/Astro. */
  container?: {
    recognized: true;
    extraction: 'script-blocks';
    /** Capabilities backed inside extracted JS/TS script blocks only. */
    capabilities: Capability[];
    limitations: string[];
  };
}

/** Derive the live capability set for a language from the authoritative source structures. */
function deriveCapabilities(language: string): Capability[] {
  const out: Capability[] = [];
  if (SIGNATURE_LANGUAGES.has(language)) out.push('signatures');
  if (CALLGRAPH_LANGUAGES.has(language)) out.push('callGraph');
  if (TEST_DETECTION_DECISIONS.get(language) === 'supported') out.push('testDetection');
  if (COMPLEXITY_LANGUAGES.has(language)) out.push('complexity');
  if (IMPORT_RESOLUTION_LANGUAGES.has(language)) out.push('imports');
  if (cfgSupportsLanguage(language)) out.push('cfgOverlay');
  if (TYPE_INFERENCE_LANGUAGES.has(language)) out.push('typeInference');
  if (RECEIVER_REGISTRY_LANGUAGES.has(language)) out.push('receiverResolution');
  if (STYLE_FINGERPRINT_LANGUAGES.has(language)) out.push('styleFingerprint');
  if (isIacLanguage(language)) out.push('iacProjection');
  if (CROSS_SERVICE_HTTP_LANGUAGES.has(language)) out.push('crossServiceHttp');
  if (ERROR_PROPAGATION_LANGUAGES.has(language)) out.push('errorPropagation');
  if (supportsDynamicBoundary(language)) out.push('dynamicBoundary');
  // Return in canonical CAPABILITIES order for determinism.
  return CAPABILITIES.filter(c => out.includes(c));
}

const SCRIPT_CONTAINER_CAPABILITIES = CAPABILITIES.filter(capability =>
  deriveCapabilities('JavaScript').includes(capability)
  && deriveCapabilities('TypeScript').includes(capability),
);

/**
 * The declarative registry: language → its derived support record, for every known
 * language. Computed once from the authoritative capability sources — never hand-listed,
 * so it cannot drift from what the extractors actually do.
 */
export const LANGUAGE_SUPPORT: ReadonlyMap<string, LanguageSupportRecord> = new Map(
  ALL_LANGUAGES.map(language => {
    const isContainer = (SCRIPT_CONTAINER_FORMATS as readonly string[]).includes(language);
    return [language, {
      language,
      capabilities: deriveCapabilities(language),
      known: true,
      ...(isContainer ? {
        container: {
          recognized: true as const,
          extraction: 'script-blocks' as const,
          capabilities: SCRIPT_CONTAINER_CAPABILITIES,
          limitations: [...SCRIPT_CONTAINER_LIMITATIONS],
        },
      } : {}),
    }];
  }),
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
  const normalized = input.trim().toLowerCase();
  const extension = normalized.startsWith('.') ? normalized.slice(1) : normalized;
  const detected = detectCanonicalLanguage(`container.${extension}`);
  const container = (SCRIPT_CONTAINER_FORMATS as readonly string[]).includes(detected)
    ? detected
    : null;
  return CANONICAL_BY_LOWER.get(normalized) ?? container;
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
