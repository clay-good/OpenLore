/**
 * Kotlin source helpers shared by every Kotlin parse site
 * (change: harden-kotlin-grammar-currency, issue #546).
 *
 * Dependency-free leaf. Both functions are single-pass, linear, and LENGTH-PRESERVING: an offset
 * or line number in the result is the same offset or line number in the input.
 */

/** Longest modifier chain read before a declaration keyword. Bounds the backward walk. */
const MAX_MODIFIER_CHAIN = 16;
/** Longest declaration header (type parameters and receiver) scanned for its name. */
const MAX_HEADER_CHARS = 400;

/**
 * Return `content` with comments and string-literal text replaced by spaces, newlines kept.
 * Code inside a `${ … }` template expression is kept, because it is code (pass `'blank'` to blank
 * it too, for a rewrite that must not touch an expression inside a string). Nested block comments,
 * raw strings, character literals, and backtick identifiers are handled. An unterminated literal
 * or comment runs to the end of input.
 */
export function kotlinCodeMask(content: string, templateCode: 'keep' | 'blank' = 'keep'): string {
  const n = content.length;
  const out = new Array<string>(n);
  const blank = (i: number): void => { out[i] = content[i] === '\n' ? '\n' : ' '; };
  // Each frame is a string we are inside of: its closing delimiter, and the brace depth of the
  // template expression currently open in it (0 = in string text).
  const strings: Array<{ raw: boolean; depth: number }> = [];
  let i = 0;
  const inCode = (): boolean => strings.length === 0 || strings[strings.length - 1].depth > 0;

  while (i < n) {
    const c = content[i];
    const next = content[i + 1];
    if (!inCode()) {
      const frame = strings[strings.length - 1];
      if (frame.raw ? content.startsWith('"""', i) : c === '"') {
        let end = i + (frame.raw ? 3 : 1);
        // A raw string may end with extra quotes that belong to its text (`""""`).
        if (frame.raw) while (content[end] === '"') end++;
        for (; i < end; i++) blank(i);
        strings.pop();
        continue;
      }
      if (!frame.raw && c === '\\' && i + 1 < n) { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '$' && next === '{') { blank(i); blank(i + 1); i += 2; frame.depth = 1; continue; }
      blank(i); i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && content[i] !== '\n') { blank(i); i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 0;
      while (i < n) {
        if (content[i] === '/' && content[i + 1] === '*') { depth++; blank(i); blank(i + 1); i += 2; continue; }
        if (content[i] === '*' && content[i + 1] === '/') {
          depth--; blank(i); blank(i + 1); i += 2;
          if (depth === 0) break;
          continue;
        }
        blank(i); i++;
      }
      continue;
    }
    if (c === '"') {
      const raw = content.startsWith('"""', i);
      const width = raw ? 3 : 1;
      for (let k = 0; k < width; k++) blank(i + k);
      i += width;
      strings.push({ raw, depth: 0 });
      continue;
    }
    if (c === "'") {
      // Character literal: 'a', '\n', 'A'. Bounded so a stray quote cannot swallow the file.
      let end = i + 1;
      if (content[end] === '\\') end += 2;
      else end += 1;
      while (end < n && end < i + 8 && content[end] !== "'" && content[end] !== '\n') end++;
      if (content[end] === "'") { for (; i <= end; i++) blank(i); continue; }
      out[i] = c; i++;
      continue;
    }
    if (c === '`') {
      const end = content.indexOf('`', i + 1);
      const stop = end < 0 || content.slice(i, end).includes('\n') ? i : end;
      for (; i <= stop; i++) out[i] = content[i];
      continue;
    }
    if (strings.length > 0) {
      const frame = strings[strings.length - 1];
      if (c === '{') frame.depth++;
      else if (c === '}') {
        frame.depth--;
        if (frame.depth === 0) { blank(i); i++; continue; }
      }
    }
    out[i] = templateCode === 'blank' && strings.length > 0 ? (c === '\n' ? '\n' : ' ') : c;
    i++;
  }
  return out.join('');
}

/**
 * Stable Kotlin syntax that the pinned grammar reports as an error, rewritten to an equivalent
 * shape the grammar accepts. Each rewrite keeps the length and only touches code (never a comment
 * or a string), so every node offset still indexes the original source:
 *
 * - `fun interface X` → `    interface X`. The declaration is still an interface with the same
 *   members; only the functional-interface marker is hidden from the parser.
 * - `a..<b` → `a.. b`. The range still has the same two operands.
 * - `$$"…"` → `  "…"`. The literal is still one string with the same extent; only the
 *   multi-dollar prefix is hidden. (Its text may then show a `$name` as a template reference.
 *   No extractor reads a name out of a template reference.)
 *
 * - `class A { object B { … } }` on one line → `class A { object B { … };}`. The grammar needs a
 *   statement separator after a nested class-like body that is closed on the same line as its
 *   owner; the `;` replaces one blank and changes no declaration.
 *
 * A file that uses none of these forms is returned unchanged (same string instance).
 */
