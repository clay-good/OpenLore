/**
 * Dynamic-boundary sites (change: disclose-dynamic-boundary-regions).
 *
 * The call graph already recovers *some* dynamic dispatch — event/route/callback synthesis, CHA
 * virtual dispatch. What it cannot follow at all is reflection (`getattr`, `send`, `Method.invoke`),
 * computed member dispatch (`obj[name]()`), `eval`/`new Function`, non-literal dynamic imports,
 * metaprogrammed definitions (`define_method`, `Proxy`), and DI-container resolution. Today those
 * constructs are *swallowed*: `getattr` sits in the Python ignore table, `reflect` resolves to a
 * bare `external::` edge, Ruby `send` has no handling at all. A file that dispatches only through
 * them produces a graph indistinguishable from a file with no calls — a confident-looking silence.
 *
 * This module records each such construct as a **dynamic-boundary site** so a conclusion can
 * disclose *unknown* instead of implying *absent*. It is the same move `parse-health.ts` makes for
 * failed parses and the epistemic lease makes for staleness, applied to the last large undisclosed
 * unknown in the graph.
 *
 * Four rules are load-bearing:
 *
 *  1. **Records, never resolves.** A site NEVER produces a node or an edge. Enabling the matcher
 *     leaves the emitted graph byte-identical. Recovering the statically-decidable subset is the
 *     job of the sibling change `resolve-literal-reflective-dispatch`, not this one.
 *  2. **The partition is by resolution OUTCOME, not argument form.** Every recognized construct is
 *     a *candidate*; {@link finalizeDynamicBoundarySites} retracts only those the resolver actually
 *     bound to an internal symbol. A static literal that resolves to nothing, or ambiguously, still
 *     yields a site — with its refusal reason. A syntactic partition would leave those in a silent
 *     hole, which is the exact failure this module exists to remove.
 *  3. **Grounded in syntax or a declared framework binding, never a bare callee name.** A method
 *     merely *named* `get`/`resolve`/`make` is not a container resolution: the file must also import
 *     a declared DI package. `.get(` alone matches hundreds of innocent call sites in any repo.
 *  4. **False-negative biased and fail-soft.** An unrecognized construct is simply not recorded,
 *     exactly as today. A language with no declared spec contributes nothing and is reported as
 *     *unsupported* by the capability registry — never as "contains no dynamic dispatch".
 *
 * Cost: no second parse. The walk runs over the tree the extractor already parsed, and only after a
 * cheap substring pre-scan of the source finds at least one of the language's trigger tokens — so a
 * file with no dynamic construct pays a handful of `indexOf` calls and no traversal at all.
 *
 * Deterministic: integer positions over a deterministic walk, sorted output, no clock — so two
 * analyses of unchanged sources produce byte-identical artifacts.
 */

import { redactSecretString } from '../services/secret-redaction.js';
import { sanitizeForTerminal } from '../../utils/misc.js';

/** Bump when the persisted artifact shape changes incompatibly. */
export const DYNAMIC_BOUNDARY_SCHEMA_VERSION = 1;

/**
 * The closed site vocabulary. Source-declared so it is queryable and testable; a matcher emitting
 * anything outside this set fails `dynamic-boundary.test.ts`.
 */
export const DYNAMIC_BOUNDARY_KINDS = [
  'reflective-invoke',
  'computed-member',
  'code-eval',
  'dynamic-import',
  'metaprogrammed-definition',
  'container-resolution',
] as const;

export type DynamicBoundaryKind = (typeof DYNAMIC_BOUNDARY_KINDS)[number];

/** Human phrasing for one kind, shared by every surface that renders a site. */
export const DYNAMIC_BOUNDARY_KIND_LABEL: Record<DynamicBoundaryKind, string> = {
  'reflective-invoke': 'reflective invocation',
  'computed-member': 'computed member dispatch',
  'code-eval': 'runtime code evaluation',
  'dynamic-import': 'dynamic module import',
  'metaprogrammed-definition': 'metaprogrammed definition',
  'container-resolution': 'DI container resolution',
};

/**
 * Why the resolver refused this construct. Decided AFTER resolution, never from the argument's
 * syntactic form — see {@link finalizeDynamicBoundarySites}.
 */
export const DYNAMIC_BOUNDARY_REFUSALS = [
  /** The dispatch selector is not a static literal — nothing to resolve. */
  'no-static-target',
  /** A static literal selector that names no symbol in this index. */
  'unresolved-external',
  /** A static literal selector that names more than one symbol; picking one would be a guess. */
  'ambiguous-target',
] as const;

export type DynamicBoundaryRefusal = (typeof DYNAMIC_BOUNDARY_REFUSALS)[number];

