/**
 * Codebase style fingerprint (change: add-codebase-style-fingerprint).
 *
 * A deterministic, DESCRIPTIVE per-language idiom profile, tallied during the existing
 * AST walk (see `extractTSGraph`/`extractPyGraph`/`extractGoGraph` in `call-graph.ts`) — no
 * second parse, no new parsing dependency. For each supported language the analyzer counts a
 * fixed, closed set of mutually-exclusive syntactic choices the code actually makes (arrow vs.
 * declared function, `const` vs. `let`, ternary vs. `if`, `await` vs. `.then`, template vs.
 * concatenation, function-naming case) and rolls them up to the repository, each
 * community/region, and (on request) a single file.
 *
 * Three honesty rules are load-bearing (mirrors the IaC extractors and the confidence-boundary
 * invariant):
 *   1. Counters are reported as **ratios with their sample sizes**, never bare percentages.
 *   2. A counter below a FIXED evidence floor reports a null signal (`below_floor`) — never a
 *      default value or a misleading extreme.
 *   3. A choice the language/compiler/formatter makes for the author (e.g. Go ties identifier
 *      case to visibility / gofmt canonicalizes) reports a null signal (`enforced`) rather than
 *      a tautological `1.0`. Which scopes are enforced is DECLARED per language here, never
 *      inferred at runtime.
 *
 * Descriptive, not prescriptive: this measures what the code IS. It emits no lint diagnostic, no
 * quality judgment, and NO composite "style score" — a blended number would be the hidden tuning
 * constant the north star exists to exclude (decision c6d1ad07). Ranking and conformance are the
 * agent's; OpenLore supplies the measured distribution and the evidence behind it.
 *
 * The counter set per language is DATA (`STYLE_LANG_SPECS`), so a language with no declared set
 * contributes nothing (fail-soft), exactly like the CFG overlay's unsupported-language behavior,
 * and the set tracks the language-support registry as languages land.
 *
 * Deterministic: integer tallies over a deterministic walk, sorted keys, no clock — byte-identical
 * across re-analyses of a fixed repository state.
 */

/** Bump when the persisted artifact shape changes incompatibly. */
export const STYLE_SCHEMA_VERSION = 1;

/**
 * Fixed evidence floor: a counter with fewer than this many observations reports a null signal.
 * A constant on purpose — NOT a caller-tunable knob (a tunable floor would be a hidden parameter
 * the honesty contract bans). 12 is enough to distinguish a real majority from coin-flip noise.
 */
export const STYLE_EVIDENCE_FLOOR = 12;

/** The closed set of idiom counters, in deterministic order. */
export const IDIOM_KEYS = [
  'functionForm',
  'binding',
  'conditionalForm',
  'asyncForm',
  'stringForm',
  'functionNaming',
] as const;

export type IdiomKey = (typeof IDIOM_KEYS)[number];

/** Why a counter withheld its ratio. */
export type NullReason = 'below_floor' | 'enforced';

/** A measured idiom (with evidence) or an honestly-withheld null signal. */
export type IdiomSignal =
  | { dominant: string; ratio: number; samples: number; options: Record<string, number> }
  | { signal: null; reason: NullReason };

/** Raw integer tallies for one idiom: option name -> count. */
export type RawIdiomTally = Record<string, number>;

/** Raw counters for one file (single-language, since extraction dispatches per file language). */
export interface FileStyleRaw {
  filePath: string;
  language: string;
  /** Only the idioms this language's spec declares are present. */
  counters: Partial<Record<IdiomKey, RawIdiomTally>>;
  /** Number of function definitions observed in the file (evidence weight). */
  functionsSampled: number;
}

/** A rolled-up, honesty-filtered profile for one language at one granularity. */
export interface LanguageProfile {
  language: string;
  idioms: Partial<Record<IdiomKey, IdiomSignal>>;
  functionsSampled: number;
}

/** A community/region profile (the same communities the map computes). */
export interface RegionProfile {
  communityId: string;
  label?: string;
  byLanguage: LanguageProfile[];
}

/** The persisted style-fingerprint artifact. */
export interface StyleFingerprint {
  schemaVersion: number;
  evidenceFloor: number;
  /** Repository-level profile, sliced per language. */
  byLanguage: LanguageProfile[];
  /** Per community/region profile. */
  regions: RegionProfile[];
  /** Raw per-file counters, retained for on-demand single-file profiles + incremental updates. */
  files: FileStyleRaw[];
  /** file path -> the community id it is attributed to (plurality of its functions). */
  fileRegions: Record<string, string>;
  /** Languages that produced a fingerprint (sorted). */
  generatedLanguages: string[];
}

