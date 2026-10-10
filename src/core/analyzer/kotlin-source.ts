/**
 * Kotlin source scanners for the import parser (issue #546).
 *
 * Dependency-free leaf. Both scanners are single-pass and linear. The mask is LENGTH-PRESERVING: an
 * offset or line number in the result is the same offset or line number in the input.
 */

/**
 * Return `content` with comments and string-literal text replaced by spaces, newlines kept.
 * Code inside a `${ … }` template expression is kept, because it is code. Nested block comments,
 * raw strings, character literals, and backtick identifiers are handled. An unterminated literal
 * or comment runs to the end of input.
 */
export function kotlinCodeMask(content: string): string {
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
    out[i] = c;
    i++;
  }
  return out.join('');
}

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

/** Longest modifier chain read before a declaration keyword. Bounds the backward walk. */
const MAX_MODIFIER_CHAIN = 16;
/** Longest declaration header (type parameters and receiver) scanned for its name. */
const MAX_HEADER_CHARS = 400;

/**
 * Modifiers and annotations written immediately before the keyword at `offset`. The chain must
 * begin a statement: in `class A(x: B) : B by inner\nclass C`, the word `inner` ends the previous
 * declaration and is not a modifier of `C`. A hand-written backward walk, not a regular
 * expression: it reads each character once, so a file of repeated modifiers stays linear.
 */
function leadingModifiers(top: string, offset: number): { modifiers: string[]; annotations: string[] } {
  const chain: Array<{ modifier?: string; annotation?: string; startsStatement: boolean }> = [];
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
      startsStatement: before === undefined || before === '\n' || before === ';' || before === '}',
    });
    end = start;
  }
  const first = chain.findIndex(link => link.startsStatement);
  const kept = first < 0 ? [] : chain.slice(first);
  return {
    modifiers: kept.flatMap(link => (link.modifier ? [link.modifier] : [])),
    annotations: kept.flatMap(link => (link.annotation ? [link.annotation] : [])),
  };
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

  const declarations: KotlinDeclaration[] = [];
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
  return { packageName, imports, declarations };
}

function unquoteDotted(path: string): string {
  return path.split('.').map(part => unquote(part.trim())).join('.');
}