/** Human phrasing for one refusal reason. */
export const DYNAMIC_BOUNDARY_REFUSAL_LABEL: Record<DynamicBoundaryRefusal, string> = {
  'no-static-target': 'the dispatch target is computed at runtime',
  'unresolved-external': 'the named target resolves to no symbol in this index',
  'ambiguous-target': 'the named target resolves to more than one symbol',
};

/**
 * Maximum characters of matched source retained as evidence. Evidence is untrusted repository text
 * that reaches an artifact, an MCP response, and a terminal — it is redacted, neutralized and
 * truncated at EXTRACTION time, before it can be persisted or crossing a worker boundary.
 */
export const DYNAMIC_BOUNDARY_EVIDENCE_MAX = 120;

/**
 * Maximum sites retained per file. A generated dispatch table could otherwise carry thousands; the
 * per-file count stays exact, only the site LIST is bounded, and truncation is disclosed.
 */
export const DYNAMIC_BOUNDARY_SITE_CAP = 50;

/**
 * Declared density ceiling: recorded sites per thousand lines of a file's language, measured over
 * the substrate's own repository and every language fixture. A matcher that fires more often than
 * this is matching an ordinary idiom, not a boundary, and fails the suite rather than shipping.
 *
 * A ceiling, not a tuning knob: it is asserted in tests, never consulted at run time.
 */
export const DYNAMIC_BOUNDARY_DENSITY_CEILING_PER_KLOC = 12;

/** One recorded site, as persisted. `filePath`/`language` live on the enclosing file record. */
export interface DynamicBoundarySite {
  /** 1-based line of the matched construct. */
  line: number;
  kind: DynamicBoundaryKind;
  refusal: DynamicBoundaryRefusal;
  /** The enclosing function's node id. Absent when the construct sits outside any function. */
  symbolId?: string;
  /** The construct is at module level — explicit, so an absent `symbolId` is never ambiguous. */
  moduleLevel?: true;
  /** Redacted, terminal-neutralized, truncated source of the matched construct. */
  evidence: string;
  /** `evidence` hit {@link DYNAMIC_BOUNDARY_EVIDENCE_MAX}. */
  evidenceTruncated?: true;
}

/** Every site recorded in one file. Present only for a file with at least one site. */
export interface FileDynamicBoundary {
  filePath: string;
  language: string;
  /** Sorted by line, then kind. Bounded by {@link DYNAMIC_BOUNDARY_SITE_CAP}. */
  sites: DynamicBoundarySite[];
  /** Total matched in this file, when it exceeds the retained list. */
  totalSites?: number;
  /** `sites` hit the cap — more exist than are listed. */
  truncated?: true;
}

/** The persisted, rolled-up report (`dynamic-boundary.json`). Absent when nothing was recorded. */
export interface DynamicBoundaryReport {
  version: number;
  /** Sum of every file's recorded site count (exact, not the bounded list length). */
  totalSites: number;
  /** Files carrying at least one site. */
  totalFiles: number;
  /** Per-kind rollup, sorted by the declared vocabulary order. */
  byKind: Array<{ kind: DynamicBoundaryKind; count: number }>;
  /** Per-language rollup, sorted by count desc then name. */
  byLanguage: Array<{ language: string; files: number; sites: number }>;
  /** Every per-file record, sorted by path — the source of truth the watcher splices. */
  files: FileDynamicBoundary[];
}

/**
 * A construct the matcher recognized, before resolution decided whether it is a site. Carries the
 * byte offset so the extractor can attribute it to its enclosing function, and the literal dispatch
 * target (when the selector is a static literal) so the partition can be decided against the graph.
 */