/** One language's declarative idiom set + the scopes its toolchain enforces (→ null signal). */
export interface StyleLangSpec {
  language: string;
  idioms: IdiomKey[];
  /** Idioms the language/compiler/formatter decides for the author → reported as `enforced` null. */
  enforced: IdiomKey[];
}

/**
 * The per-language counter sets — DATA, not control flow. A language absent here contributes no
 * fingerprint (fail-soft). Conservative by design: an idiom is listed only where it is a genuine,
 * soundly-measurable discretionary choice in that language.
 */
export const STYLE_LANG_SPECS: Record<string, StyleLangSpec> = {
  TypeScript: {
    language: 'TypeScript',
    idioms: ['functionForm', 'binding', 'conditionalForm', 'asyncForm', 'stringForm', 'functionNaming'],
    enforced: [],
  },
  JavaScript: {
    language: 'JavaScript',
    idioms: ['functionForm', 'binding', 'conditionalForm', 'asyncForm', 'stringForm', 'functionNaming'],
    enforced: [],
  },
  Python: {
    // Python has no const/let, and its function form is overwhelmingly `def`; only the genuinely
    // discretionary, soundly-measurable choices are listed for v1.
    language: 'Python',
    idioms: ['conditionalForm', 'functionNaming'],
    enforced: [],
  },
  Go: {
    // `:=` vs. `var` is a real, gofmt-untouched discretionary choice. Identifier CASE, by
    // contrast, is NOT the author's to choose: Go ties exported-ness to capitalization and gofmt
    // canonicalizes — so functionNaming is declared `enforced` and reports a null signal rather
    // than a tautological ratio (the spec's enforcement-awareness scenario, on a real language).
    language: 'Go',
    idioms: ['binding', 'functionNaming'],
    enforced: ['functionNaming'],
  },
};

/** Languages for which a style fingerprint is computed — the registry derives the capability from this. */
export const STYLE_FINGERPRINT_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(STYLE_LANG_SPECS));

// ============================================================================
// Naming-case classification
// ============================================================================

/**
 * Classify a name's case ONLY when it expresses a multi-word convention (a case boundary: an
 * interior uppercase or an interior underscore). Honesty rules baked in so a name can't be
 * mis-bucketed and skew the house-style ratio:
 *   - A leading/trailing underscore RUN is stripped first — a privacy prefix (`_helper`) or a
 *     dunder (`__init__`) is not a naming-CASE choice, so it must not drive the verdict (a bare
 *     `_` then classifies as null, not snake_case).
 *   - A name mixing an interior underscore AND an uppercase letter (`mixed_Case`) follows neither
 *     convention cleanly → null, rather than being forced into snake_case.
 *   - A single all-lowercase word (`handle`) or SCREAMING_CASE (`MAX_RETRIES`) exercises no
 *     camel-vs-snake discretion → null (excluded from the ratio, not a thumb on the scale).
 */
export function classifyNamingCase(name: string): 'camelCase' | 'PascalCase' | 'snake_case' | null {
  if (!name) return null;
  const core = name.replace(/^_+/, '').replace(/_+$/, ''); // drop privacy/dunder underscore runs
  if (!core || !/^[A-Za-z]/.test(core)) return null; // empty, or starts with a non-letter ($, digit)
  if (/^[A-Z][A-Z0-9_]*$/.test(core)) return null; // SCREAMING_CASE / single upper word
  const hasInteriorUnderscore = core.includes('_');
  const hasUpper = /[A-Z]/.test(core);
  if (hasInteriorUnderscore && hasUpper) return null; // mixed convention — not a single choice
  if (hasInteriorUnderscore) return 'snake_case';
  if (/^[A-Z]/.test(core)) return 'PascalCase';
  if (/[a-z0-9][A-Z]/.test(core)) return 'camelCase'; // interior upper, lower start
  return null; // single lowercase word — no case discretion expressed
}

// ============================================================================
// Per-file tally — a single recursive walk over the already-parsed tree
// ============================================================================

/**
 * Minimal structural view of a tree-sitter node (avoids a hard tree-sitter type import). The
 * index accessors (`namedChildCount`/`namedChild`) are optional: the real tree-sitter `SyntaxNode`
 * provides them and the walk prefers them because they DON'T allocate a fresh child array per node
 * (the `.namedChildren` getter does, which dominated the tally cost); a plain test object that only
 * supplies `namedChildren` still works via the fallback.
 */
