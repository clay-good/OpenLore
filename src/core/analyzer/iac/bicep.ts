/**
 * Azure Bicep extraction (spec-07 deferred follow-up: add-bicep-iac-graph).
 *
 * Parser choice: a tolerant, hand-rolled Bicep block scanner rather than the
 * Bicep compiler or a tree-sitter grammar. Rationale (identical to the Terraform
 * HCL decision — see terraform.ts header): the compiler/grammar are heavy, native,
 * or .NET-bound build/install surfaces, and IaC extraction only needs declaration
 * boundaries + symbol-reference detection — not a full AST or type checker. A pure-JS
 * scanner keeps the dependency tree flat and install-clean, and is fully deterministic.
 * We never evaluate Bicep: no `bicep build`, no ARM emit, no Azure/registry access.
 *
 * Bicep resolves bare identifiers (`stg`, `location`) against a FLAT per-file symbol
 * table — there are no `var.`/`type.name` prefixes as in Terraform — so the same
 * symbolic name recurs across files. Addresses are therefore scoped by file
 * (`<filePath>::<symbol>`) and references resolve WITHIN the declaring file only. The
 * one legitimate cross-file edge is a local `module './x.bicep'`, handled explicitly.
 *
 * Edge direction is dependent → dependency (like the rest of IaC), so depth-1 callers
 * of a resource answer "every symbol that depends on this".
 */

import { dirname, posix as posixPath } from 'node:path';
import type { IacGraph, IacModule, IacReference, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string; language?: string }

type BicepKeyword = 'resource' | 'module' | 'param' | 'var' | 'output';

interface BicepDecl {
  keyword: BicepKeyword;
  symbol: string;
  /** Raw single-quoted content: resource type (`Microsoft.Foo/bar@2023-01-01`) or module path. */
  typeLiteral: string | null;
  existing: boolean;
  isLoop: boolean;
  startLine: number;
  endLine: number;
  headerLine: string;
  /** Value/body text after `=` (may be empty for a required `param`). */
  body: string;
  /** Enclosing resource symbol, for a nested child resource. */
  parentSymbol?: string;
  /** Absolute char offsets in the file (keyword start, value start, value end). */
  startOffset: number;
  bodyStartOffset: number;
  bodyEndOffset: number;
}

const KEYWORDS = new Set<string>(['resource', 'module', 'param', 'var', 'output']);

export function extractBicep(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  // filePath → resource addresses declared there, for local-module linking.
  const fileResources = new Map<string, IacResource[]>();
  const moduleLinks: Array<{ mod: IacModule; targetFile: string | null }> = [];

  for (const file of files) {
    const decls = scanDecls(file.content);
    // A parent resource's captured body includes its nested children verbatim; blank those
    // ranges so the parent never emits a (reversed) edge to its own child.
    const childrenByParent = new Map<string, BicepDecl[]>();
    for (const d of decls) {
      if (d.parentSymbol) {
        if (!childrenByParent.has(d.parentSymbol)) childrenByParent.set(d.parentSymbol, []);
        childrenByParent.get(d.parentSymbol)!.push(d);
      }
    }
    for (const d of decls) {
      const children = childrenByParent.get(d.symbol);
      if (children?.length) d.body = blankChildRanges(d, children);
    }
    const declaredSymbols = new Set(decls.map((d) => d.symbol));
    ingestFile(file.path, decls, declaredSymbols, graph, fileResources, moduleLinks);
  }

  // Link each local module → the resources declared in its target file (cross-file).
  for (const { mod, targetFile } of moduleLinks) {
    if (!targetFile) continue;
    const targets = fileResources.get(targetFile) ?? [];
    for (const t of targets) {
      graph.references.push({ fromAddress: mod.address, toAddress: t.address, kind: 'depends_on' });
      mod.members.push(t.address);
    }
  }

  return graph;
}