export interface DynamicBoundaryCandidate {
  kind: DynamicBoundaryKind;
  /** 1-based line. */
  line: number;
  /** Byte offset of the matched construct, for `findEnclosingFunction`. */
  startIndex: number;
  /** Already redacted, neutralized and truncated. */
  evidence: string;
  evidenceTruncated?: true;
  /** The static literal the construct dispatches to, when it has one (`getattr(o, "run")`). */
  literalTarget?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-language matcher specifications (DATA — a language with no spec is unsupported)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How one language's constructs are recognized.
 *
 * Every rule is keyed on a **callee name plus a syntactic position** (the callee of a call node),
 * or on a syntactic node shape (a computed-subscript callee). Never on a bare identifier anywhere
 * in the file.
 */
interface LanguageSpec {
  /**
   * Cheap source pre-scan. The tree is walked only when at least one of these substrings occurs in
   * the source, so a file with no dynamic construct pays no traversal.
   */
  triggers: string[];
  /** Node types that denote a call in this grammar (the `function`/`method` field is inspected). */
  callTypes: string[];
  /** Node types that denote `new X(...)`, if the grammar has one. */
  newTypes?: string[];
  /** Bare callee name → kind. `getattr(...)`, `eval(...)`, `send(...)`. */
  calleeKinds: Record<string, DynamicBoundaryKind>;
  /**
   * Dotted callee (`object.method`) → kind, matched on the FULL dotted text of the callee. Keyed on
   * a namespace the language reserves (`importlib.import_module`, `Reflect.get`), never a bare name.
   */
  dottedKinds?: Record<string, DynamicBoundaryKind>;
  /**
   * Member-call rules that need import evidence: the file must contain one of `requires` before the
   * `method` name counts. This is what keeps `.invoke(`/`.Call(` from firing on ordinary code.
   */
  gatedMethods?: Array<{ methods: string[]; requires: string[]; kind: DynamicBoundaryKind }>;
  /** `new X(...)` constructor name → kind. */
  constructorKinds?: Record<string, DynamicBoundaryKind>;
  /** Node types that, used as a call's callee, denote computed member dispatch (`obj[expr]()`). */
  computedCalleeTypes?: string[];
  /**
   * Node types that a computed callee's index may be for the dispatch to count as STATIC (and so
   * not a boundary): `obj["literal"]()` is a resolvable member access, `obj[name]()` is not.
   */
  staticIndexTypes?: string[];
  /** Declared DI packages; a `container-resolution` rule fires only when one is imported. */
  diPackages?: string[];
  /** Resolution APIs of those packages. Only consulted when a DI package is present. */
  diMethods?: string[];
  /** Node types whose text is a string literal, used to read a literal dispatch target. */
  literalTypes: string[];
  /**
   * How this language spells an import, so a gated or DI rule can require REAL import evidence.
   *
   * Load-bearing, not cosmetic: a bare substring scan reads a package name out of a comment, a
   * string table, or a framework-detection list, and then every `map.get(k)` in that file becomes a
   * "DI container resolution". This module's own matcher table names six DI packages, so a
   * substring gate flags the matcher itself. The requirement is a DECLARED BINDING; only an import
   * is one.
   */
  importStyle: ImportStyle;
  /**
   * Node types that ARE an import in this grammar. When the tree carries at least one, import
   * evidence is read from those nodes alone rather than from the whole source — which is what stops
   * an import spelled inside a string literal (a test fixture, a code sample, a generator template)
   * from binding a package into the file that merely quotes it. A file with none falls back to the
   * anchored source scan, so a CommonJS `require` is still recognised.
   */
  importNodeTypes?: string[];
  /**
   * Whether a {@link LanguageSpec.calleeKinds} name still counts when called on an arbitrary
   * receiver (`mailer.send(:deliver)`).
   *
   * True only where the language defines the name on its universal base object, so the reflective
   * meaning is the language's and not one object's: Ruby's `send`/`public_send`/`instance_eval` are
   * `Object` methods. Everywhere else a dotted receiver means the name belongs to that object —
   * `stream.eval(x)` is not JavaScript's `eval` — so the rule is restricted to a bare call or a
   * self-like receiver, and the bare-name matching the honesty contract forbids never happens.
   */
  calleeKindsOnAnyReceiver?: boolean;
}

/**
 * The declared per-language matchers. **This table is the language-support source of truth** — a
 * language absent from it has no `dynamicBoundary` capability, and the registry says so rather than
 * implying the language is clean.
 */
export const DYNAMIC_BOUNDARY_LANG_SPECS: Record<string, LanguageSpec> = {
  TypeScript: tsSpec(),
  JavaScript: tsSpec(),
  Python: {
    triggers: ['getattr', 'setattr', 'eval', 'exec', 'compile', '__import__', 'import_module',
      'methodcaller', ']('],
    callTypes: ['call'],
    calleeKinds: {
      eval: 'code-eval',
      exec: 'code-eval',
      compile: 'code-eval',
      getattr: 'reflective-invoke',
      setattr: 'metaprogrammed-definition',
      __import__: 'dynamic-import',
    },
    dottedKinds: {
      'importlib.import_module': 'dynamic-import',
      // `methodcaller` INVOKES a runtime-named method; `attrgetter` only reads an attribute, so it
      // is deliberately absent — a site must mark a dispatch the resolver cannot follow, not every
      // reflective read.
      'operator.methodcaller': 'reflective-invoke',
    },
    computedCalleeTypes: ['subscript'],
    staticIndexTypes: ['string', 'integer'],
    literalTypes: ['string'],
    diPackages: ['dependency_injector', 'injector', 'punq', 'lagom'],
    diMethods: ['resolve', 'provide'],
    importStyle: 'python',
    importNodeTypes: ['import_statement', 'import_from_statement'],
  },
  Ruby: {
    triggers: ['send', 'eval', 'define_', 'method_missing', 'const_get',
      'instance_variable_get'],
    callTypes: ['call', 'method_call'],
    calleeKinds: {
      send: 'reflective-invoke',
      public_send: 'reflective-invoke',
      __send__: 'reflective-invoke',
      const_get: 'reflective-invoke',
      instance_variable_get: 'reflective-invoke',
      eval: 'code-eval',
      instance_eval: 'code-eval',
      class_eval: 'code-eval',
      module_eval: 'code-eval',
      define_method: 'metaprogrammed-definition',
      method_missing: 'metaprogrammed-definition',
      define_singleton_method: 'metaprogrammed-definition',
    },
    literalTypes: ['simple_symbol', 'string', 'string_content'],
    // `send`, `public_send`, `instance_eval` and friends are Ruby `Object`/`Module` methods: the
    // reflective meaning belongs to the language, not to whatever object is on the left.
    calleeKindsOnAnyReceiver: true,
    // Ruby declares no gated or DI rule, so no import evidence is consulted; the style is declared
    // anyway so the field stays total and a future rule cannot forget it.
    importStyle: 'js',
  },
  PHP: {
    triggers: ['call_user_func', 'eval', 'create_function', '$$', 'ReflectionMethod', 'ReflectionClass'],
    callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
    calleeKinds: {
      call_user_func: 'reflective-invoke',
      call_user_func_array: 'reflective-invoke',
      eval: 'code-eval',
      create_function: 'code-eval',
    },
    computedCalleeTypes: ['variable_name', 'dynamic_variable_name'],
    literalTypes: ['string', 'encapsed_string', 'string_content'],
    importStyle: 'php',
    importNodeTypes: ['namespace_use_declaration'],
  },
  Go: {
    triggers: ['reflect.'],
    callTypes: ['call_expression'],
    calleeKinds: {},
    gatedMethods: [
      { methods: ['Call', 'CallSlice', 'MethodByName', 'FieldByName'], requires: ['"reflect"'], kind: 'reflective-invoke' },
    ],
    literalTypes: ['interpreted_string_literal', 'raw_string_literal'],
    importStyle: 'go',
    importNodeTypes: ['import_declaration'],
  },
  Java: {
    triggers: ['.invoke(', 'Class.forName', 'getBean', 'getDeclaredMethod', 'getMethod('],
    callTypes: ['method_invocation'],
    calleeKinds: {},
    dottedKinds: { 'Class.forName': 'dynamic-import' },
    gatedMethods: [
      { methods: ['invoke'], requires: ['java.lang.reflect', 'java.lang.reflect.Method'], kind: 'reflective-invoke' },
      { methods: ['getDeclaredMethod', 'getMethod'], requires: ['java.lang.reflect'], kind: 'reflective-invoke' },
      { methods: ['getBean'], requires: ['org.springframework'], kind: 'container-resolution' },
    ],
    literalTypes: ['string_literal'],
    importStyle: 'jvm',
    importNodeTypes: ['import_declaration'],
  },
  'C#': {
    triggers: ['.Invoke(', 'Activator.CreateInstance', 'GetMethod(', 'GetType().'],
    callTypes: ['invocation_expression'],
    calleeKinds: {},
    dottedKinds: { 'Activator.CreateInstance': 'reflective-invoke' },
    gatedMethods: [
      { methods: ['Invoke', 'GetMethod'], requires: ['System.Reflection'], kind: 'reflective-invoke' },
      { methods: ['GetService', 'GetRequiredService'], requires: ['Microsoft.Extensions.DependencyInjection'], kind: 'container-resolution' },
    ],
    literalTypes: ['string_literal'],
    importStyle: 'jvm',
    importNodeTypes: ['using_directive'],
  },
};

/** How a language spells the import that binds a package name into a file. */
type ImportStyle = 'js' | 'python' | 'jvm' | 'go' | 'php';

/** Escape a package/namespace token for embedding in a `RegExp`. */
function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

/**
 * Does `source` actually IMPORT `token`? Anchored to each language's import syntax, so a package
 * name mentioned in a comment, a string literal, or a framework-name check is not mistaken for a
 * binding. Conservative in the false-negative direction, like every other rule here: an import
 * spelled in a way this does not recognise simply disables the rule for that file.
 */
export function hasImportEvidence(source: string, token: string, style: ImportStyle): boolean {
  const t = escapeToken(token.replace(/^"|"$/g, ''));
  switch (style) {
    case 'js':
      // `from 'pkg'`, `require('pkg')`, `import('pkg')` — the specifier position only. A subpath
      // (`pkg/sub`) still counts; a comment naming the package does not.
      return new RegExp(`(?:from|require\\(|import\\()\\s*['"\`]${t}(?:['"\`/])`).test(source);
    case 'python':
      return new RegExp(`^[ \\t]*(?:import|from)[ \\t]+${t}\\b`, 'm').test(source);
    case 'jvm':
      // Java `import a.b.C;` / C# `using A.B;` — statement position, start of line.
      return new RegExp(`^[ \\t]*(?:import|using)[ \\t]+(?:static[ \\t]+)?${t}`, 'm').test(source);
    case 'go':
      // Inside an import block or a single-line import; the quoted path is the binding.
      return new RegExp(`^[ \\t]*(?:import[ \\t]+)?(?:[A-Za-z_.]+[ \\t]+)?"${t}(?:/[^"]*)?"`, 'm').test(source);
    case 'php':
      return new RegExp(`^[ \\t]*use[ \\t]+\\\\?${t}`, 'm').test(source);
  }
}

/** The TS and JS grammars share every rule; declared once so they cannot drift apart. */
function tsSpec(): LanguageSpec {
  return {
    triggers: ['eval', 'Function(', 'import(', 'require(', '](', 'Proxy', 'Reflect.',
      'defineProperty'],
    callTypes: ['call_expression'],
    newTypes: ['new_expression'],
    calleeKinds: {
      eval: 'code-eval',
    },
    dottedKinds: {
      'Reflect.get': 'reflective-invoke',
      'Reflect.apply': 'reflective-invoke',
      'Reflect.construct': 'reflective-invoke',
      // `Reflect.defineProperty` is part of the reflection API a `Proxy` trap is written against.
      // `Object.defineProperty` is NOT here: defining a property is ordinary JavaScript — test
      // setup patches `process.stdout.isTTY` with it constantly — and it hides no dispatch. A rule
      // that fires on it buries the real sites under setup noise.
      'Reflect.defineProperty': 'metaprogrammed-definition',
    },
    constructorKinds: {
      Function: 'code-eval',
      Proxy: 'metaprogrammed-definition',
    },
    computedCalleeTypes: ['subscript_expression'],
    staticIndexTypes: ['string', 'number'],
    literalTypes: ['string', 'string_fragment', 'template_string'],
    diPackages: ['inversify', 'tsyringe', 'typedi', 'awilix', '@nestjs/common', 'injection-js'],
    diMethods: ['get', 'resolve', 'make', 'cradle'],
    importStyle: 'js',
    importNodeTypes: ['import_statement'],
  };
}

/** Languages the matcher declares support for — derived from the table, never hand-listed. */
export const DYNAMIC_BOUNDARY_LANGUAGES: readonly string[] =
  Object.keys(DYNAMIC_BOUNDARY_LANG_SPECS).sort();

/** True when this language has a declared matcher. Consulted by the capability registry. */
export function supportsDynamicBoundary(language: string): boolean {
  return Object.hasOwn(DYNAMIC_BOUNDARY_LANG_SPECS, language);
}

// ─────────────────────────────────────────────────────────────────────────────
// The walk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal structural view of a tree-sitter node — kept dependency-light (no `tree-sitter` import)
 * so this module stays a leaf and can be unit-tested with plain objects, exactly like
 * {@link ../analyzer/parse-health.js ParseHealthNode}. Both bindings expose `childCount`/`child(i)`;
 * `children` is the plain-object fallback.
 */
export interface DynamicBoundaryNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  childCount?: number;
  child?(i: number): DynamicBoundaryNode | null;
  children?: DynamicBoundaryNode[];
  childForFieldName?(name: string): DynamicBoundaryNode | null;
}

