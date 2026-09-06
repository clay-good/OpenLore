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
 * Cost: no second parse — the walk runs over the tree the extractor already parsed, gated by a
 * substring pre-scan of the source. The gate is real but not free, and the honest figures are:
 * roughly 30% of this repository's TypeScript files trip it (the tokens `eval`, `require(`,
 * `import(` and `](` occur inside ordinary identifiers and CommonJS), and a triggered file costs
 * about 30% more extraction time than an untriggered one. An untriggered file pays only the
 * `indexOf` scans. Retained candidates are capped per file, so a generated dispatch table cannot
 * grow the payload that crosses the worker and fact-cache boundaries.
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
  /**
   * A static literal selector naming exactly ONE symbol, which the resolver nonetheless did not
   * bind to an edge. Its own reason because the alternative — folding it into
   * `unresolved-external` — states "resolves to no symbol" about a target that plainly does, which
   * is a false statement from the feature whose whole claim is honesty. This is the case the
   * sibling change `resolve-literal-reflective-dispatch` is built to recover.
   */
  'resolvable-but-unbound',
  /** A static literal selector that names more than one symbol; picking one would be a guess. */
  'ambiguous-target',
  /**
   * A static literal selector the record could not resolve because it was derived from ONE FILE —
   * the incremental watcher lane, which sees no repository-wide symbol table. Distinct from
   * `unresolved-external` so a single-file record never claims a repository-wide absence it did
   * not check.
   */
  'unresolved-in-file-scope',
] as const;

export type DynamicBoundaryRefusal = (typeof DYNAMIC_BOUNDARY_REFUSALS)[number];