function ingestFile(
  filePath: string,
  decls: BicepDecl[],
  declaredSymbols: Set<string>,
  graph: IacGraph,
  fileResources: Map<string, IacResource[]>,
  moduleLinks: Array<{ mod: IacModule; targetFile: string | null }>,
): void {
  const addr = (symbol: string): string => `${filePath}::${symbol}`;
  const pushResource = (r: IacResource) => {
    graph.resources.push(r);
    if (r.kind === 'resource' || r.kind === 'data') {
      if (!fileResources.has(filePath)) fileResources.set(filePath, []);
      fileResources.get(filePath)!.push(r);
    }
  };

  for (const d of decls) {
    const address = addr(d.symbol);
    const loopNote = d.isLoop ? '  // (loop: single node)' : '';

    switch (d.keyword) {
      case 'resource': {
        const type = stripApiVersion(d.typeLiteral);
        pushResource({
          address,
          displayName: d.symbol,
          type,
          kind: d.existing ? 'data' : 'resource',
          filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          signature: d.headerLine + loopNote,
          language: 'Bicep',
        });
        // Structural parent (nested child resource) → child depends on parent.
        if (d.parentSymbol && declaredSymbols.has(d.parentSymbol)) {
          graph.references.push({ fromAddress: address, toAddress: addr(d.parentSymbol), kind: 'references', line: d.startLine });
        }
        addBodyRefs(address, d, filePath, declaredSymbols, graph);
        break;
      }
      case 'module': {
        const path = d.typeLiteral ?? '';
        const local = isLocalModulePath(path);
        const external = !!path && !local;
        pushResource({
          address,
          displayName: d.symbol,
          type: 'module',
          kind: 'module',
          filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          isExternal: external || undefined,
          signature: d.headerLine + loopNote,
          language: 'Bicep',
        });
        if (local) {
          const mod: IacModule = { address, displayName: d.symbol, type: 'module', filePath, language: 'Bicep', members: [] };
          graph.modules.push(mod);
          const targetFile = path
            ? posixPath.normalize(posixPath.join(dirname(filePath.replace(/\\/g, '/')), path))
            : null;
          moduleLinks.push({ mod, targetFile });
        }
        addBodyRefs(address, d, filePath, declaredSymbols, graph);
        break;
      }
      case 'param': {
        pushResource({
          address,
          displayName: d.symbol,
          type: 'parameter',
          kind: 'variable',
          filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          signature: d.headerLine,
          language: 'Bicep',
        });
        addBodyRefs(address, d, filePath, declaredSymbols, graph);
        break;
      }
      case 'var': {
        pushResource({
          address,
          displayName: d.symbol,
          type: 'variable',
          kind: 'value',
          filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          signature: d.headerLine,
          language: 'Bicep',
        });
        addBodyRefs(address, d, filePath, declaredSymbols, graph);
        break;
      }
      case 'output': {
        pushResource({
          address,
          displayName: d.symbol,
          type: 'output',
          kind: 'output',
          filePath,
          startLine: d.startLine,
          endLine: d.endLine,
          signature: d.headerLine,
          language: 'Bicep',
        });
        addBodyRefs(address, d, filePath, declaredSymbols, graph);
        break;
      }
    }
  }
}

/** Blank a parent's nested-child declaration ranges from its captured body text. */
function blankChildRanges(parent: BicepDecl, children: BicepDecl[]): string {
  let text = parent.body;
  for (const ch of children) {
    const s = ch.startOffset - parent.bodyStartOffset;
    const e = ch.bodyEndOffset - parent.bodyStartOffset;
    if (s >= 0 && e <= text.length && s < e) {
      text = text.slice(0, s) + ' '.repeat(e - s) + text.slice(e);
    }
  }
  return text;
}

/** `Microsoft.Storage/storageAccounts@2023-01-01` → `Microsoft.Storage/storageAccounts`. */
function stripApiVersion(typeLiteral: string | null): string {
  if (!typeLiteral) return 'resource';
  const at = typeLiteral.indexOf('@');
  return (at >= 0 ? typeLiteral.slice(0, at) : typeLiteral).trim() || 'resource';
}