export function normalizeKotlinForParse(content: string): string {
  const nestedClose = /\}[ \t]+\}/.test(content);
  if (!content.includes('..<') && !content.includes('$$"') && !nestedClose && !/\bfun\s+interface\b/.test(content)) return content;
  const code = kotlinCodeMask(content);
  const chars = [...content];
  let changed = false;
  if (chars.length !== content.length) return content; // astral characters: offsets would not line up
  for (const m of code.matchAll(/\bfun(?=[ \t]{1,8}interface\b)/g)) {
    for (let k = 0; k < 3; k++) chars[m.index + k] = ' ';
    changed = true;
  }
  for (let at = code.indexOf('..<'); at >= 0; at = code.indexOf('..<', at + 3)) {
    chars[at + 2] = ' ';
    changed = true;
  }
  for (const m of code.matchAll(/\$\$+/g)) {
    if (content[m.index + m[0].length] !== '"') continue;
    for (let k = 0; k < m[0].length; k++) chars[m.index + k] = ' ';
    changed = true;
  }
  if (nestedClose) {
    // Template expressions are blanked here: `"${ x.let { it } }"` must stay as written.
    const plain = kotlinCodeMask(content, 'blank');
    const classLike: boolean[] = [];
    let statementStart = 0;
    for (let i = 0; i < plain.length; i++) {
      const c = plain[i];
      if (c === '{') {
        classLike.push(/\b(?:class|object|interface)\b/.test(plain.slice(Math.max(statementStart, i - MAX_HEADER_CHARS), i)));
        statementStart = i + 1;
      } else if (c === '}') {
        if (classLike.pop()) {
          let next = i + 1;
          while (plain[next] === ' ' || plain[next] === '\t') next++;
          if (next > i + 1 && plain[next] === '}') { chars[next - 1] = ';'; changed = true; }
        }
        statementStart = i + 1;
      } else if (c === ';' || c === '\n') {
        // A class header may span lines; only a `;` or a blank line ends the statement for sure.
        if (c === ';' || plain[i + 1] === '\n') statementStart = i + 1;
      }
    }
  }
  return changed ? chars.join('') : content;
}

// ── Package-level declarations (change: fix-kotlin-package-binding-soundness) ──────────────

export type KotlinDeclarationKind =
  | 'function' | 'property' | 'class' | 'interface' | 'object' | 'enum' | 'typealias';

export interface KotlinDeclaration {
  kind: KotlinDeclarationKind;
  /** Declared name, without backticks. */
  name: string;
  /** Receiver type of an extension function or property, as written, without `?`. */
  receiverType?: string;
  /** Modifiers written before the keyword (`private`, `suspend`, `expect`, `data`, `fun`, …). */
  modifiers: string[];
  /** Annotation names written before the keyword, without `@` or a use-site target. */
  annotations: string[];
  /** Offset of the declaring keyword (`fun`, `val`, `class`, …) in the source. */
  offset: number;
}

export interface KotlinImport {
  /** Fully qualified name; for `import a.b.*` the package `a.b`. */
  fqn: string;
  alias?: string;
  wildcard: boolean;
}

export interface KotlinFileHeader {
  /** Declared package; the empty string for the root package. */
  packageName: string;
  imports: KotlinImport[];
  /** Declarations at package level only. A member of a class or object is never listed. */
  declarations: KotlinDeclaration[];
}

/**
 * The Kotlin default-import packages (Kotlin language specification, "Default imports", JVM
 * target). A name they supply is external to the repository: a project symbol of the same simple
 * name binds only when the file imports it or shares its package.
 */
export const KOTLIN_DEFAULT_IMPORT_PACKAGES: readonly string[] = [
  'kotlin', 'kotlin.annotation', 'kotlin.collections', 'kotlin.comparisons', 'kotlin.io',
  'kotlin.ranges', 'kotlin.sequences', 'kotlin.text', 'java.lang', 'kotlin.jvm',
];

const KOTLIN_MODIFIERS: ReadonlySet<string> = new Set([
  'public', 'private', 'internal', 'protected', 'open', 'final', 'abstract', 'sealed', 'override',
  'suspend', 'inline', 'noinline', 'crossinline', 'tailrec', 'operator', 'infix', 'external',
  'expect', 'actual', 'const', 'lateinit', 'data', 'enum', 'annotation', 'value', 'inner',
  'companion', 'fun', 'vararg', 'reified',
]);

const KOTLIN_HARD_KEYWORDS: ReadonlySet<string> = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface',
  'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias',
  'typeof', 'val', 'var', 'when', 'while',
]);

const unquote = (name: string): string => (name.startsWith('`') ? name.slice(1, -1) : name);
const IDENT = '(?:`[^`\\n]+`|[A-Za-z_][A-Za-z0-9_]*)';
const IDENT_ONLY = new RegExp(`^${IDENT}$`);
const NAMED_TYPE = new RegExp(`^[ \\t]+(${IDENT})`);

/**
 * `mask` with every character inside `{…}`, `(…)`, or `[…]` blanked (the delimiters stay), so
 * what is left is exactly the text at package level.
 */
function topLevelText(mask: string): string {
  const out = new Array<string>(mask.length);
  let depth = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1);
    out[i] = depth === 0 || c === '\n' ? c : ' ';
    if (c === '{' || c === '(' || c === '[') depth++;
  }
  return out.join('');
}

