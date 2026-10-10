/**
 * Kotlin syntax coverage, measured against a declared language level
 * (change: harden-kotlin-grammar-currency, issue #546).
 *
 * `fixtures/kotlin-syntax/` holds one small file per language feature. Every feature that is
 * stable at or below {@link KOTLIN_LANGUAGE_LEVEL} parses without error, or is listed in
 * {@link KOTLIN_SYNTAX_KNOWN_GAPS}. `kotlin-syntax-corpus.test.ts` fails when a feature is neither,
 * and fails when a listed gap parses clean, so the table cannot go stale.
 */

/** The Kotlin language version OpenLore supports. */
export const KOTLIN_LANGUAGE_LEVEL = '2.2';

export interface KotlinSyntaxFeature {
  /** Fixture file name without the `.kt` extension. */
  file: string;
  feature: string;
  /** The Kotlin version that made the feature stable. */
  stableSince: string;
}

export const KOTLIN_SYNTAX_CORPUS: readonly KotlinSyntaxFeature[] = [
  { file: 'functions', feature: 'Functions: block and expression bodies, generics, extension, infix, tailrec, inline reified, vararg', stableSince: '1.0' },
  { file: 'classes', feature: 'Classes: primary and secondary constructors, init, inheritance, companion, inner, object, data, enum, annotation, abstract', stableSince: '1.0' },
  { file: 'properties', feature: 'Properties: accessors, delegates, lateinit, const, top-level', stableSince: '1.0' },
  { file: 'control-flow', feature: 'Control flow: when, ranges, labels, do-while, try / catch / finally as expressions', stableSince: '1.0' },
  { file: 'lambdas', feature: 'Lambdas, anonymous functions, function types with receiver, callable references, labeled return', stableSince: '1.0' },
  { file: 'null-safety', feature: 'Null safety: safe call, Elvis, non-null assertion, safe and unsafe casts, smart casts', stableSince: '1.0' },
  { file: 'generics', feature: 'Generics: variance, bounds, where clause, star projection, type alias', stableSince: '1.1' },
  { file: 'annotations', feature: 'Annotations: file target, use-site target, arguments with braces, class literal', stableSince: '1.0' },
  { file: 'coroutines', feature: 'Coroutines: suspend functions and suspend function types', stableSince: '1.3' },
  { file: 'strings', feature: 'Strings: templates, raw strings, character escapes', stableSince: '1.0' },
  { file: 'operators', feature: 'Operator functions, destructuring declaration, compound assignment, in / !in', stableSince: '1.0' },
  { file: 'destructuring-and-ranges', feature: 'Destructuring in loops, downTo / step, underscore for unused variables', stableSince: '1.1' },
  { file: 'sealed-and-value', feature: 'Sealed classes and interfaces, data object, value class', stableSince: '1.9' },
  { file: 'fun-interface', feature: 'Functional (SAM) interfaces: `fun interface`', stableSince: '1.4' },
  { file: 'delegation', feature: 'Interface delegation (`by`) and delegated properties', stableSince: '1.0' },
  { file: 'object-expressions', feature: 'Object expressions (anonymous objects)', stableSince: '1.0' },
  { file: 'trailing-commas', feature: 'Trailing commas', stableSince: '1.4' },
  { file: 'definitely-non-null', feature: 'Definitely non-nullable types: `T & Any`', stableSince: '1.7' },
  { file: 'underscore-type-argument', feature: 'Underscore operator for type arguments', stableSince: '1.7' },
  { file: 'open-ended-range', feature: 'Open-ended range operator: `..<`', stableSince: '1.9' },
  { file: 'enum-entries', feature: 'Enum `entries` property', stableSince: '1.9' },
  { file: 'when-guards', feature: 'Guard conditions in `when` with a subject', stableSince: '2.2' },
  { file: 'multi-dollar-strings', feature: 'Multi-dollar string interpolation', stableSince: '2.2' },
  { file: 'non-local-break-continue', feature: 'Non-local `break` and `continue` in inline lambdas', stableSince: '2.2' },
  { file: 'context-sensitive-keywords', feature: 'Soft keywords used as identifiers', stableSince: '1.0' },
  { file: 'local-declarations', feature: 'Local functions, local classes, anonymous functions', stableSince: '1.0' },
];

/**
 * Features the pinned grammar (`tree-sitter-kotlin` 0.3.8) reports as a syntax error. A file that
 * uses one is listed in parse-health, and the declarations outside the error region are still
 * extracted. `fun interface`, `..<`, and `$$"…"` are NOT here: `normalizeKotlinForParse` rewrites them to an
 * equivalent shape before parsing.
 */
export const KOTLIN_SYNTAX_KNOWN_GAPS: Readonly<Record<string, string>> = {
  'when-guards': 'Kotlin 2.2. The grammar has no rule for `if` after a `when` condition; the `when` entry is an error region.',
};

/** Features that parse clean only because of the pre-parse normalization. */
export const KOTLIN_SYNTAX_NORMALIZED: readonly string[] = ['fun-interface', 'open-ended-range', 'multi-dollar-strings'];

export type KotlinSyntaxStatus = 'clean' | 'clean (normalized before parsing)' | 'known gap';

export function kotlinSyntaxStatus(file: string): KotlinSyntaxStatus {
  if (file in KOTLIN_SYNTAX_KNOWN_GAPS) return 'known gap';
  return KOTLIN_SYNTAX_NORMALIZED.includes(file) ? 'clean (normalized before parsing)' : 'clean';
}

const MARK_START = '<!-- kotlin-syntax:start (generated from kotlin-syntax-corpus.ts; do not edit by hand) -->';
const MARK_END = '<!-- kotlin-syntax:end -->';
export const KOTLIN_SYNTAX_DOC_MARKERS = { start: MARK_START, end: MARK_END } as const;

/** Render the "Kotlin syntax coverage" table of `docs/language-support.md`. */
export function renderKotlinSyntaxSection(): string {
  return [
    MARK_START,
    '',
    `Declared language level: **Kotlin ${KOTLIN_LANGUAGE_LEVEL}**. Grammar: \`tree-sitter-kotlin\` 0.3.8.`,
    'A file that uses a known gap is reported by parse-health; its other declarations are still extracted.',
    '',
    '| Feature | Stable since | Result |',
    '|---|---|---|',
    ...KOTLIN_SYNTAX_CORPUS.map(f => {
      const status = kotlinSyntaxStatus(f.file);
      const reason = KOTLIN_SYNTAX_KNOWN_GAPS[f.file];
      return `| ${f.feature} | ${f.stableSince} | ${status}${reason ? `: ${reason}` : ''} |`;
    }),
    '',
    MARK_END,
  ].join('\n');
}