function childrenOf(n: DynamicBoundaryNode): DynamicBoundaryNode[] {
  if (typeof n.childCount === 'number' && typeof n.child === 'function') {
    const out: DynamicBoundaryNode[] = [];
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) out.push(c);
    }
    return out;
  }
  return n.children ?? [];
}

/** The node in `field`, or undefined — defensive across bindings and plain test objects. */
function field(n: DynamicBoundaryNode, name: string): DynamicBoundaryNode | undefined {
  if (typeof n.childForFieldName === 'function') {
    return n.childForFieldName(name) ?? undefined;
  }
  return undefined;
}

function textOf(source: string, n: DynamicBoundaryNode): string {
  return source.slice(n.startIndex, n.endIndex);
}

/**
 * Redact, neutralize and truncate one matched construct's source into storable evidence.
 *
 * Order matters: redaction first (so a credential is replaced while its shape is intact), then
 * terminal neutralization (so an ANSI sequence in the source can never reach a terminal), then
 * truncation and whitespace collapse. Applied HERE — at extraction — so the fact is already safe
 * before it crosses the worker boundary, enters the fact cache, or is persisted.
 */
export function toEvidence(raw: string): { evidence: string; truncated: boolean } {
  const clean = sanitizeForTerminal(redactSecretString(raw))
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= DYNAMIC_BOUNDARY_EVIDENCE_MAX) return { evidence: clean, truncated: false };
  return { evidence: clean.slice(0, DYNAMIC_BOUNDARY_EVIDENCE_MAX) + '…', truncated: true };
}