/** Human phrasing for one refusal reason. */
export const DYNAMIC_BOUNDARY_REFUSAL_LABEL: Record<DynamicBoundaryRefusal, string> = {
  'no-static-target': 'the dispatch target is computed at runtime',
  'unresolved-external': 'the named target resolves to no symbol in this index',
  'resolvable-but-unbound': 'the named target resolves to one symbol, but no edge was bound to it',
  'ambiguous-target': 'the named target resolves to more than one symbol',
  'unresolved-in-file-scope': 'the named target was not resolved within this file, and no '
    + 'repository-wide lookup was performed for this record',
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
  /** The enclosing function's node id. Absent when no indexed symbol contains the construct. */
  symbolId?: string;
  /**
   * No indexed symbol contains this construct. Explicit, so an absent `symbolId` is never silently
   * ambiguous — but deliberately NOT called "module level", because the extractor cannot tell the
   * two apart and one of them would be a false statement.
   *
   * `findEnclosingFunction` maps an offset onto the nodes the language extractor emitted. A miss
   * means either the construct really is at module scope, OR it sits inside something that
   * extractor does not model — and the second case is common: OpenLore's Python extractor emits no
   * node for a dunder other than `__init__`, so every `getattr` inside `__eq__`, `__getstate__` or
   * `__init_subclass__` misses. Dogfooding found 23 such sites across two Python repositories, each
   * one asserting module scope from inside a function.
   *
   * Claiming module scope there would convert an UNKNOWN attribution into a confident false one,
   * inside the one feature whose premise is disclosing unknown rather than implying absent. So the
   * marker says only what is actually known: nothing in the index contains this.
   */
  unattributed?: true;
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
  /**
   * The EXACT number of constructs matched in this file, present on the first candidate only and
   * only when the retained list was capped. Keeps a file's reported scale true after the matcher
   * bounds what it carries across the worker and cache boundaries.
   */
  matchedTotal?: number;
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
   * Which ARGUMENT carries the dispatch selector, per rule name — `getattr(o, "run")` is index 1,
   * `send(:run)` is index 0. A rule absent from this table has no static selector to read, which is
   * the right answer for `eval`/`exec`/`Proxy`: the argument is code or an object, not a name.
   */
  selectorIndex?: Record<string, number>;
  /**
   * Rules that fire ONLY when the declared argument is not a static string literal. `import(spec)`
   * and `require(name)` are dynamic boundaries; `import('./known')` is an ordinary statically
   * resolvable import and must not be recorded. Keyed by callee name → the argument to inspect.
   */
  nonLiteralArg?: Record<string, { index: number; kind: DynamicBoundaryKind }>;
  /**
   * Rules that fire only when the call's RESULT IS INVOKED — `getattr(o, a)()` is a dispatch,
   * `getattr(o, a)` is an attribute read. Recording the read would caveat every conclusion in the
   * region on the strength of a dispatch that never happens; this module already excludes
   * `operator.attrgetter` for exactly that reason, and the same reasoning applies to the bare form.
   *
   * The declared cost is a false negative: `h = getattr(o, a)` followed later by `h()` is not
   * recorded. That is the module's stated bias, and it is the safer one — a false positive at a hub
   * propagates its caveat across every file the hub can name.
   */
  invokeOnlyKinds?: Record<string, DynamicBoundaryKind>;
  /**
   * Rules suppressed when the declared argument is a literal that cannot be a callable — `None`,
   * a number, a string. `setattr(self, "raw", None)` defines nothing dispatchable; it is
   * `self.raw = None` spelled reflectively.
   */
  nonCallableValueArg?: Record<string, number>;
  /**
   * Node types that, as the RECEIVER of a computed member call, mean the subscript is a type
   * expression rather than a dispatch table. See {@link isGenericSubscription}.
   */
  genericSubscriptReceiverPattern?: RegExp;
  /** Require a lowercase letter in the receiver, so SCREAMING_CASE constants stay dispatch tables. */
  genericSubscriptRequiresLowercase?: boolean;
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
      // `getattr` lives in `invokeOnlyKinds`: the bare form reads an attribute, it does not dispatch.
      setattr: 'metaprogrammed-definition',
      // `__import__` is handled by `nonLiteralArg`, not here: `__import__("os")` names its module
      // statically and is an ordinary resolvable import, so only a computed name is a boundary.
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
    selectorIndex: { getattr: 1, setattr: 1, import_module: 1, methodcaller: 0 },
    // `getattr` is an attribute READ unless its result is called.
    invokeOnlyKinds: { getattr: 'reflective-invoke' },
    // `setattr(o, "x", None)` is an assignment, not a definition.
    nonCallableValueArg: { setattr: 2 },
    // PEP 484 generic subscription — `ConfigAttribute[bool]("TESTING")` — parses as a subscript
    // call indistinguishable from `handlers[name]()`. All three of Flask's `computed-member` sites
    // were this. Narrowing on the receiver's casing is a documented false-negative trade: a
    // dispatch table named in PascalCase stops being recorded, which is the safe direction.
    genericSubscriptReceiverPattern: /^[A-Z][A-Za-z0-9_]*(\.[A-Z][A-Za-z0-9_]*)*$/,
    // A SCREAMING_CASE receiver is a module constant — `TABLE[action]()` is the dispatch table this
    // rule exists to catch, not a generic. Only a name carrying a lowercase letter reads as a type.
    genericSubscriptRequiresLowercase: true,
    nonLiteralArg: { __import__: { index: 0, kind: 'dynamic-import' } },
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
    selectorIndex: {
      send: 0, public_send: 0, __send__: 0, const_get: 0, instance_variable_get: 0,
      define_method: 0, define_singleton_method: 0,
    },
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
    selectorIndex: { call_user_func: 0, call_user_func_array: 0 },
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
    selectorIndex: { MethodByName: 0, FieldByName: 0 },
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
    selectorIndex: { getDeclaredMethod: 0, getMethod: 0, getBean: 0, forName: 0 },
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
    selectorIndex: { GetMethod: 0, GetService: 0, GetRequiredService: 0 },
    importStyle: 'jvm',
    importNodeTypes: ['using_directive'],
  },
};

/** How a language spells the import that binds a package name into a file. */
type ImportStyle = 'js' | 'python' | 'jvm' | 'go' | 'php';