/** Skip a balanced `<…>` type-parameter list that starts at `i`. `->` does not close a bracket. */
function skipAngles(text: string, i: number): number {
  if (text[i] !== '<') return i;
  let depth = 0;
  for (let j = i; j < text.length && j < i + 400; j++) {
    if (text[j] === '<') depth++;
    else if (text[j] === '>' && text[j - 1] !== '-') { depth--; if (depth === 0) return j + 1; }
    else if (text[j] === '\n' && depth === 0) break;
  }
  return i;
}

const skipSpace = (text: string, i: number): number => {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  return i;
};

/** Split `Receiver.name` at the last dot outside `<…>`. */
function splitReceiver(path: string): { receiverType?: string; name: string } {
  let depth = 0;
  let dot = -1;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '<') depth++;
    else if (c === '>' && path[i - 1] !== '-') depth--;
    else if (c === '`') { const end = path.indexOf('`', i + 1); if (end > i) i = end; }
    else if (c === '.' && depth === 0) dot = i;
  }
  if (dot < 0) return { name: path.trim() };
  const receiver = path.slice(0, dot).trim().replace(/\?$/, '').trim();
  return { receiverType: receiver || undefined, name: path.slice(dot + 1).trim() };
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';


/**
 * Modifiers and annotations written immediately before the keyword at `offset`. The chain must
 * begin a statement: in `class A(x: B) : B by inner\nclass C`, the word `inner` ends the previous
 * declaration and is not a modifier of `C`. A hand-written backward walk, not a regular
 * expression: it reads each character once, so a file of repeated modifiers stays linear.
 */
function leadingModifiers(top: string, offset: number): { modifiers: string[]; annotations: string[]; start: number } {
  const chain: Array<{ modifier?: string; annotation?: string; startsStatement: boolean; at: number }> = [];
  let end = offset;
  for (let guard = 0; guard < MAX_MODIFIER_CHAIN; guard++) {
    while (end > 0 && isBlank(top[end - 1])) end--;
    let start = end;
    // An annotation argument list was blanked by `topLevelText`, leaving `(   )`.
    if (top[start - 1] === ')') {
      let open = start - 2;
      while (open >= 0 && open > start - MAX_HEADER_CHARS && isBlank(top[open])) open--;
      if (top[open] !== '(') break;
      start = open;
      while (start > 0 && (top[start - 1] === ' ' || top[start - 1] === '\t')) start--;
    }
    const wordEnd = start;
    while (start > 0 && start > wordEnd - 120 && (isWordChar(top[start - 1]) || top[start - 1] === '.' || top[start - 1] === ':')) start--;
    if (start === wordEnd) break;
    const word = top.slice(start, wordEnd);
    const isAnnotation = top[start - 1] === '@';
    if (isAnnotation) start--;
    else if (wordEnd !== end || !KOTLIN_MODIFIERS.has(word)) break; // a `( )` belongs to an annotation only
    let lineStart = start;
    while (lineStart > 0 && (top[lineStart - 1] === ' ' || top[lineStart - 1] === '\t')) lineStart--;
    const before = top[lineStart - 1];
    chain.unshift({
      ...(isAnnotation ? { annotation: word.split(':').pop()!.split('.').pop()! } : { modifier: word }),
      startsStatement: before === undefined || before === '\n' || before === ';' || before === '}' || before === '{',
      at: start,
    });
    end = start;
  }
  const first = chain.findIndex(link => link.startsStatement);
  const kept = first < 0 ? [] : chain.slice(first);
  return {
    modifiers: kept.flatMap(link => (link.modifier ? [link.modifier] : [])),
    annotations: kept.flatMap(link => (link.annotation ? [link.annotation] : [])),
    start: kept[0]?.at ?? offset,
  };
}

/**
 * The declarations whose keyword is visible in `top` (text in which everything that is not at
 * declaration level was blanked). `start` is where the modifier and annotation chain begins.
 */
