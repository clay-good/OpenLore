/**
 * Derivation of SCIP symbol monikers and language tags from OpenLore graph
 * nodes.
 *
 * SCIP symbols are formatted strings, not structured objects, per the grammar
 * documented at https://github.com/sourcegraph/scip/blob/main/docs/scip.md.
 * We emit global symbols of the form:
 *
 *   <scheme> ' ' <manager> ' ' <package-name> ' ' <version> <descriptors>
 *
 * where descriptors are `<repo-rel-path>/` (namespace) followed by
 * `<qualified-name>(<arity>).` (method). Example:
 *
 *   openlore npm openlore 2.0.2 `src/core/scip/index.ts`/exportScip(1).
 *
 * Identifiers containing characters outside the SCIP "simple identifier" set
 * are backtick-escaped (with embedded backticks doubled).
 */

import type { FunctionNode } from '../analyzer/call-graph.js';

/** Package coordinates that fill the SCIP `<package>` slot of every symbol. */
export interface PackageInfo {
  manager: string;
  name: string;
  version: string;
}

const SCHEME = 'openlore';

/** A simple identifier needs no escaping iff it matches this set entirely. */
const SIMPLE_IDENTIFIER = /^[A-Za-z0-9\-+$_]+$/;

/** Escape a name for use as a SCIP descriptor identifier. */
function escapeName(name: string): string {
  if (SIMPLE_IDENTIFIER.test(name)) return name;
  // Escaped identifier: wrap in backticks, double any embedded backticks.
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * Map an OpenLore language tag (see signature-extractor.ts) to the SCIP
 * `Language` enum name used as `Document.language`. Returns `''` for languages
 * SCIP has no value for (the caller records these for the export summary).
 */
export function scipLanguageName(openloreLanguage: string): string {
  switch (openloreLanguage) {
    case 'Python':
    case 'TypeScript':
    case 'JavaScript':
    case 'Go':
    case 'Rust':
    case 'Ruby':
    case 'Java':
    case 'Kotlin':
    case 'PHP':
    case 'Swift':
    case 'C':
      return openloreLanguage;
    case 'C++':
      return 'CPP';
    case 'C#':
      return 'CSharp';
    default:
      // 'unknown' and anything SCIP lacks an enum value for.
      return '';
  }
}

/** Fully-qualified name within a file: `Class.method` or bare `function`. */
export function qualifiedName(node: FunctionNode): string {
  return node.className ? `${node.className}.${node.name}` : node.name;
}

/** Index of the matching `)` for the `(` at `open`, or `-1` if unbalanced. */
function matchingClose(sig: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Does the `(` at `open` genuinely open `name`'s PARAMETER list — as opposed to a
 * call nested in an expression body (Ruby `def total; compute(5); end`, Scala
 * `def total = compute(5)`, a paren-less arrow's `g(a)`) or a Go method receiver
 * `(recv)`? A parameter list is `name(...)`: the token immediately before the `(`
 * is the symbol's OWN name (or, for operator methods, its operator). The one
 * exception is a lambda assigned to the symbol (`= (a) => …`), where the `(`
 * follows `=`/`>` and its matching `)` is followed by `=>`.
 */
function opensParamGroup(sig: string, open: number, name: string): boolean {
  let j = open - 1;
  while (j >= 0 && /\s/.test(sig[j])) j--;
  if (j < 0) return true; // signature is just "(...)" — that IS the param group
  // Identifier run ending at j: `save(` / `helper(`.
  let k = j;
  while (k >= 0 && /\w/.test(sig[k])) k--;
  if (k < j) return sig.slice(k + 1, j + 1) === name; // name(...) yes, helper(...) no
  // No identifier before `(` → an operator run (`+`, `<=>`) or punctuation (`=`, `:`).
  let m = j;
  while (m >= 0 && !/[\w\s()]/.test(sig[m])) m--;
  if (m < j && sig.slice(m + 1, j + 1) === name) return true; // operator method: +(x)
  // Punctuation-led (`= (`, `: (`): accept only an assigned lambda `(...) =>`.
  const close = matchingClose(sig, open);
  return close !== -1 && /^\s*=>/.test(sig.slice(close + 1));
}

/**
 * Index of the `(` that opens the PARAMETER group in a captured signature, or
 * `-1` when there is none.
 *
 * When the symbol's `name` is known, detection is NAME-ANCHORED: the first `(`
 * that {@link opensParamGroup} (i.e. `name(...)` or an assigned lambda). This
 * skips a Go method receiver (`func (recv) Name(params)` — the receiver `(` is
 * preceded by `func`, not the method name) AND, crucially, refuses to mistake a
 * call inside an expression body for the parameter list — e.g. Ruby
 * `def total; compute(5); end` or Scala `def total = compute(5)`, whose captured
 * signature includes the body. Without this the body leaks into the parameter
 * shape and the `stableId` stops being body-invariant (a body edit would flip it,
 * so a moved-and-edited symbol would read `orphaned` instead of `drifted`).
 *
 * When `name` is absent (bare unit-test calls) the legacy heuristic is used: the
 * first `(`, with a `language === 'Go'` gate to skip a `func (recv)` receiver.
 */
function parameterGroupStart(sig: string, language?: string, name?: string): number {
  const first = sig.indexOf('(');
  if (first === -1) return -1;
  if (name) {
    for (let i = first; i !== -1; i = sig.indexOf('(', i + 1)) {
      if (opensParamGroup(sig, i, name)) return i;
    }
    return -1; // a paren-less def whose body happens to contain '(' → no param group
  }
  // Legacy (no name): first '(', with the Go method receiver skip.
  if (language !== 'Go' || sig.slice(0, first).trim() !== 'func') return first;
  let depth = 0;
  for (let i = first; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) {
      const next = sig.indexOf('(', i + 1);
      return next; // -1 if a receiver-only form (no param group) — handled by callers
    }
  }
  return first; // unbalanced receiver — fall back to the first group
}

/**
 * Parameter count for a definition moniker. Prefer the analyzer's live-AST facts;
 * retain signature parsing for legacy/imported graphs that predate those facts.
 * A collapsed overload has no single truthful arity and therefore stays unknown.
 */
export function arityOf(node: FunctionNode): number | undefined {
  if (node.callArity?.overloaded) return undefined;
  if (node.callArity) {
    // SCIP disambiguates the declaration, so retain source-level receiver/rest
    // parameters even though invocation bounds intentionally exclude them.
    return node.callArity.total
      + node.callArity.implicitReceiverCount
      + (node.callArity.variadicParameterCount ?? (node.callArity.variadic ? 1 : 0));
  }
  const sig = node.signature;
  if (!sig) return undefined;
  const open = parameterGroupStart(sig, node.language, node.name);
  if (open === -1) return undefined;
  // Walk to the matching close paren, counting top-level commas.
  let depth = 0;
  let commas = 0;
  let sawContent = false;
  for (let i = open; i < sig.length; i++) {
    const ch = sig[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) commas++;
    else if (depth === 1 && !/\s/.test(ch)) sawContent = true;
  }
  if (!sawContent) return 0;
  return commas + 1;
}

/**
 * Build the SCIP symbol moniker string for a function node.
 *
 * `repoRelPath` must be the document's relative path (POSIX separators), the
 * same value used for the node's `Document.relative_path`.
 */
export function symbolMoniker(node: FunctionNode, repoRelPath: string, pkg: PackageInfo): string {
  const namespace = `${escapeName(repoRelPath)}/`;
  const arity = arityOf(node);
  const disambiguator = arity === undefined ? '' : String(arity);
  const method = `${escapeName(qualifiedName(node))}(${disambiguator}).`;
  return `${SCHEME} ${pkg.manager} ${pkg.name} ${pkg.version} ${namespace}${method}`;
}

/** Prefix marking a content-addressed stable id; never collides with a path-based
 *  `id` (which is `<filePath>::<name>` and contains no leading `sid:`). */
const STABLE_ID_PREFIX = 'sid:';

/**
 * Normalized signature shape: the balanced parenthesized parameter group only,
 * identifier removed, whitespace-collapsed (e.g. `(a: number, b: string)`).
 * Shared by {@link stableSymbolId} (overload disambiguator) and structural-diff's
 * rename-recovery heuristic, so both agree on one notion of "same shape".
 *
 * Deliberately bounded to the parameter list — it excludes everything *after* the
 * matching close paren, which matters for two reasons:
 *  - Leading modifiers/the name (a rename, `async`/`export`/visibility) and the
 *    trailing return type are NOT in the shape, so a change confined to those
 *    keeps a symbol's `stableId` and is reported as *modified*, not remove+add.
 *  - For expression-bodied arrows (`const f = (a) => a.length`) the analyzer's
 *    captured `signature` includes the body; bounding to the param group keeps the
 *    `stableId` BODY-INVARIANT — essential so a moved-and-edited symbol resolves as
 *    `drifted` (not `orphaned`) via its anchor's `stableId`.
 *
 * Pass the symbol's `name` (and `language`) so the parameter group is located by
 * {@link parameterGroupStart}: this skips a Go method receiver and refuses to
 * mistake a call inside an expression body (Ruby/Scala paren-less defs, paren-less
 * arrows) for the parameters — keeping the shape genuinely body-invariant. With no
 * `name` (bare unit-test calls) the legacy first-`(` heuristic is used.
 * Returns `''` when there is no parameter group.
 */
export function signatureShape(signature: string | undefined, language?: string, name?: string): string {
  if (!signature) return '';
  const open = parameterGroupStart(signature, language, name);
  if (open === -1) return '';
  // Walk to the matching close paren (tracking nesting), then slice the group.
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      return signature.slice(open, i + 1).replace(/\s+/g, ' ').trim();
    }
  }
  // Unbalanced (truncated capture) — take from '(' to end, normalized.
  return signature.slice(open).replace(/\s+/g, ' ').trim();
}