/** Strip the quoting from a literal node's text, so `"run"` / `:run` / `'run'` all read `run`. */
function literalValue(text: string): string | undefined {
  const t = text.trim();
  if (t.length === 0) return undefined;
  if (t.startsWith(':')) return t.slice(1) || undefined;
  const q = t[0];
  if ((q === '"' || q === "'" || q === '`') && t.length >= 2 && t.endsWith(q)) {
    const inner = t.slice(1, -1);
    return inner.length > 0 ? inner : undefined;
  }
  // Ruby's `string_content` / TS's `string_fragment` arrive already unquoted.
  return /^[A-Za-z_$][\w$]*$/.test(t) ? t : undefined;
}

/**
 * The literal dispatch target of a call, when it has one: the first string/symbol argument whose
 * value looks like an identifier. `getattr(o, "run")` → `run`; `getattr(o, name)` → undefined.
 */
function literalTargetOf(
  source: string,
  call: DynamicBoundaryNode,
  spec: LanguageSpec,
): string | undefined {
  const args = field(call, 'arguments') ?? childrenOf(call).find(c => /argument/.test(c.type));
  if (!args) return undefined;
  const stack = [...childrenOf(args)];
  let depth = 0;
  while (stack.length > 0 && depth++ < 64) {
    const n = stack.shift()!;
    if (spec.literalTypes.includes(n.type)) {
      const v = literalValue(textOf(source, n));
      if (v) return v;
    }
    // A quoted literal wraps its content in a child node in several grammars.
    if (/^(string|encapsed)/.test(n.type)) stack.push(...childrenOf(n));
  }
  return undefined;
}