function readDeclarations(top: string): Array<KotlinDeclaration & { start: number }> {
  const declarations: Array<KotlinDeclaration & { start: number }> = [];
  const keywordRe = /(?<![\w.:@`$])(fun|val|var|class|interface|object|typealias)(?![\w`])/g;
  for (const m of top.matchAll(keywordRe)) {
    const keyword = m[1];
    const offset = m.index;
    let i = skipSpace(top, offset + keyword.length);
    const lead = leadingModifiers(top, offset);
    if (keyword === 'fun') {
      i = skipSpace(top, skipAngles(top, i));
      if (/^interface\b/.test(top.slice(i, i + 10))) continue; // `fun interface`: the `interface` match records it
      // A function-type receiver `(A) -> B.name(` starts with a blanked parenthesis pair.
      const header = top.slice(i, i + MAX_HEADER_CHARS);
      let paren = header.indexOf('(');
      if (paren === 0) {
        const close = header.indexOf(')');
        if (close < 0) continue;
        paren = header.indexOf('(', close);
      }
      if (paren < 0) continue;
      const path = header.slice(0, paren);
      if (!path.trim() || /[={};\n]/.test(path)) continue; // anonymous function, or not a declaration header
      const { receiverType, name } = splitReceiver(path);
      if (!IDENT_ONLY.test(name) || KOTLIN_HARD_KEYWORDS.has(name)) continue;
      declarations.push({ kind: 'function', name: unquote(name), ...(receiverType ? { receiverType } : {}), ...lead, offset });
      continue;
    }
    if (keyword === 'val' || keyword === 'var') {
      i = skipSpace(top, skipAngles(top, i));
      const rest = top.slice(i, i + 300);
      const end = rest.search(/[:=\n({]|[ \t]by\b/);
      const path = (end < 0 ? rest : rest.slice(0, end)).trim();
      if (!path) continue; // destructuring or malformed
      const { receiverType, name } = splitReceiver(path);
      if (!IDENT_ONLY.test(name) || KOTLIN_HARD_KEYWORDS.has(name)) continue;
      declarations.push({ kind: 'property', name: unquote(name), ...(receiverType ? { receiverType } : {}), ...lead, offset });
      continue;
    }
    const named = top.slice(offset + keyword.length, offset + keyword.length + 200).match(NAMED_TYPE);
    if (!named || KOTLIN_HARD_KEYWORDS.has(named[1])) continue; // `object : T { }`, `X::class`
    const kind: KotlinDeclarationKind = keyword === 'class'
      ? (lead.modifiers.includes('enum') ? 'enum' : 'class')
      : keyword as KotlinDeclarationKind;
    declarations.push({ kind, name: unquote(named[1]), ...lead, offset });
  }
  return declarations;
}

/**
 * Read the package, the imports, and the package-level declarations of a Kotlin file from its
 * text. Deterministic and linear; no parser is needed, so the synchronous import bridge can call
 * it. A declaration inside a class, object, function, or lambda is never returned.
 */
export function scanKotlinFile(content: string): KotlinFileHeader {
  const mask = kotlinCodeMask(content);
  const top = topLevelText(mask);
  const packageName = unquoteDotted(top.match(new RegExp(`^[ \\t]*package[ \\t]+((?:${IDENT})(?:[ \\t]*\\.[ \\t]*${IDENT})*)`, 'm'))?.[1] ?? '');

  const imports: KotlinImport[] = [];
  const importRe = new RegExp(
    `^[ \\t]*import[ \\t]+((?:${IDENT})(?:\\.${IDENT})*)(\\.\\*)?(?:[ \\t]+as[ \\t]+(${IDENT}))?[ \\t]*;?[ \\t]*$`, 'gm');
  for (const m of top.matchAll(importRe)) {
    imports.push({ fqn: unquoteDotted(m[1]), wildcard: !!m[2], ...(m[3] ? { alias: unquote(m[3]) } : {}) });
  }

  const declarations = readDeclarations(top).map(({ start: _start, ...declaration }) => declaration);
  return { packageName, imports, declarations };
}

function unquoteDotted(path: string): string {
  return path.split('.').map(part => unquote(part.trim())).join('.');
}

// ── Signatures and KDoc (change: fix-kotlin-signature-and-kdoc-fidelity) ─────────────────────

export type KotlinVisibility = 'public' | 'internal' | 'protected' | 'private';

export interface KotlinDeclaredParameter {
  name: string;
  type?: string;
  hasDefault?: true;
  isVararg?: true;
}

export interface KotlinDocTag { tag: string; name?: string; text: string }

export interface KotlinKdoc {
  /** The text before the first blank line or block tag. */
  summary: string;
  tags: KotlinDocTag[];
}

/** A declaration at package level or inside a class body, with its full header. */
export interface KotlinSignatureDeclaration {
  kind: KotlinDeclarationKind | 'constructor';
  name: string;
  /** Qualified owner class (`Outer.Inner`); undefined at package level. */
  owner?: string;
  /** What the innermost enclosing body is: a class, an interface, an object, or a companion object. */
  ownerKind?: KotlinOwnerKind;
  receiverType?: string;
  /** Modifiers other than visibility. */
  modifiers: string[];
  annotations: string[];
  visibility: KotlinVisibility;
  typeParameters: string[];
  /** Functions and constructors. */
  parameters?: KotlinDeclaredParameter[];
  /** Declared return type of a function, or declared type of a property. */
  type?: string;
  /** From the first annotation or modifier to the end of the declared type; never a body. */
  signature: string;
  kdoc?: KotlinKdoc;
  offset: number;
  line: number;
}

export type KotlinOwnerKind = 'class' | 'interface' | 'object' | 'companion';

const VISIBILITIES: ReadonlySet<string> = new Set(['public', 'internal', 'protected', 'private']);
const KDOC_NAMED_TAGS: ReadonlySet<string> = new Set(['param', 'property', 'throws', 'exception']);

/** Longest KDoc block and longest parameter list read. Both bound a scan. */
const MAX_KDOC_CHARS = 8000;
const MAX_PARAMETER_CHARS = 4000;

/**
 * Parse a KDoc block (slash, two stars, …, star, slash). The summary is the text before the first blank line or block tag;
 * `@param`, `@return`, `@throws`, `@receiver`, `@property`, `@see`, `@sample`, and any other
 * block tag are kept with their text.
 */
export function parseKdoc(block: string): KotlinKdoc | undefined {
  if (!block.startsWith('/**') || !block.endsWith('*/')) return undefined;
  const lines = block.slice(3, -2).split('\n').map(line => line.replace(/^[ \t]*\*?[ \t]?/, '').trimEnd());
  const summary: string[] = [];
  const tags: KotlinDocTag[] = [];
  let current: KotlinDocTag | undefined;
  let summaryDone = false;
  for (const line of lines) {
    const tag = line.match(/^@([A-Za-z]+)(?:[ \t]+(.*))?$/);
    if (tag) {
      summaryDone = true;
      const rest = (tag[2] ?? '').trim();
      if (KDOC_NAMED_TAGS.has(tag[1])) {
        const named = rest.match(/^(\[?[\w.]+\]?)(?:[ \t]+(.*))?$/);
        current = { tag: tag[1], ...(named ? { name: named[1].replace(/^\[|\]$/g, '') } : {}), text: (named?.[2] ?? (named ? '' : rest)).trim() };
      } else {
        current = { tag: tag[1], text: rest };
      }
      tags.push(current);
    } else if (current) {
      if (line.trim()) current.text = `${current.text} ${line.trim()}`.trim();
    } else if (!summaryDone) {
      if (line.trim() === '') { if (summary.length > 0) summaryDone = true; }
      else summary.push(line.trim());
    }
  }
  if (summary.length === 0 && tags.length === 0) return undefined;
  return { summary: summary.join(' '), tags };
}

/**
 * The KDoc of the declaration whose modifier chain starts at `chainStart` and whose keyword is at
 * `keywordOffset`. A KDoc block counts when it immediately precedes the chain, or sits between the
 * annotations and the keyword. A `//` comment and a plain block comment are not KDoc.
 */
export function kotlinKdocAt(content: string, chainStart: number, keywordOffset: number): KotlinKdoc | undefined {
  const inside = content.slice(chainStart, keywordOffset);
  const insideAt = inside.lastIndexOf('/**');
  if (insideAt >= 0) {
    const close = inside.indexOf('*/', insideAt + 3);
    if (close >= 0 && inside.slice(close + 2).trim() === '') return parseKdoc(inside.slice(insideAt, close + 2));
  }
  let end = chainStart;
  while (end > 0 && isBlank(content[end - 1])) end--;
  if (content[end - 1] !== '/' || content[end - 2] !== '*') return undefined;
  // Bounded: an unmatched closer must not send the search back to the start of the file.
  const windowStart = Math.max(0, end - MAX_KDOC_CHARS);
  const within = content.slice(windowStart, end - 2).lastIndexOf('/**');
  if (within < 0) return undefined;
  const open = windowStart + within;
  // The opener found must belong to this block: no other block closes in between.
  if (content.indexOf('*/', open + 3) !== end - 2) return undefined;
  return parseKdoc(content.slice(open, end));
}

/** Index of the bracket that closes the one at `open`, or -1 within `limit` characters. */
function matchClose(text: string, open: number, limit: number): number {
  let depth = 0;
  const end = Math.min(text.length, open + limit);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split at commas that are outside every bracket and every `<…>`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angle = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '<') angle++;
    else if (c === '>' && text[i - 1] !== '-' && angle > 0) angle--;
    else if (c === ',' && depth === 0 && angle === 0) { parts.push(text.slice(last, i)); last = i + 1; }
  }
  parts.push(text.slice(last));
  return parts.map(part => part.trim()).filter(Boolean);
}