/** Escape a package/namespace token for embedding in a `RegExp`. */
function escapeToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
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
    selectorIndex: { get: 1, apply: 1, defineProperty: 1, resolve: 0, make: 0 },
    // `import(spec)` / `require(name)` with a NON-literal specifier is the commonest dynamic import
    // in the substrate's own primary language, and it was silently absent: `import` is the callee of
    // a `call_expression`, matched by none of the other rule tables. With a LITERAL specifier it is
    // an ordinary statically resolvable import and is deliberately not recorded.
    nonLiteralArg: {
      import: { index: 0, kind: 'dynamic-import' },
      require: { index: 0, kind: 'dynamic-import' },
    },
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
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function literalValue(text: string): string | undefined {
  const t = text.trim();
  if (t.length === 0) return undefined;
  const inner = t.startsWith(':') ? t.slice(1)
    : ((t[0] === '"' || t[0] === "'" || t[0] === '`') && t.length >= 2 && t.endsWith(t[0]))
      ? t.slice(1, -1)
      // Ruby's `string_content` / TS's `string_fragment` arrive already unquoted.
      : t;
  // The identifier test applies to the UNQUOTED value too. Without it a quoted string is accepted
  // verbatim, so `eval("a + b")` would be reported as a dispatch to a symbol named `a + b`.
  return IDENTIFIER.test(inner) ? inner : undefined;
}

/**
 * The literal dispatch target of a call, read from the ARGUMENT POSITION the rule declares.
 * `getattr(o, "run")` → `run` (selector at index 1); `getattr(o, name)` → undefined.
 *
 * Positional on purpose. Scanning for "the first string anywhere in the arguments" reads the wrong
 * thing twice over: `getattr(o, name, "fallback")` would report the DEFAULT VALUE as the dispatch
 * target — turning a genuinely runtime-computed dispatch into a named one, with a refusal reason
 * about a symbol it never dispatches to — and `eval("a + b")` would report an arbitrary code string
 * as a target name. A rule with no declared selector position (`eval`, `exec`) has no literal
 * target at all, which is correct: there is nothing there to resolve.
 */
function literalTargetOf(
  source: string,
  call: DynamicBoundaryNode,
  spec: LanguageSpec,
  selectorIndex: number | undefined,
): string | undefined {
  if (selectorIndex === undefined) return undefined;
  const args = field(call, 'arguments') ?? childrenOf(call).find(c => /argument/.test(c.type));
  if (!args) return undefined;
  // Argument lists carry punctuation children in several grammars; count only real arguments.
  const actual = childrenOf(args).filter(c => c.type !== ',' && c.type !== '(' && c.type !== ')');
  const selector = actual[selectorIndex];
  if (!selector) return undefined;
  if (spec.literalTypes.includes(selector.type)) return literalValue(textOf(source, selector));
  // A quoted literal wraps its content in a child node in several grammars; look exactly one level
  // in, never across siblings.
  for (const c of childrenOf(selector)) {
    if (spec.literalTypes.includes(c.type)) return literalValue(textOf(source, c));
  }
  return undefined;
}