export interface StyleAstNode {
  type: string;
  text: string;
  children: StyleAstNode[];
  namedChildren: StyleAstNode[];
  namedChildCount?: number;
  namedChild?(i: number): StyleAstNode | null;
}

function bump(tally: RawIdiomTally, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

/** Does a binary `+` expression concatenate strings (vs. add numbers)? Require a string operand. */
function isStringConcat(node: StyleAstNode): boolean {
  const hasPlus = node.children.some(c => c.type === '+');
  if (!hasPlus) return false;
  return node.namedChildren.some(c => c.type === 'string' || c.type === 'template_string');
}

function walk(node: StyleAstNode, visit: (n: StyleAstNode) => void): void {
  visit(node);
  // Prefer the allocation-free index accessors (real tree-sitter SyntaxNode); the `.namedChildren`
  // getter builds a new array on every node, which made this whole-tree walk the tally's dominant
  // cost. Fall back to `.namedChildren` for plain test objects.
  if (typeof node.namedChildCount === 'number' && typeof node.namedChild === 'function') {
    const n = node.namedChildCount;
    for (let i = 0; i < n; i++) {
      const c = node.namedChild(i);
      if (c) walk(c, visit);
    }
  } else {
    for (const c of node.namedChildren) walk(c, visit);
  }
}

/**
 * Tally idiom counters for one file by walking its already-parsed tree once. Pure and
 * deterministic. `functionNames` are the names the call-graph extractor already collected for the
 * file (reused for naming-case, no re-derivation). A language with no spec returns null.
 */
export function tallyFileStyle(params: {
  language: string;
  rootNode: StyleAstNode;
  functionNames: string[];
}): FileStyleRaw | null {
  const { language, rootNode, functionNames } = params;
  const spec = STYLE_LANG_SPECS[language];
  if (!spec) return null;

  const counters: Partial<Record<IdiomKey, RawIdiomTally>> = {};
  const want = new Set(spec.idioms);
  const enforced = new Set(spec.enforced);

  // functionNaming is tallied from the names the extractor already has (skip if enforced).
  if (want.has('functionNaming') && !enforced.has('functionNaming')) {
    const t: RawIdiomTally = {};
    for (const name of functionNames) {
      const c = classifyNamingCase(name);
      if (c) bump(t, c);
    }
    if (Object.keys(t).length > 0) counters.functionNaming = t;
  }

  const needsWalk =
    want.has('functionForm') || want.has('binding') || want.has('conditionalForm') ||
    want.has('asyncForm') || want.has('stringForm');

  if (needsWalk) {
    const functionForm: RawIdiomTally = {};
    const binding: RawIdiomTally = {};
    const conditionalForm: RawIdiomTally = {};
    const asyncForm: RawIdiomTally = {};
    const stringForm: RawIdiomTally = {};

    walk(rootNode, n => {
      switch (n.type) {
        // ---- functionForm (named definitions only — inline callbacks excluded) ----
        case 'function_declaration':
          if (want.has('functionForm')) bump(functionForm, 'declaration');
          break;
        case 'method_definition':
          if (want.has('functionForm')) bump(functionForm, 'method');
          break;
        case 'variable_declarator':
        case 'public_field_definition':
        case 'assignment_expression':
          if (want.has('functionForm')) {
            for (const ch of n.namedChildren) {
              if (ch.type === 'arrow_function') { bump(functionForm, 'arrow'); break; }
              if (ch.type === 'function_expression') { bump(functionForm, 'function'); break; }
            }
          }
          break;
        // ---- binding (TS/JS: const vs let; Go: short := vs var) ----
        case 'lexical_declaration':
          if (want.has('binding')) {
            const kw = n.children[0]?.type;
            if (kw === 'const' || kw === 'let') bump(binding, kw);
          }
          break;
        case 'short_var_declaration':
          if (want.has('binding')) bump(binding, 'short');
          break;
        case 'var_declaration':
          if (want.has('binding')) bump(binding, 'var');
          break;
        // ---- conditionalForm ----
        case 'ternary_expression': // TS/JS
        case 'conditional_expression': // Python
          if (want.has('conditionalForm')) bump(conditionalForm, 'ternary');
          break;
        case 'if_statement':
          if (want.has('conditionalForm')) bump(conditionalForm, 'if');
          break;
        // ---- asyncForm ----
        case 'await_expression':
          if (want.has('asyncForm')) bump(asyncForm, 'await');
          break;
        case 'member_expression':
          if (want.has('asyncForm')) {
            const prop = n.namedChildren.find(c => c.type === 'property_identifier');
            if (prop && (prop.text === 'then' || prop.text === 'catch')) bump(asyncForm, 'then');
          }
          break;
        // ---- stringForm ----
        case 'template_string':
          if (want.has('stringForm')) bump(stringForm, 'template');
          break;
        case 'binary_expression':
          if (want.has('stringForm') && isStringConcat(n)) bump(stringForm, 'concat');
          break;
        default:
          break;
      }
    });

    if (want.has('functionForm') && Object.keys(functionForm).length) counters.functionForm = functionForm;
    if (want.has('binding') && Object.keys(binding).length) counters.binding = binding;
    if (want.has('conditionalForm') && Object.keys(conditionalForm).length) counters.conditionalForm = conditionalForm;
    if (want.has('asyncForm') && Object.keys(asyncForm).length) counters.asyncForm = asyncForm;
    if (want.has('stringForm') && Object.keys(stringForm).length) counters.stringForm = stringForm;
  }

  return { filePath: '', language, counters, functionsSampled: functionNames.length };
}

// ============================================================================
// Roll-up — apply the evidence floor + enforcement-awareness
// ============================================================================

/** Sum option tallies across a set of files for one idiom. */
function sumTally(files: FileStyleRaw[], idiom: IdiomKey): RawIdiomTally {
  const out: RawIdiomTally = {};
  for (const f of files) {
    const t = f.counters[idiom];
    if (!t) continue;
    for (const [opt, n] of Object.entries(t)) out[opt] = (out[opt] ?? 0) + n;
  }
  return out;
}

/** Reduce a summed tally to a presented signal (floor + dominant), deterministic tie-break. */
function presentSignal(tally: RawIdiomTally, floor: number): IdiomSignal {
  const options = Object.fromEntries(Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const total = Object.values(options).reduce((s, n) => s + n, 0);
  if (total < floor) return { signal: null, reason: 'below_floor' };
  // dominant = max count; ties broken by lexicographically smallest option for determinism.
  let dominant = '';
  let best = -1;
  for (const [opt, n] of Object.entries(options)) {
    if (n > best || (n === best && opt < dominant)) { best = n; dominant = opt; }
  }
  return { dominant, ratio: Number((best / total).toFixed(4)), samples: total, options };
}

/** Roll a set of single-language files up to a {@link LanguageProfile}. */
export function rollupLanguage(
  files: FileStyleRaw[],
  language: string = files[0]?.language ?? '',
  floor = STYLE_EVIDENCE_FLOOR,
): LanguageProfile {
  const spec = STYLE_LANG_SPECS[language];
  const idioms: Partial<Record<IdiomKey, IdiomSignal>> = {};
  if (spec) {
    const enforced = new Set(spec.enforced);
    for (const idiom of spec.idioms) {
      if (enforced.has(idiom)) { idioms[idiom] = { signal: null, reason: 'enforced' }; continue; }
      idioms[idiom] = presentSignal(sumTally(files, idiom), floor);
    }
  }
  const functionsSampled = files.reduce((s, f) => s + f.functionsSampled, 0);
  return { language, idioms, functionsSampled };
}

/** Group files by language and roll each up; languages sorted for determinism. */
function profilesByLanguage(files: FileStyleRaw[], floor: number): LanguageProfile[] {
  const byLang = new Map<string, FileStyleRaw[]>();
  for (const f of files) {
    if (!byLang.has(f.language)) byLang.set(f.language, []);
    byLang.get(f.language)!.push(f);
  }
  return [...byLang.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(lang => rollupLanguage(byLang.get(lang)!, lang, floor));
}

/** A node carrying its file + community attribution (subset of the call-graph FunctionNode). */
export interface StyleNodeRef {
  filePath: string;
  communityId?: string;
  communityLabel?: string;
}

/**
 * Attribute each file to ONE community: the community holding the plurality of its functions
 * (ties broken by lexicographically smallest community id — deterministic). A file with no
 * community-bearing function is left unattributed.
 */
export function attributeFilesToRegions(nodes: StyleNodeRef[]): {
  fileRegions: Record<string, string>;
  labels: Record<string, string>;
} {
  const perFile = new Map<string, Map<string, number>>();
  const labels: Record<string, string> = {};
  for (const n of nodes) {
    if (!n.communityId) continue;
    if (n.communityLabel) labels[n.communityId] = n.communityLabel;
    if (!perFile.has(n.filePath)) perFile.set(n.filePath, new Map());
    const m = perFile.get(n.filePath)!;
    m.set(n.communityId, (m.get(n.communityId) ?? 0) + 1);
  }
  const fileRegions: Record<string, string> = {};
  for (const [file, counts] of perFile) {
    let bestId = '';
    let best = -1;
    for (const [id, c] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (c > best) { best = c; bestId = id; }
    }
    if (bestId) fileRegions[file] = bestId;
  }
  return { fileRegions, labels };
}

/**
 * Assemble a {@link StyleFingerprint} from raw per-file counters and a GIVEN file→region map +
 * labels. Pure + deterministic (every collection sorted by a stable key). Used both by the full
 * build (after attributing files to regions from the call graph) and by the incremental watcher
 * update (which reuses the stored `fileRegions` rather than recomputing communities).
 */
export function assembleFromRegions(
  rawFiles: FileStyleRaw[],
  fileRegions: Record<string, string>,
  labels: Record<string, string>,
  floor = STYLE_EVIDENCE_FLOOR,
): StyleFingerprint {
  const files = rawFiles.slice().sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0));
  const byLanguage = profilesByLanguage(files, floor);

  // Only retain region attributions for files that still exist (deletions prune the map). Keys are
  // emitted in SORTED order so the serialized `fileRegions` is byte-identical regardless of the
  // order files were enumerated in — without this, object key-insertion order tracks input order
  // and the persisted artifact would diff spuriously across re-analyses (the determinism contract).
  const present = new Set(files.map(f => f.filePath));
  const prunedRegions: Record<string, string> = {};
  for (const file of Object.keys(fileRegions).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (present.has(file)) prunedRegions[file] = fileRegions[file];
  }

  const filesByRegion = new Map<string, FileStyleRaw[]>();
  for (const f of files) {
    const region = prunedRegions[f.filePath];
    if (!region) continue;
    if (!filesByRegion.has(region)) filesByRegion.set(region, []);
    filesByRegion.get(region)!.push(f);
  }
  const regions: RegionProfile[] = [...filesByRegion.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(communityId => ({
      communityId,
      ...(labels[communityId] ? { label: labels[communityId] } : {}),
      byLanguage: profilesByLanguage(filesByRegion.get(communityId)!, floor),
    }));

  const generatedLanguages = [...new Set(files.map(f => f.language))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    schemaVersion: STYLE_SCHEMA_VERSION,
    evidenceFloor: floor,
    byLanguage,
    regions,
    files,
    fileRegions: prunedRegions,
    generatedLanguages,
  };
}

/**
 * Assemble the full {@link StyleFingerprint} from raw per-file counters and the call-graph nodes
 * (which carry community membership, for region attribution). Pure + deterministic.
 */
export function buildStyleFingerprint(
  rawFiles: FileStyleRaw[],
  nodes: StyleNodeRef[],
  floor = STYLE_EVIDENCE_FLOOR,
): StyleFingerprint {
  const { fileRegions, labels } = attributeFilesToRegions(nodes);
  return assembleFromRegions(rawFiles, fileRegions, labels, floor);
}

/** Roll a SINGLE file's raw counters up to a per-file profile (floor still applies — honest). */
export function fileProfile(raw: FileStyleRaw, floor = STYLE_EVIDENCE_FLOOR): LanguageProfile {
  return rollupLanguage([raw], raw.language, floor);
}

/**
 * Compact top-idioms summary for `orient`: the strongest few measured idioms for a language
 * profile, above the floor and not enforced, as short `key=dominant (ratio)` strings. Bounded.
 */
export function compactIdiomSummary(profile: LanguageProfile, limit = 4): string[] {
  const out: Array<{ key: IdiomKey; ratio: number; label: string }> = [];
  for (const key of IDIOM_KEYS) {
    const sig = profile.idioms[key];
    if (!sig || 'signal' in sig) continue;
    out.push({ key, ratio: sig.ratio, label: `${key}=${sig.dominant} (${sig.ratio})` });
  }
  return out.sort((a, b) => b.ratio - a.ratio || (a.key < b.key ? -1 : 1)).slice(0, limit).map(o => o.label);
}