/** Index of the first `=` that is an assignment, outside brackets; -1 when none. */
function assignmentIndex(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || (c === '>' && text[i - 1] !== '-')) depth = Math.max(0, depth - 1);
    else if (c === '=' && depth === 0 && text[i + 1] !== '=' && text[i - 1] !== '=' && text[i - 1] !== '!' && text[i - 1] !== '<' && text[i - 1] !== '>') return i;
  }
  return -1;
}

function parseParameters(list: string): KotlinDeclaredParameter[] {
  const out: KotlinDeclaredParameter[] = [];
  for (const part of splitTopLevel(list)) {
    const eq = assignmentIndex(part);
    const head = (eq < 0 ? part : part.slice(0, eq)).trim();
    const colon = head.indexOf(':');
    const left = (colon < 0 ? head : head.slice(0, colon)).trim();
    const name = left.split(/\s+/).pop() ?? '';
    if (!IDENT_ONLY.test(name)) continue;
    const type = colon < 0 ? '' : head.slice(colon + 1).replace(/\s+/g, ' ').trim();
    out.push({
      name: unquote(name),
      ...(type ? { type } : {}),
      ...(eq >= 0 ? { hasDefault: true as const } : {}),
      ...(/(?:^|\s)vararg\s/.test(`${left} `) ? { isVararg: true as const } : {}),
    });
  }
  return out;
}

/** Names of a `<T : Bound, reified R>` list that starts at `i`; empty when there is none. */
function typeParameterNames(text: string, i: number): string[] {
  const end = skipAngles(text, i);
  if (end === i) return [];
  return splitTopLevel(text.slice(i + 1, end - 1))
    .map(part => part.replace(/^(?:(?:reified|in|out)\s+|@\S+\s+)*/, '').split(/[\s:]/)[0])
    .filter(name => IDENT_ONLY.test(name));
}

/**
 * Read a declared type that starts at `from`, up to the first of: a body brace, an assignment,
 * a `where` clause, a property delegate, an accessor, or a line end that the type does not
 * continue over. Returns the type and the offset just after it.
 */