/** The dotted text of a call's callee (`Reflect.get`), or undefined when it is not a member access. */
function calleeText(source: string, call: DynamicBoundaryNode): string | undefined {
  // Java's `method_invocation` and its kin split the receiver and the method into separate
  // `object`/`name` fields rather than giving one dotted callee node, so `Class.forName(...)`
  // would otherwise read as a bare `forName` and no dotted rule could ever match it. Compose the
  // dotted text where the grammar splits it; every other grammar returns its callee node whole.
  const object = field(call, 'object');
  const name = field(call, 'name');
  if (object && name) {
    return `${textOf(source, object).trim()}.${textOf(source, name).trim()}`;
  }
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
  const atOffset = new Map<number, DynamicBoundaryCandidate>();
  const seen = new Set<number>();
  let matched = 0;
  const record = (
    kind: DynamicBoundaryKind,
    node: DynamicBoundaryNode,
    literalTarget?: string,
  ): void => {
    // One construct yields at most one candidate: a nested match (`getattr(o, x)()`) must not be
    // counted twice, and double-counting would inflate the density budget as well as the receipt.
    //
    // But a CHAINED reflective call — `m.getDeclaredMethod("run").invoke(o)`, the idiomatic
    // spelling in Java, C# and Go — puts the outer and inner calls at the same start offset, and
    // the walk is pre-order, so the outer one arrives first. The outer callee carries no selector,
    // so keeping it and discarding the inner would emit `no-static-target` — "the dispatch target
    // is computed at runtime" — about a target that is a string literal right there in the source.
    // A false statement, and one that also hides the literal from the sibling change built to
    // recover it. So a later match at the same offset does not merely lose: it donates the more
    // specific selector to the candidate already retained.
    if (seen.has(node.startIndex)) {
      const existing = atOffset.get(node.startIndex);
      if (existing && literalTarget && !existing.literalTarget) existing.literalTarget = literalTarget;
      return;
    }
    seen.add(node.startIndex);
    matched++;
    // Retained candidates are capped HERE, not at finalize. A generated dispatch table can carry
    // thousands, and every one of them would otherwise be structured-cloned out of an extraction
    // worker, held for the whole build, and JSON-serialized into a fact-cache row — megabytes per
    // file, for a set the artifact caps at fifty anyway. `matched` keeps the count exact so the
    // truncation receipt still reports the true scale.
    if (out.length >= DYNAMIC_BOUNDARY_SITE_CAP) return;
    const { evidence, truncated } = toEvidence(textOf(source, node));
    const candidate: DynamicBoundaryCandidate = {
      kind,
      line: node.startPosition.row + 1,
      startIndex: node.startIndex,
      evidence,
      ...(truncated ? { evidenceTruncated: true as const } : {}),
      ...(literalTarget ? { literalTarget } : {}),
    };
    out.push(candidate);
    atOffset.set(node.startIndex, candidate);
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
        if (!staticIndex && !isGenericSubscription(source, fn, spec)) record('computed-member', n);
      } else if (text) {
        // A dotted rule is checked first, on the FULL dotted text: `Reflect.get` must never be read
        // as a bare `get`.
        const dotted = spec.dottedKinds?.[text];
        // A `calleeKinds` rule fires on a bare call, on a self-like receiver, or — only where the
        // language declares the name on its universal base object — on any receiver.
        const bareApplies = !text.includes('.')
          || isSelfDotted(text)
          || !!spec.calleeKindsOnAnyReceiver;
        const bare = lastSegment(text);
        // 0. An invoke-only rule fires from the OUTER call, reading the inner call's selector:
        //    `getattr(o, a)()` dispatches, `getattr(o, a)` reads. Checked before every other rule
        //    so the inner call's own visit (which shares this offset) is already deduped away.
        if (fn && spec.callTypes.includes(fn.type) && spec.invokeOnlyKinds) {
          const innerName = lastSegment(calleeText(source, fn) ?? '');
          const innerKind = spec.invokeOnlyKinds[innerName];
          if (innerKind) {
            record(innerKind, n, literalTargetOf(source, fn, spec, spec.selectorIndex?.[innerName]));
            for (const c of childrenOf(n).reverse()) stack.push(c);
            continue;
          }
        }
        // 2. A rule that fires only on a NON-literal argument: `import(spec)` is a boundary,
        //    `import('./known')` is an ordinary statically resolvable import.
        const dyn = bareApplies ? spec.nonLiteralArg?.[bare] : undefined;
        const kind = dotted ?? (bareApplies ? spec.calleeKinds[bare] : undefined);
        // A rule whose declared value argument is a literal that cannot be a callable defines
        // nothing dispatchable — `setattr(self, "raw", None)` is `self.raw = None`.
        const nonCallableAt = bareApplies ? spec.nonCallableValueArg?.[bare] : undefined;
        const inert = nonCallableAt !== undefined
          && isNonCallableLiteral(source, n, spec, nonCallableAt);
        if (inert) {
          // Recognised and deliberately not recorded.
        } else if (dyn && !kind) {
          if (literalTargetOfAnyShape(source, n, spec, dyn.index) === undefined) record(dyn.kind, n);
        } else if (kind) {
          record(kind, n, literalTargetOf(source, n, spec, spec.selectorIndex?.[bare]));
        } else {
          // 2. Gated member rules — `.invoke(`, `.Call(`, `.getBean(` — which fire only when the
          //    file imports the framework that gives the name its reflective meaning.
          const method = lastSegment(text);
          const gate = gates.find(g => g.methods.includes(method));
          if (gate) {
            record(gate.kind, n, literalTargetOf(source, n, spec, spec.selectorIndex?.[method]));
          } else if (
            // 3. DI container resolution — grounded in a declared DI package import, never on the
            //    bare method name. `this.cache.get(key)` in a file with no DI import is not a site.
            diPresent && spec.diMethods?.includes(method) && text.includes('.')
          ) {
            record('container-resolution', n, literalTargetOf(source, n, spec, spec.selectorIndex?.[method]));
          }
        }
      }
    }

    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }

  out.sort((a, b) => a.startIndex - b.startIndex);
  // The exact match count rides on a candidate rather than the return type, so the fact-cache and
  // worker payloads stay plain arrays. It is stamped on EVERY retained candidate, not just the
  // first: a script container merges several lanes' candidate arrays, and the finalizer can drop a
  // candidate, so a count carried by one element alone is one array concatenation away from being
  // silently lost — and a lost count means an over-cap file quietly reports the capped length as
  // its true scale.
  if (matched > out.length) for (const c of out) c.matchedTotal = matched;
  return out;
}