/** A relative `./x.bicep`/`../x.bicep` or bare `*.bicep` is local; `br/…`/`ts/…` etc. are remote. */
function isLocalModulePath(path: string): boolean {
  if (!path) return false;
  if (/^(br|ts)[:/]/i.test(path)) return false; // registry / template-spec aliases
  if (path.startsWith('./') || path.startsWith('../')) return true;
  return /\.bicep$/i.test(path);
}

/**
 * Scan a declaration's value/body for references to same-file symbols and emit edges:
 * `dependsOn: [ … ]` → depends_on; every other bare symbol → references. Property keys,
 * function-call names, string text, and `.property` accessors are not references.
 */
function addBodyRefs(
  fromAddress: string,
  decl: BicepDecl,
  filePath: string,
  declaredSymbols: Set<string>,
  graph: IacGraph,
): void {
  const addr = (symbol: string): string => `${filePath}::${symbol}`;
  const seen = new Set<string>();
  const emit = (symbol: string, kind: IacReference['kind']) => {
    if (symbol === decl.symbol || !declaredSymbols.has(symbol)) return;
    const key = `${symbol}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    graph.references.push({ fromAddress, toAddress: addr(symbol), kind, line: decl.startLine });
  };

  // Mask strings/comments first so a `dependsOn:` (or any symbol) inside a comment or
  // string literal can never become a false edge.
  const masked = maskBicep(decl.body);

  // dependsOn: [ a, b ] — Bicep arrays may be comma- or newline-separated.
  const depMatch = masked.match(/(^|[^.\w])dependsOn\s*:\s*\[([\s\S]{0,20000}?)\]/);
  if (depMatch) {
    for (const sym of depMatch[2].matchAll(/[A-Za-z_]\w*/g)) emit(sym[0], 'depends_on');
  }
  // Remove the dependsOn array from the general scan so it isn't double-counted.
  const general = masked.replace(/(^|[^.\w])(dependsOn\s*:\s*)\[[\s\S]{0,20000}?\]/, (_m, p) => p + ' ');

  for (const sym of scanRefSymbols(general)) emit(sym, 'references');
}

/**
 * Candidate bare-symbol references in an already-masked value/body: identifiers that are
 * object property keys (`name:`) or `.property` accessors are excluded so only base symbols
 * remain. Input MUST already be `maskBicep`-ed.
 */
function scanRefSymbols(masked: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const start = m.index;
    const end = re.lastIndex;
    // Skip member-access `.property` (a single `.`), but NOT the spread operator `...sym`
    // (consecutive dots) — there `sym` is a real referenced symbol.
    let p = start - 1;
    while (p >= 0 && (masked[p] === ' ' || masked[p] === '\t')) p--;
    if (p >= 0 && masked[p] === '.' && !(p >= 1 && masked[p - 1] === '.')) continue;
    // Skip object property keys: an identifier followed by a single `:` that starts an object
    // entry (preceded by `{`, `[`, `,`, a newline, or start). Two cases are NOT keys: the
    // `::` nested-resource accessor (`vnet::subnet` — both sides are real refs), and a ternary
    // arm `c ? yes : no` (preceded by `?`).
    let q = end;
    while (q < masked.length && (masked[q] === ' ' || masked[q] === '\t')) q++;
    if (q < masked.length && masked[q] === ':' && masked[q + 1] !== ':') {
      const before = p < 0 ? '\n' : masked[p];
      if (before === '{' || before === '[' || before === ',' || before === '\n') continue;
    }
    out.push(m[0]);
  }
  return out;
}

/**
 * Blank comments and single/triple-quoted string literals (length-preserving) but keep
 * the text inside `${…}` interpolations, where real symbol references live.
 */
function maskBicep(s: string): string {
  const a = s.split('');
  const n = a.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (a[k] !== '\n') a[k] = ' ';
  };
  while (i < n) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      let j = i; while (j < n && s[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      let j = i + 2; while (j < n && !(s[j] === '*' && s[j + 1] === '/')) j++;
      j = Math.min(n, j + 2); blank(i, j); i = j; continue;
    }
    if (c === "'") {
      if (s.startsWith("'''", i)) {
        let j = i + 3; while (j < n && !s.startsWith("'''", j)) j++;
        j = Math.min(n, j + 3); blank(i, j); i = j; continue;
      }
      // Single-quoted: blank the quote chars and literal text, but leave ${…} expr text.
      a[i] = ' '; i++;
      while (i < n && s[i] !== "'") {
        if (s[i] === '\\') { a[i] = ' '; if (i + 1 < n) a[i + 1] = ' '; i += 2; continue; }
        if (s[i] === '$' && s[i + 1] === '{') {
          a[i] = ' '; a[i + 1] = ' '; i += 2; let d = 1;
          while (i < n && d > 0) {
            if (s[i] === '{') d++;
            else if (s[i] === '}') { d--; if (d === 0) { a[i] = ' '; i++; break; } }
            i++; // keep expression chars intact
          }
          continue;
        }
        a[i] = ' '; i++;
      }
      if (i < n) { a[i] = ' '; i++; } // closing quote
      continue;
    }
    i++;
  }
  return a.join('');
}

// ---------------------------------------------------------------------------
// Declaration scanner
// ---------------------------------------------------------------------------

/**
 * Scan a Bicep file for top-level and nested-resource declarations, tracking strings,
 * comments, interpolation, and bracket depth so a keyword inside a string/comment or a
 * `dependsOn` array is never mistaken for a declaration.
 */
function scanDecls(content: string): BicepDecl[] {
  const decls: BicepDecl[] = [];
  const n = content.length;
  let i = 0;
  let line = 1;
  let bracket = 0; // unmatched { + [ depth
  // Open resource bodies, for nested-child parent attribution.
  const resStack: Array<{ symbol: string; bodyBase: number }> = [];

  while (i < n) {
    const c = content[i];
    if (c === '\n') { line++; i++; continue; }

    const skipped = skipAtomic(content, i);
    if (skipped.next > i) { line += skipped.newlines; i = skipped.next; continue; }

    if (c === '{' || c === '[') { bracket++; i++; continue; }
    if (c === '}' || c === ']') {
      bracket--;
      while (resStack.length && bracket <= resStack[resStack.length - 1].bodyBase) resStack.pop();
      i++; continue;
    }

    // Identifier at a token boundary?
    const prev = i === 0 ? '\n' : content[i - 1];
    if (isIdentStart(c) && !isIdentChar(prev)) {
      const word = /^[A-Za-z_]\w*/.exec(content.slice(i, i + 32))![0];
      const allowed = bracket === 0 ? KEYWORDS.has(word) : word === 'resource';
      if (allowed) {
        const parsed = tryParseHeader(content, i, line, word as BicepKeyword);
        if (parsed) {
          parsed.decl.parentSymbol =
            word === 'resource' && resStack.length ? resStack[resStack.length - 1].symbol : undefined;
          decls.push(parsed.decl);
          if (word === 'resource' && parsed.hasBody) {
            resStack.push({ symbol: parsed.decl.symbol, bodyBase: bracket });
          }
          // Advance only past the header (`= `), so the main loop walks the body for
          // bracket depth + nested resources. The body text was captured already.
          line = parsed.afterHeaderLine;
          i = parsed.afterHeaderOffset;
          continue;
        }
      }
      // Not a declaration: skip the whole identifier.
      i += word.length;
      continue;
    }
    i++;
  }
  return decls;
}

interface ParsedHeader {
  decl: BicepDecl;
  afterHeaderOffset: number;
  afterHeaderLine: number;
  hasBody: boolean;
}

/** Parse a declaration header starting at the keyword; capture its value span as `body`. */
function tryParseHeader(content: string, kwStart: number, kwLine: number, keyword: BicepKeyword): ParsedHeader | null {
  const n = content.length;
  let i = kwStart + keyword.length;
  const line = kwLine;
  const eatSpace = () => { while (i < n && (content[i] === ' ' || content[i] === '\t')) i++; };

  eatSpace();
  // Symbol name.
  const symMatch = /^[A-Za-z_]\w*/.exec(content.slice(i, i + 64));
  if (!symMatch) return null;
  const symbol = symMatch[0];
  i += symbol.length;

  let typeLiteral: string | null = null;
  let existing = false;

  if (keyword === 'resource' || keyword === 'module') {
    eatSpace();
    if (content[i] !== "'") return null; // a real resource/module always has a 'type'/'path'
    const lit = readSingleQuoted(content, i);
    typeLiteral = lit.text;
    i = lit.next;
    if (keyword === 'resource') {
      eatSpace();
      if (/^existing\b/.test(content.slice(i, i + 16))) { existing = true; i += 'existing'.length; }
    }
  }

  // Find `=` on the same logical line (skip ws, type annotations for param/output, decorators-free).
  // For required `param x string` there is no `=`.
  let eqOffset = -1;
  let scan = i;
  let scanLine = line;
  while (scan < n) {
    const ch = content[scan];
    if (ch === '\n') break;
    const at = skipAtomic(content, scan);
    if (at.next > scan) { scanLine += at.newlines; scan = at.next; continue; }
    if (ch === '=' && content[scan + 1] !== '=' && content[scan - 1] !== '=' &&
        content[scan - 1] !== '!' && content[scan - 1] !== '<' && content[scan - 1] !== '>') {
      eqOffset = scan; break;
    }
    scan++;
  }

  const headerEndForLine = eqOffset >= 0 ? eqOffset : scan;
  const headerLine = content.slice(kwStart, headerEndForLine).replace(/\s+/g, ' ').trim();

  if (eqOffset < 0) {
    // Required param (no value). End at the line break.
    return {
      decl: {
        keyword, symbol, typeLiteral, existing, isLoop: false, startLine: kwLine, endLine: scanLine,
        headerLine, body: '', startOffset: kwStart, bodyStartOffset: scan, bodyEndOffset: scan,
      },
      afterHeaderOffset: scan,
      afterHeaderLine: scanLine,
      hasBody: false,
    };
  }

  // Capture the value span starting after `=`.
  const span = readValueSpan(content, eqOffset + 1, scanLine);
  const decl: BicepDecl = {
    keyword,
    symbol,
    typeLiteral,
    existing,
    isLoop: span.isLoop,
    startLine: kwLine,
    endLine: span.endLine,
    headerLine,
    body: span.text,
    startOffset: kwStart,
    bodyStartOffset: span.bodyStart,
    bodyEndOffset: span.endOffset,
  };
  return {
    decl,
    afterHeaderOffset: eqOffset + 1,
    afterHeaderLine: line, // body re-walked by main loop; line at '=' is on kwLine's logical line
    hasBody: span.hasBracketBody,
  };
}

interface ValueSpan { text: string; endLine: number; isLoop: boolean; hasBracketBody: boolean; bodyStart: number; endOffset: number; }

/**
 * Read a declaration value starting at `start`: a balanced `{…}`/`[…]` group (objects,
 * arrays, `[for …: {…}]`), or a single logical line for scalar/expression values.
 */
function readValueSpan(content: string, start: number, startLine: number): ValueSpan {
  const n = content.length;
  let i = start;
  let line = startLine;
  // Skip leading whitespace and newlines to the first value char.
  while (i < n && (content[i] === ' ' || content[i] === '\t' || content[i] === '\n')) {
    if (content[i] === '\n') line++;
    i++;
  }
  const valStart = i;
  const isLoop = /^\[\s*for\b/.test(content.slice(i, i + 16));
  const first = content[i];

  // Consume a balanced {…}/[…] group starting at `from`; returns its end offset + line.
  const consumeBalanced = (from: number, ln: number): { end: number; line: number } => {
    let j = from;
    let depth = 0;
    do {
      const ch = content[j];
      if (ch === '\n') { ln++; j++; continue; }
      const at = skipAtomic(content, j);
      if (at.next > j) { ln += at.newlines; j = at.next; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      j++;
    } while (j < n && depth > 0);
    return { end: j, line: ln };
  };

  if (first === '{' || first === '[') {
    const r = consumeBalanced(i, line);
    return { text: content.slice(valStart, r.end), endLine: r.line, isLoop, hasBracketBody: true, bodyStart: valStart, endOffset: r.end };
  }

  // Conditional declaration: `= if (cond) { … }` / `= if cond { … }`. The condition's
  // symbols are real dependencies (kept in the text), and the `{ … }` is a true body, so
  // nested child resources must get parent attribution — recognize it as a bracket body.
  if (/^if\b/.test(content.slice(i, i + 8))) {
    let j = i + 2;
    let ln = line;
    while (j < n && (content[j] === ' ' || content[j] === '\t' || content[j] === '\n')) { if (content[j] === '\n') ln++; j++; }
    if (content[j] === '(') {
      let d = 0;
      do {
        const ch = content[j];
        if (ch === '\n') { ln++; j++; continue; }
        const at = skipAtomic(content, j);
        if (at.next > j) { ln += at.newlines; j = at.next; continue; }
        if (ch === '(') d++; else if (ch === ')') d--;
        j++;
      } while (j < n && d > 0);
    }
    while (j < n && (content[j] === ' ' || content[j] === '\t' || content[j] === '\n')) { if (content[j] === '\n') ln++; j++; }
    if (content[j] === '{') {
      const r = consumeBalanced(j, ln);
      return { text: content.slice(valStart, r.end), endLine: r.line, isLoop: false, hasBracketBody: true, bodyStart: valStart, endOffset: r.end };
    }
  }

  // Scalar / expression value: consume to end of logical line at paren/bracket depth 0.
  let depth = 0;
  while (i < n) {
    const ch = content[i];
    if (ch === '\n' && depth <= 0) break;
    if (ch === '\n') { line++; i++; continue; }
    const at = skipAtomic(content, i);
    if (at.next > i) { line += at.newlines; i = at.next; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    i++;
  }
  return { text: content.slice(valStart, i), endLine: line, isLoop, hasBracketBody: false, bodyStart: valStart, endOffset: i };
}

/**
 * If `content[i]` begins a comment or string literal, return the index just past it and
 * how many newlines it spanned. Otherwise `{ next: i, newlines: 0 }`.
 */
function skipAtomic(content: string, i: number): { next: number; newlines: number } {
  const n = content.length;
  const c = content[i];
  let newlines = 0;
  if (c === '/' && content[i + 1] === '/') {
    let j = i; while (j < n && content[j] !== '\n') j++;
    return { next: j, newlines: 0 };
  }
  if (c === '/' && content[i + 1] === '*') {
    let j = i + 2;
    while (j < n && !(content[j] === '*' && content[j + 1] === '/')) { if (content[j] === '\n') newlines++; j++; }
    return { next: Math.min(n, j + 2), newlines };
  }
  if (c === "'") {
    if (content.startsWith("'''", i)) {
      let j = i + 3;
      while (j < n && !content.startsWith("'''", j)) { if (content[j] === '\n') newlines++; j++; }
      return { next: Math.min(n, j + 3), newlines };
    }
    let j = i + 1;
    while (j < n && content[j] !== "'") {
      if (content[j] === '\\') { j += 2; continue; }
      if (content[j] === '$' && content[j + 1] === '{') {
        j += 2; let d = 1;
        while (j < n && d > 0) { if (content[j] === '{') d++; else if (content[j] === '}') d--; else if (content[j] === '\n') newlines++; j++; }
        continue;
      }
      if (content[j] === '\n') newlines++;
      j++;
    }
    return { next: Math.min(n, j + 1), newlines };
  }
  return { next: i, newlines: 0 };
}

/** Read a single-quoted string literal starting at `i` (which is the opening quote). */
function readSingleQuoted(content: string, i: number): { text: string; next: number } {
  const n = content.length;
  let j = i + 1;
  let text = '';
  while (j < n && content[j] !== "'") {
    if (content[j] === '\\') { text += content[j + 1] ?? ''; j += 2; continue; }
    text += content[j];
    j++;
  }
  return { text, next: Math.min(n, j + 1) };
}

function isIdentStart(c: string): boolean { return /[A-Za-z_]/.test(c); }
function isIdentChar(c: string): boolean { return /[A-Za-z0-9_]/.test(c); }