function readType(mask: string, from: number): { type: string; end: number } {
  let depth = 0;
  let i = from;
  const limit = Math.min(mask.length, from + MAX_HEADER_CHARS);
  for (; i < limit; i++) {
    const c = mask[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || (c === '>' && mask[i - 1] !== '-')) { if (depth === 0) break; depth--; }
    else if (depth > 0) continue;
    else if (c === '{' || c === '}' || c === ';' || c === ',') break;
    else if (c === '=' && mask[i + 1] !== '=') break;
    else if (c === '\n') {
      const ahead = mask.slice(i + 1, i + 80).trimStart();
      if (!/^(?:->|\.|&)/.test(ahead) && !/(?:->|[.,&])\s*$/.test(mask.slice(from, i))) break;
    } else if (/\s/.test(c) && /^\s+(?:where|by|get|set)\b/.test(mask.slice(i, i + 8))) break;
  }
  return { type: mask.slice(from, i).replace(/\s+/g, ' ').trim(), end: from + mask.slice(from, i).trimEnd().length };
}

/**
 * `mask` with everything blanked that is not at declaration level: text inside parentheses, and
 * inside any brace that is not a class body. `ownerAt` gives the qualified owner for an offset.
 */
function classLevelText(mask: string): {
  text: string;
  ownerAt: (offset: number) => string | undefined;
  ownerKindAt: (offset: number) => KotlinOwnerKind | undefined;
} {
  const out = new Array<string>(mask.length);
  const stack: Array<{ classBody: boolean; name?: string; kind?: KotlinOwnerKind; parens: number }> = [{ classBody: true, parens: 0 }];
  const events: Array<{ offset: number; owner: string | undefined; kind: KotlinOwnerKind | undefined }> = [];
  const innermostKind = (): KotlinOwnerKind | undefined => stack.at(-1)?.kind;
  let statementStart = 0;
  const visible = (): boolean => stack.every(frame => frame.classBody && frame.parens === 0);
  const owner = (): string | undefined => {
    const names = stack.flatMap(frame => (frame.name ? [frame.name] : []));
    return names.length > 0 ? names.join('.') : undefined;
  };
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    const top = stack[stack.length - 1];
    if (c === '{') {
      const wasVisible = visible();
      // The last declaration keyword of the statement decides what this brace opens.
      const header = wasVisible ? mask.slice(Math.max(statementStart, i - MAX_HEADER_CHARS), i) : '';
      let classBody = false;
      let name: string | undefined;
      let kind: KotlinOwnerKind | undefined;
      const keywords = [...headerKeywords(header)];
      // `class A private constructor(…) {`: the primary constructor keyword follows the class.
      const tail = keywords.at(-1);
      const beforeTail = keywords.at(-2);
      const last = tail?.keyword === 'constructor' && (beforeTail?.keyword === 'class' || beforeTail?.keyword === 'interface')
        ? beforeTail
        : tail;
      if (last && (last.keyword === 'class' || last.keyword === 'interface' || last.keyword === 'object')) {
        const named = header.slice(last.index + last.keyword.length).match(NAMED_TYPE);
        const companion = last.keyword === 'object' && /\bcompanion\s*$/.test(header.slice(0, last.index));
        if (named && !KOTLIN_HARD_KEYWORDS.has(named[1])) { classBody = true; if (!companion) name = unquote(named[1]); }
        else if (companion) classBody = true; // an unnamed companion: members belong to the class
        if (classBody) kind = companion ? 'companion' : last.keyword as KotlinOwnerKind;
      }
      out[i] = wasVisible ? c : ' ';
      stack.push({ classBody, ...(name ? { name } : {}), ...(kind ? { kind } : {}), parens: 0 });
      if (classBody) events.push({ offset: i, owner: owner(), kind: innermostKind() });
      statementStart = i + 1;
    } else if (c === '}') {
      if (stack.length > 1) {
        const closed = stack.pop()!;
        if (closed.classBody) events.push({ offset: i, owner: owner(), kind: innermostKind() });
      }
      out[i] = visible() ? c : ' ';
      statementStart = i + 1;
    } else if (c === '(' || c === '[') {
      out[i] = visible() ? c : ' ';
      top.parens++;
    } else if (c === ')' || c === ']') {
      top.parens = Math.max(0, top.parens - 1);
      out[i] = visible() ? c : ' ';
    } else {
      out[i] = c === '\n' || visible() ? c : ' ';
      if (c === ';' && top.parens === 0) statementStart = i + 1;
    }
  }
  const eventAt = (offset: number): { owner: string | undefined; kind: KotlinOwnerKind | undefined } | undefined => {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].offset <= offset) lo = mid + 1; else hi = mid; }
    return lo === 0 ? undefined : events[lo - 1];
  };
  return {
    text: out.join(''),
    ownerAt: offset => eventAt(offset)?.owner,
    ownerKindAt: offset => eventAt(offset)?.kind,
  };
}

/** Declaration keywords of a statement header that are outside parentheses. */
function* headerKeywords(header: string): Generator<{ keyword: string; index: number }> {
  let depth = 0;
  const re = /[()[\]]|(?<![\w.:@`$])(fun|val|var|class|interface|object|constructor|init|typealias)(?![\w`])/g;
  for (const m of header.matchAll(re)) {
    if (m[0] === '(' || m[0] === '[') depth++;
    else if (m[0] === ')' || m[0] === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0) yield { keyword: m[1], index: m.index };
  }
}