/**
 * Is there ANY literal at the given argument position — quoted or not, identifier-shaped or not?
 * Distinct from {@link literalTargetOf}, which asks for a usable dispatch NAME. `import('./a/b')`
 * has a literal specifier (so it is statically resolvable and not a boundary) but no
 * identifier-shaped target, and conflating the two questions would record every static import.
 */
function literalTargetOfAnyShape(
  source: string,
  call: DynamicBoundaryNode,
  spec: LanguageSpec,
  selectorIndex: number,
): string | undefined {
  const args = field(call, 'arguments') ?? childrenOf(call).find(c => /argument/.test(c.type));
  if (!args) return undefined;
  const actual = childrenOf(args).filter(c => c.type !== ',' && c.type !== '(' && c.type !== ')');
  const selector = actual[selectorIndex];
  if (!selector) return undefined;
  if (spec.literalTypes.includes(selector.type)) return textOf(source, selector);
  for (const c of childrenOf(selector)) {
    if (spec.literalTypes.includes(c.type)) return textOf(source, c);
  }
  return undefined;
}

/**
 * Is this subscript a TYPE expression rather than a dispatch table?
 *
 * `ConfigAttribute[bool]("TESTING")` and `handlers[name]()` parse identically — a subscript in
 * callee position with an identifier index — and only types tell them apart, which a tree-sitter
 * walk does not have. The receiver's casing is the one syntactic signal available, and the trade is
 * declared: a dispatch table named in PascalCase stops being recorded. That is a false negative,
 * which is the direction this module always errs in.
 */
function isGenericSubscription(
  source: string,
  subscript: DynamicBoundaryNode,
  spec: LanguageSpec,
): boolean {
  if (!spec.genericSubscriptReceiverPattern) return false;
  const receiver = field(subscript, 'value') ?? field(subscript, 'object') ?? childrenOf(subscript)[0];
  if (!receiver) return false;
  const text = textOf(source, receiver).trim();
  if (!spec.genericSubscriptReceiverPattern.test(text)) return false;
  return !spec.genericSubscriptRequiresLowercase || /[a-z]/.test(text);
}

/**
 * Is the declared argument a literal that cannot be a callable? `None`/`null`, a number, a string,
 * a boolean. Used to suppress a "definition" rule whose value plainly defines no dispatch.
 */