/** Per-segment-escaped qualified name: `Class.method` or bare `function`, each
 *  segment escaped independently (SCIP descriptors escape per segment, not the
 *  dotted whole). */
function escapedQualifiedName(node: FunctionNode): string {
  const base = escapeName(node.name);
  return node.className ? `${escapeName(node.className)}.${base}` : base;
}

/** True when a symbol name is a real, derivable descriptor — not anonymous, a
 *  synthetic module/test wildcard (`*`), or a generated `<...>` placeholder. */
function hasDerivableName(name: string | undefined): boolean {
  return !!name && name !== 'anonymous' && !name.includes('*') && !/^<.*>$/.test(name);
}

/**
 * Content-addressed, location-independent stable identity for a function symbol.
 * (change: add-content-addressed-stable-symbol-ids)
 *
 * A pure function of the symbol's OWN structure: the qualified name
 * (`Class.method` or bare function) plus the normalized {@link signatureShape}
 * (the parameter group). It deliberately excludes the repo-relative path that
 * {@link symbolMoniker} bakes into its namespace AND the function body, so a
 * symbol keeps its identity across a file rename/move and across body edits.
 *
 * A function id always carries a `(...)` parameter group (empty `()` when no
 * signature was captured), so it never collides with a {@link stableClassId} of
 * the same name (classes carry none).
 *
 * Because the id is content-only, two genuinely distinct symbols that share a
 * qualified name and parameter shape (homonyms) receive the SAME `stableId`. This
 * is intentional: the change never fabricates a position-dependent discriminator
 * (which a file rename/add/remove would silently flip). Consumers resolve a
 * `stableId` only when it identifies a UNIQUE symbol (see
 * `EdgeStore.getNodeByStableId`) and otherwise fall back rather than guess.
 *
 * Returns `undefined` for symbols with no derivable descriptor (anonymous or
 * synthetic), which keep only their path-based `id`.
 */
export function stableSymbolId(node: FunctionNode): string | undefined {
  if (!hasDerivableName(node.name)) return undefined;
  const shape = signatureShape(node.signature, node.language, node.name);
  return `${STABLE_ID_PREFIX}${escapedQualifiedName(node)}${shape || '()'}`;
}

/**
 * Stable id for a class symbol: the escaped class name only (a class has no
 * parameter group, so it never collides with a function's `sid:Name(...)`).
 * Returns `undefined` for synthetic module groupings and non-derivable names.
 * Like {@link stableSymbolId}, homonym classes share an id and resolve only when
 * unique.
 */
export function stableClassId(name: string, isModule?: boolean): string | undefined {
  if (isModule || !hasDerivableName(name)) return undefined;
  return `${STABLE_ID_PREFIX}${escapeName(name)}`;
}