/** The dotted text of a call's callee (`Reflect.get`), or undefined when it is not a member access. */
function calleeText(source: string, call: DynamicBoundaryNode): string | undefined {
  const fn = calleeNode(call);
  if (!fn) return undefined;
  return textOf(source, fn).trim();
}

/**
 * The callee node of a call, across the grammars' differing field names. Falls back to the first
 * child, which is the callee in every call grammar here — and is what keeps this module unit-
 * testable with plain objects that carry no `childForFieldName`.
 */
function calleeNode(call: DynamicBoundaryNode): DynamicBoundaryNode | undefined {
  return field(call, 'function') ?? field(call, 'method') ?? field(call, 'name')
    ?? childrenOf(call)[0];
}

/** The trailing `.name` of a dotted callee, or the whole text when it is a bare identifier. */
function lastSegment(text: string): string {
  const i = text.lastIndexOf('.');
  return i === -1 ? text : text.slice(i + 1);
}

/**
 * Every substring whose presence could make some rule in this spec fire — the language's own
 * construct tokens plus the import evidence its gated and DI rules require. Derived so a rule can
 * never be added without also being reachable through the pre-scan.
 */
export function triggersFor(spec: { triggers: string[]; diPackages?: string[]; gatedMethods?: Array<{ requires: string[] }> }): string[] {
  return [
    ...spec.triggers,
    ...(spec.diPackages ?? []),
    ...(spec.gatedMethods ?? []).flatMap(g => g.requires),
  ];
}

/**
 * The text import evidence is read from: the file's actual import nodes when the grammar declares
 * them and the tree carries at least one, else the whole source.
 *
 * This is what separates "the file imports `inversify`" from "the file CONTAINS the characters
 * `import { Container } from 'inversify'` — inside a template literal, as a fixture." Both read
 * identically to a source scan; only one is a binding. The fallback keeps CommonJS `require` and
 * any import shape the grammar list misses working exactly as the source scan does.
 */
function collectImportText(
  spec: LanguageSpec,
  root: DynamicBoundaryNode,
  source: string,
): string {
  if (!spec.importNodeTypes?.length) return source;
  const types = new Set(spec.importNodeTypes);
  const parts: string[] = [];
  // Imports live at (or just under) module level in every grammar here, so a shallow scan finds
  // them without a second full traversal.
  const stack: Array<{ n: DynamicBoundaryNode; depth: number }> = [{ n: root, depth: 0 }];
  while (stack.length > 0) {
    const { n, depth } = stack.pop()!;
    if (types.has(n.type)) {
      parts.push(textOf(source, n));
      continue;
    }
    if (depth >= 3) continue;
    for (const c of childrenOf(n)) stack.push({ n: c, depth: depth + 1 });
  }
  return parts.length > 0 ? parts.join('\n') : source;
}

/**
 * Walk one already-parsed tree and record every candidate the resolver cannot follow.
 *
 * Fail-soft by construction: an unrecognized construct is not recorded, an unsupported language
 * returns `[]`, and a source with none of the language's trigger tokens is never walked at all.
 *
 * The walk is ITERATIVE, for the reason `tallyParseHealth` documents: tree depth is not bounded by
 * anything the analyzer controls, and a `RangeError` raised inside a native node accessor becomes an
 * uncatchable abort rather than a JavaScript error. An explicit stack cannot overflow.
 */