const normalizeHeader = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Render `annotations…` one per line, then the declaration header on one line. */
export function renderKotlinSignature(content: string, start: number, keywordOffset: number, end: number): string {
  const lead = content.slice(start, keywordOffset);
  const annotations: string[] = [];
  let rest = '';
  let i = 0;
  while (i < lead.length) {
    if (lead[i] === '@') {
      let j = i + 1;
      while (j < lead.length && /[\w.:]/.test(lead[j])) j++;
      let k = j;
      while (lead[k] === ' ' || lead[k] === '\t') k++;
      if (lead[k] === '(') { const close = matchClose(lead, k, MAX_PARAMETER_CHARS); j = close < 0 ? lead.length : close + 1; }
      annotations.push(normalizeHeader(lead.slice(i, j)));
      i = j;
    } else if (lead.startsWith('/*', i)) {
      const close = lead.indexOf('*/', i + 2);
      i = close < 0 ? lead.length : close + 2;
    } else if (lead.startsWith('//', i)) {
      const close = lead.indexOf('\n', i);
      i = close < 0 ? lead.length : close;
    } else { rest += lead[i]; i++; }
  }
  const header = normalizeHeader(`${rest} ${content.slice(keywordOffset, end)}`);
  return [...annotations, header].join('\n');
}

/**
 * Every declaration of a Kotlin file at package level or in a class body, with its exact header:
 * signature, parameters, declared type, type parameters, visibility, modifiers, and KDoc
 * (change: fix-kotlin-signature-and-kdoc-fidelity). A local declaration inside a function body, a
 * lambda, or an object expression is never returned. Linear in the size of the file.
 */