function isNonCallableLiteral(
  source: string,
  call: DynamicBoundaryNode,
  spec: LanguageSpec,
  index: number,
): boolean {
  const args = field(call, 'arguments') ?? childrenOf(call).find(c => /argument/.test(c.type));
  if (!args) return false;
  const actual = childrenOf(args).filter(c => c.type !== ',' && c.type !== '(' && c.type !== ')');
  const value = actual[index];
  if (!value) return false;
  if (spec.literalTypes.includes(value.type)) return true;
  return /^(none|null|nil|true|false|-?\d[\d_.]*)$/i.test(textOf(source, value).trim());
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
/**
 * The synthesis rule a reflective-resolution edge carries. Declared here, next to the partition it
 * governs, so the recovering change (`resolve-literal-reflective-dispatch`) and the disclosing one
 * cannot drift apart on the name.
 *
 * Nothing emits it yet, which is the correct state: today's resolver really does bind no edge for
 * any of these constructs, so today every candidate becomes a site.
 */
export const REFLECTIVE_RESOLUTION_RULE = 'literal-reflective';

export interface ResolutionProbe {
  /**
   * True when the resolver emitted a REFLECTIVE-RESOLUTION edge for this construct — the candidate
   * is retracted.
   *
   * Gated on the synthesis rule, not on a position key, because a resolved edge carries no byte
   * offset and no column: a caller+line+name key cannot tell two calls apart, so in
   * `x = getattr(o, "run"); run()` the ordinary `run()` edge would erase the `getattr` site,
   * leaving neither an edge NOR a site — a silence indistinguishable from "no dynamic dispatch
   * here", which is the exact outcome this module exists to prevent. Only an edge the reflective
   * resolver itself produced means "the resolver followed this".
   */
  resolvedToEdge(candidate: { symbolId?: string; startIndex: number; literalTarget?: string }): boolean;
  /**
   * How many internal symbols carry this name: 0 → `unresolved-external`, 1 →
   * `resolvable-but-unbound`, >1 → `ambiguous-target`. `null` means the count could not be taken at
   * all — a single-file derivation with no repository-wide symbol table — which yields
   * `unresolved-in-file-scope` rather than a repository-wide claim the probe never checked.
   */
  countSymbolsNamed(name: string): number | null;
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
      const count = probe.countSymbolsNamed(c.literalTarget);
      refusal = count === null ? 'unresolved-in-file-scope'
        : count === 0 ? 'unresolved-external'
        : count === 1 ? 'resolvable-but-unbound'
        : 'ambiguous-target';
    }
    sites.push({
      line: c.line,
      kind: c.kind,
      refusal,
      ...(c.symbolId ? { symbolId: c.symbolId } : { unattributed: true as const }),
      evidence: c.evidence,
      ...(c.evidenceTruncated ? { evidenceTruncated: true as const } : {}),
    });
  }
  // Every site is returned, uncapped. Bounding belongs to `buildFileDynamicBoundary`, which is the
  // only place that can also RECORD the truncation — slicing here silently made `totalSites` and
  // `truncated` unreachable on every real pipeline path, so an over-cap file under-reported its own
  // scale with no receipt.
  sites.sort((a, b) => a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return sites;
}

/**
 * Build one file's record from its finalized sites, or `undefined` when it has none.
 *
 * `matchedTotal` is the count the MATCHER saw before it bounded what it carried; without it a file
 * with 800 reflective calls would report `sites: 50` and no truncation at all, because everything
 * downstream only ever sees the 50 that survived. The bound is disclosed at whichever layer
 * actually applied it.
 */
export function buildFileDynamicBoundary(
  filePath: string,
  language: string,
  allSites: DynamicBoundarySite[],
  matchedTotal?: number,
): FileDynamicBoundary | undefined {
  if (allSites.length === 0) return undefined;
  const sorted = [...allSites].sort(
    (a, b) => a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  const kept = sorted.slice(0, DYNAMIC_BOUNDARY_SITE_CAP);
  const total = Math.max(matchedTotal ?? 0, sorted.length);
  return {
    filePath,
    language,
    sites: kept,
    ...(total > kept.length ? { totalSites: total, truncated: true as const } : {}),
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