export function matchDynamicBoundaries(
  language: string,
  root: DynamicBoundaryNode,
  source: string,
): DynamicBoundaryCandidate[] {
  const spec = DYNAMIC_BOUNDARY_LANG_SPECS[language];
  if (!spec) return [];
  // The pre-scan must cover EVERY rule that can fire, or a rule silently never matches. The gated
  // and DI rules key on an import, not on the construct, so their evidence tokens are part of the
  // trigger set — derived from the same table, so the two cannot drift apart.
  if (!triggersFor(spec).some(t => source.includes(t))) return [];

  const importText = collectImportText(spec, root, source);
  const diPresent = !!spec.diPackages?.some(p => hasImportEvidence(importText, p, spec.importStyle));
  const gates = (spec.gatedMethods ?? [])
    .filter(g => g.requires.some(r => hasImportEvidence(importText, r, spec.importStyle)));

  const out: DynamicBoundaryCandidate[] = [];
  const seen = new Set<number>();
  const record = (
    kind: DynamicBoundaryKind,
    node: DynamicBoundaryNode,
    literalTarget?: string,
  ): void => {
    // One construct yields at most one candidate: a nested match (`getattr(o, x)()`) must not be
    // counted twice, and double-counting would inflate the density budget as well as the receipt.
    if (seen.has(node.startIndex)) return;
    seen.add(node.startIndex);
    const { evidence, truncated } = toEvidence(textOf(source, node));
    out.push({
      kind,
      line: node.startPosition.row + 1,
      startIndex: node.startIndex,
      evidence,
      ...(truncated ? { evidenceTruncated: true as const } : {}),
      ...(literalTarget ? { literalTarget } : {}),
    });
  };

  const stack: DynamicBoundaryNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;

    if (spec.newTypes?.includes(n.type) && spec.constructorKinds) {
      const ctor = field(n, 'constructor');
      const name = ctor ? textOf(source, ctor).trim() : undefined;
      const kind = name ? spec.constructorKinds[name] : undefined;
      if (kind) record(kind, n);
    }

    if (spec.callTypes.includes(n.type)) {
      const fn = calleeNode(n);
      const text = calleeText(source, n);

      // 1. Computed member dispatch — `obj[expr]()`. A syntactic shape, not a name: the callee is a
      //    subscript whose index is not a static literal. `obj["run"]()` IS statically resolvable
      //    (the sibling change recovers it), so it is not recorded here.
      if (fn && spec.computedCalleeTypes?.includes(fn.type)) {
        const index = field(fn, 'index') ?? field(fn, 'subscript')
          ?? childrenOf(fn).slice(1).find(c => c.type !== '[' && c.type !== ']');
        const staticIndex = !!index && !!spec.staticIndexTypes?.includes(index.type);
        if (!staticIndex) record('computed-member', n);
      } else if (text) {
        // A dotted rule is checked first, on the FULL dotted text: `Reflect.get` must never be read
        // as a bare `get`.
        const dotted = spec.dottedKinds?.[text];
        // A `calleeKinds` rule fires on a bare call, on a self-like receiver, or — only where the
        // language declares the name on its universal base object — on any receiver.
        const bareApplies = !text.includes('.')
          || isSelfDotted(text)
          || !!spec.calleeKindsOnAnyReceiver;
        const kind = dotted ?? (bareApplies ? spec.calleeKinds[lastSegment(text)] : undefined);
        if (kind) {
          record(kind, n, literalTargetOf(source, n, spec));
        } else {
          // 2. Gated member rules — `.invoke(`, `.Call(`, `.getBean(` — which fire only when the
          //    file imports the framework that gives the name its reflective meaning.
          const method = lastSegment(text);
          const gate = gates.find(g => g.methods.includes(method));
          if (gate) {
            record(gate.kind, n, literalTargetOf(source, n, spec));
          } else if (
            // 3. DI container resolution — grounded in a declared DI package import, never on the
            //    bare method name. `this.cache.get(key)` in a file with no DI import is not a site.
            diPresent && spec.diMethods?.includes(method) && text.includes('.')
          ) {
            record('container-resolution', n, literalTargetOf(source, n, spec));
          }
        }
      }
    }

    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }

  out.sort((a, b) => a.startIndex - b.startIndex);
  return out;
}

/**
 * A dotted callee whose receiver denotes the enclosing object, so a bare-name rule still applies:
 * `self.send(:x)` in Ruby, `this.eval(...)` in JS. Mirrors `isSelfReceiver` in the call-graph
 * builtins, kept local so this module stays a leaf.
 */
function isSelfDotted(text: string): boolean {
  const receiver = text.slice(0, text.lastIndexOf('.'));
  return receiver === 'self' || receiver === 'this' || receiver === 'super' || receiver === 'cls';
}

// ─────────────────────────────────────────────────────────────────────────────
// The partition: candidates → sites, decided by resolution OUTCOME
// ─────────────────────────────────────────────────────────────────────────────