export function scanKotlinDeclarations(content: string): KotlinSignatureDeclaration[] {
  const mask = kotlinCodeMask(content);
  const { text, ownerAt, ownerKindAt } = classLevelText(mask);
  const out: KotlinSignatureDeclaration[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] <= offset) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const common = (declaration: KotlinDeclaration & { start: number }, owner: string | undefined) => {
    const visibility = (declaration.modifiers.find(m => VISIBILITIES.has(m)) ?? 'public') as KotlinVisibility;
    const kdoc = kotlinKdocAt(content, declaration.start, declaration.offset);
    const ownerKind = owner ? ownerKindAt(declaration.offset) : undefined;
    return {
      ...(owner ? { owner } : {}),
      ...(ownerKind ? { ownerKind } : {}),
      modifiers: declaration.modifiers.filter(m => !VISIBILITIES.has(m)),
      annotations: declaration.annotations,
      visibility,
      ...(kdoc ? { kdoc } : {}),
      offset: declaration.offset,
      line: lineOf(declaration.offset),
    };
  };

  for (const declaration of readDeclarations(text)) {
    const owner = ownerAt(declaration.offset);
    const { start, offset } = declaration;
    if (declaration.kind === 'function') {
      let i = skipSpace(mask, offset + 3);
      const typeParameters = typeParameterNames(mask, i);
      i = skipSpace(mask, skipAngles(mask, i));
      let open = mask.indexOf('(', i);
      if (open === i) { const close = matchClose(mask, open, MAX_PARAMETER_CHARS); open = close < 0 ? -1 : mask.indexOf('(', close); }
      const close = open < 0 ? -1 : matchClose(mask, open, MAX_PARAMETER_CHARS);
      if (close < 0) continue;
      let end = close + 1;
      let type: string | undefined;
      const afterParams = skipSpace(mask, end);
      if (mask[afterParams] === ':') { const read = readType(mask, afterParams + 1); if (read.type) { type = read.type; end = read.end; } }
      out.push({
        kind: 'function', name: declaration.name,
        ...(declaration.receiverType ? { receiverType: declaration.receiverType } : {}),
        ...common(declaration, owner),
        typeParameters,
        parameters: parseParameters(mask.slice(open + 1, close)),
        ...(type ? { type } : {}),
        signature: renderKotlinSignature(content, start, offset, end),
      });
    } else if (declaration.kind === 'property') {
      const nameAt = mask.indexOf(declaration.name, offset + 3);
      let end = nameAt < 0 ? offset + 3 : nameAt + declaration.name.length;
      if (mask[end] === '`') end++;
      let type: string | undefined;
      const after = skipSpace(mask, end);
      if (mask[after] === ':') { const read = readType(mask, after + 1); if (read.type) { type = read.type; end = read.end; } }
      out.push({
        kind: 'property', name: declaration.name,
        ...(declaration.receiverType ? { receiverType: declaration.receiverType } : {}),
        ...common(declaration, owner),
        typeParameters: [],
        ...(type ? { type } : {}),
        signature: renderKotlinSignature(content, start, offset, end),
      });
    } else {
      const keywordLength = declaration.kind === 'typealias' ? 9 : declaration.kind === 'interface' ? 9 : declaration.kind === 'object' ? 6 : 5;
      const nameAt = mask.indexOf(declaration.name, offset + keywordLength);
      let end = nameAt < 0 ? offset + keywordLength : nameAt + declaration.name.length;
      if (mask[end] === '`') end++;
      const typeParameters = typeParameterNames(mask, skipSpace(mask, end));
      end = skipAngles(mask, skipSpace(mask, end)) === skipSpace(mask, end) ? end : skipAngles(mask, skipSpace(mask, end));
      let type: string | undefined;
      // Primary constructor: optional modifiers and `constructor`, then the parameter list.
      const header = mask.slice(end, end + MAX_HEADER_CHARS);
      const constructorOpen = header.match(/^(?:\s+(?:@[\w.]+(?:\([^)]*\))?|public|internal|protected|private)\s*)*\s*(?:constructor\s*)?\(/);
      let constructorParameters: KotlinDeclaredParameter[] | undefined;
      if (constructorOpen && declaration.kind !== 'typealias' && declaration.kind !== 'object') {
        const open = end + constructorOpen[0].length - 1;
        const close = matchClose(mask, open, MAX_PARAMETER_CHARS);
        if (close >= 0) { constructorParameters = parseParameters(mask.slice(open + 1, close)); end = close + 1; }
      }
      if (declaration.kind === 'typealias') {
        const eq = mask.indexOf('=', end);
        if (eq >= 0 && eq < end + 80) { const read = readType(mask, eq + 1); type = read.type || undefined; end = read.end; }
      } else {
        // Supertypes are part of the header: `class A(x: Int) : Base(x), Iface`.
        const colon = skipSpace(mask, end);
        if (mask[colon] === ':') {
          let j = colon + 1;
          let depth = 0;
          for (; j < mask.length && j < colon + MAX_HEADER_CHARS; j++) {
            const c = mask[j];
            if (c === '(' || c === '<' || c === '[') depth++;
            else if (c === ')' || c === ']' || (c === '>' && mask[j - 1] !== '-')) depth = Math.max(0, depth - 1);
            else if (depth === 0 && (c === '{' || c === ';')) break;
            else if (depth === 0 && c === '\n' && !/[,:]\s*$/.test(mask.slice(colon, j)) && !/^\s*,/.test(mask.slice(j + 1, j + 40))) break;
          }
          end = colon + mask.slice(colon, j).trimEnd().length;
        }
      }
      const shared = common(declaration, owner);
      out.push({
        kind: declaration.kind, name: declaration.name, ...shared, typeParameters,
        ...(type ? { type } : {}),
        signature: renderKotlinSignature(content, start, offset, end),
      });
      if (constructorParameters) {
        out.push({
          kind: 'constructor', name: declaration.name, owner: owner ? `${owner}.${declaration.name}` : declaration.name,
          modifiers: [], annotations: [], visibility: 'public', typeParameters: [],
          parameters: constructorParameters,
          signature: `constructor(${constructorParameters.map(p => `${p.isVararg ? 'vararg ' : ''}${p.name}${p.type ? `: ${p.type}` : ''}`).join(', ')})`,
          offset: declaration.offset, line: shared.line,
        });
      }
    }
  }

  // Secondary constructors: `constructor(` at class level.
  for (const m of text.matchAll(/(?<![\w.:@`$])constructor(?=\s*\()/g)) {
    const owner = ownerAt(m.index);
    if (!owner) continue;
    const open = mask.indexOf('(', m.index);
    const close = matchClose(mask, open, MAX_PARAMETER_CHARS);
    if (close < 0) continue;
    // A primary constructor written with the keyword is already recorded with its class.
    if (/\b(?:class|interface)\b[^{};]*$/.test(text.slice(Math.max(0, m.index - MAX_HEADER_CHARS), m.index))) continue;
    const lead = leadingModifiers(text, m.index);
    out.push({
      kind: 'constructor', name: owner.split('.').pop()!, owner,
      modifiers: lead.modifiers.filter(x => !VISIBILITIES.has(x)), annotations: lead.annotations,
      visibility: (lead.modifiers.find(x => VISIBILITIES.has(x)) ?? 'public') as KotlinVisibility,
      typeParameters: [], parameters: parseParameters(mask.slice(open + 1, close)),
      signature: renderKotlinSignature(content, lead.start, m.index, close + 1),
      ...(kotlinKdocAt(content, lead.start, m.index) ? { kdoc: kotlinKdocAt(content, lead.start, m.index)! } : {}),
      offset: m.index, line: lineOf(m.index),
    });
  }
  return out.sort((a, b) => a.offset - b.offset || (a.kind === 'constructor' ? 1 : -1));
}

// ── Gradle source sets (change: add-kotlin-multiplatform-source-sets) ───────────────────────

const PLATFORM_PREFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^common/, 'common'], [/^jvm/, 'jvm'], [/^android/, 'android'], [/^(?:ios|tvos|watchos|macos|apple)/, 'apple'],
  [/^js/, 'js'], [/^wasm/, 'wasm'], [/^(?:linux|mingw|native)/, 'native'], [/^desktop/, 'jvm'],
];

/**
 * The Gradle source set of a file, read from its `src/<set>/kotlin/` or `src/<set>/java/` path,
 * and the platform that a standard Kotlin Multiplatform set name implies. A set name that is not
 * a standard one is recorded as written, with platform `unknown`. No Gradle file is read.
 */
export function kotlinSourceSet(filePath: string): { sourceSet: string; platform: string } | undefined {
  const set = filePath.match(/(?:^|\/)src\/([A-Za-z][A-Za-z0-9]*)\/(?:kotlin|java)\//)?.[1];
  if (!set) return undefined;
  const base = set.replace(/(?:Main|Test|UnitTest|InstrumentedTest)$/, '');
  const platform = base === set ? undefined : PLATFORM_PREFIXES.find(([re]) => re.test(base))?.[1];
  return { sourceSet: set, platform: platform ?? 'unknown' };
}