/** What the resolver did with a candidate's literal target. Supplied by the caller after Pass 2. */
export interface ResolutionProbe {
  /** True when the resolver emitted an edge for this exact construct — the candidate is retracted. */
  resolvedToEdge(candidate: { symbolId?: string; line: number; literalTarget?: string }): boolean;
  /** How many internal symbols carry this name. 0 → unresolved-external, >1 → ambiguous-target. */
  countSymbolsNamed(name: string): number;
}

/** A candidate with its enclosing-symbol attribution filled in by the extractor. */
export interface AttributedCandidate extends DynamicBoundaryCandidate {
  symbolId?: string;
}

/**
 * Finalize one file's candidates into persisted sites — the second half of the two-phase partition.
 *
 * A candidate is RETRACTED only when the resolver actually bound it to an internal symbol; every
 * other candidate becomes a site carrying the reason the resolver refused it. That is the whole
 * point of deciding after resolution rather than on argument form: a static literal naming an
 * external target resolves to nothing, and would otherwise produce neither an edge nor a site —
 * a silent hole that reads as "no dynamic dispatch here".
 *
 * With no reflective resolver wired (the sibling change `resolve-literal-reflective-dispatch` owns
 * that), `resolvedToEdge` is false for every candidate and every one becomes a site — which is the
 * honest answer for today's graph, since today's graph really does emit no edge for them.
 */
export function finalizeDynamicBoundarySites(
  candidates: AttributedCandidate[],
  probe: ResolutionProbe,
): DynamicBoundarySite[] {
  const sites: DynamicBoundarySite[] = [];
  for (const c of candidates) {
    if (probe.resolvedToEdge(c)) continue;
    let refusal: DynamicBoundaryRefusal = 'no-static-target';
    if (c.literalTarget) {
      refusal = probe.countSymbolsNamed(c.literalTarget) > 1
        ? 'ambiguous-target'
        : 'unresolved-external';
    }
    sites.push({
      line: c.line,
      kind: c.kind,
      refusal,
      ...(c.symbolId ? { symbolId: c.symbolId } : { moduleLevel: true as const }),
      evidence: c.evidence,
      ...(c.evidenceTruncated ? { evidenceTruncated: true as const } : {}),
    });
  }
  sites.sort((a, b) => a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  if (sites.length <= DYNAMIC_BOUNDARY_SITE_CAP) return sites;
  return sites.slice(0, DYNAMIC_BOUNDARY_SITE_CAP);
}

/** Build one file's record from its finalized sites, or `undefined` when it has none. */
export function buildFileDynamicBoundary(
  filePath: string,
  language: string,
  allSites: DynamicBoundarySite[],
): FileDynamicBoundary | undefined {
  if (allSites.length === 0) return undefined;
  const sorted = [...allSites].sort(
    (a, b) => a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  const kept = sorted.slice(0, DYNAMIC_BOUNDARY_SITE_CAP);
  return {
    filePath,
    language,
    sites: kept,
    ...(sorted.length > kept.length
      ? { totalSites: sorted.length, truncated: true as const }
      : {}),
  };
}

/** Exact recorded-site count for one file — the total, not the retained list length. */
export function fileSiteCount(f: FileDynamicBoundary): number {
  return f.totalSites ?? f.sites.length;
}

/**
 * Roll per-file records up into the persisted report. Returns `undefined` when there are no records
 * — a clean repo persists no artifact, and every consumer reads "no artifact" as "no boundary", so
 * a clean repo pays nothing.
 */
export function buildDynamicBoundaryReport(
  records: FileDynamicBoundary[],
): DynamicBoundaryReport | undefined {
  const files = records.filter(r => r.sites.length > 0);
  if (files.length === 0) return undefined;

  const kindCounts = new Map<DynamicBoundaryKind, number>();
  const langCounts = new Map<string, { files: number; sites: number }>();
  let totalSites = 0;

  for (const f of files) {
    totalSites += fileSiteCount(f);
    for (const s of f.sites) kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
    const l = langCounts.get(f.language) ?? { files: 0, sites: 0 };
    l.files++;
    l.sites += fileSiteCount(f);
    langCounts.set(f.language, l);
  }

  return {
    version: DYNAMIC_BOUNDARY_SCHEMA_VERSION,
    totalSites,
    totalFiles: files.length,
    byKind: DYNAMIC_BOUNDARY_KINDS
      .filter(k => kindCounts.has(k))
      .map(k => ({ kind: k, count: kindCounts.get(k)! })),
    byLanguage: [...langCounts.entries()]
      .map(([language, v]) => ({ language, files: v.files, sites: v.sites }))
      .sort((a, b) => b.sites - a.sites || (a.language < b.language ? -1 : 1)),
    files: [...files].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0)),
  };
}
