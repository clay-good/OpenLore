/**
 * Normalized per-symbol content hashes (change: add-symbol-content-hashes).
 *
 * A symbol's hash is taken over the parse tree its extractor already built, never the raw bytes:
 * the pre-order stream of node types, leaf token texts, and open/close markers for every node the
 * symbol's span fully contains. Comments are left out, and whitespace between tokens never enters
 * the stream, so a re-indent, a rewrapped argument list, or a rewritten comment hashes identically.
 * The open/close markers keep the tree SHAPE in the stream, which is what makes this sound for
 * layout-significant languages: moving a Python statement out of an `if` block leaves the tokens
 * alone but changes the nesting, so it changes the hash.
 *
 * The same walk yields a RESIDUAL hash over everything no symbol span contains — imports,
 * module-level statements, class fields, decorators outside a span — and, separately, a LAYOUT: the
 * sequence of symbol spans and residual runs as they occur in the file. The two are kept apart on
 * purpose. If the residual carried a marker per span, adding or deleting one function would move it
 * and every other symbol in the file would read as changed; with the layout beside it, an added
 * symbol is just a new entry, while moving module-level code across a symbol (`main()` before
 * versus after a definition — a real difference in every language that executes a module top to
 * bottom) still shows up. Every non-comment token of the file lands in exactly one of the two, so two
 * revisions whose symbol hashes and residual hash all agree have the same non-comment tree. That is
 * the property a symbol-level changed-set rests on: a change can only hide from the per-symbol
 * hashes by showing up in the residual.
 *
 * Text a node owns but no child covers (a template literal's raw text in some grammars) is hashed
 * too: verbatim inside string-like nodes, where whitespace is content, and whitespace-collapsed
 * elsewhere. Text in comment syntax that changes how the file is built, parsed, or run — a shebang,
 * a Go pragma, a Ruby `frozen_string_literal` magic comment, an encoding cookie, `@ts-expect-error`,
 * `@jsx`, a lint or coverage pragma — is kept as a token rather than dropped; see
 * {@link DIRECTIVE_COMMENT} for the closed list and the limit it names.
 *
 * Hashing discipline matches `decisions/anchor.ts` `hashSpan` (sha256, first 16 hex characters),
 * but the hash is a different one: `hashSpan` is deliberately unnormalized and stays the freshness
 * baseline. Equality is the only comparison made on these hashes. There is no score or threshold.
 *
 * Computed only when a caller asks for it (see {@link withContentHashes}); a normal analyze never
 * pays for the walk.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, type Hash } from 'node:crypto';

/** The minimal parse-tree view the hash walk needs. Real tree-sitter nodes satisfy it. */
export interface HashTreeNode {
  type: string;
  startIndex: number;
  endIndex: number;
  childCount?: number;
  child?(i: number): HashTreeNode | null;
  children?: HashTreeNode[];
}

/** A symbol span to hash: an extracted function node's id and character range. */
export interface HashSpan {
  id: string;
  startIndex: number;
  endIndex: number;
}

/**
 * One top-level import statement, hashed on its own rather than into the residual. An import that is
 * purely ADDED — it takes a name that no other import bound — cannot change what the file's existing
 * symbols do, so hashing imports apart lets an ordinary "new import plus an edited function" diff
 * stay symbol-exact instead of collapsing the whole file. A removed or rewritten import DOES rebind
 * a name the existing symbols may use, and is a module-level change like any other.
 */
export interface ImportStatementHash {
  hash: string;
  /** Identifier texts inside the statement — an over-approximation of what it binds. */
  names: string[];
  /**
   * False when the statement binds nothing nameable, so it cannot be treated as purely additive: a
   * bare side-effect import (`import './polyfill'`), a Go blank import (`import _ "x"`), or a
   * WILDCARD (`from x import *`, `use x::*`, `import java.util.*`, `using namespace x`) — a wildcard
   * binds names this walk cannot enumerate, so it may shadow what the file's other symbols resolve.
   */
  binds: boolean;
}

/** Node types that are a language's import/use statement. */
const IMPORT_TYPE = /^(import|use|using|require)[_a-z]*$|_(import|use|using)_?[a-z]*$/i;

/** Languages whose import statement binds a name taken from the module path itself. */
const PATH_BOUND_IMPORT_LANGUAGES = new Set(['Go']);

/** A text that is exactly one identifier, nothing else. */
const IDENTIFIER_ONLY = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Why a file's residual hash could not be computed. */
export type ResidualUnavailableReason = 'invalid-span' | 'span-not-contiguous';

/** Per-file result: one hash per symbol (in input order) plus the residual. */
export interface FileContentHashes {
  /** One entry per input span, same order. Ids may repeat when an extractor emits a twin. */
  symbols: Array<{ id: string; hash: string }>;
  /**
   * Hash of every token outside every symbol span: imports, module-level statements, class bodies.
   * It carries no marker for the spans themselves, so adding or removing a symbol leaves it alone.
   */
  residual?: string;
  /** Top-level import statements, hashed individually and excluded from the residual and layout. */
  imports: ImportStatementHash[];
  /**
   * Identifiers named by module-level code and by the imports — the names the file's module level
   * could be binding or handing around (`const h = get;`, a handler table, a re-import of the same
   * name). Collected from the walk, so comments and layout never enter it, in every language the
   * walk covers. A string literal whose whole content is an identifier counts: a handler table keyed
   * by name is exactly the binding this evidence exists to catch.
   */
  residualNames: string[];
  /**
   * The file's shape: `T:<n>` for a run of `n` residual tokens, `S:<id>` for a run of one span's
   * tokens, `I:<hash>` for one import statement, in file order. Comparing two revisions' layouts projected onto the symbols they share
   * (dropping the other spans and summing the runs that then adjoin) is what detects a reordering,
   * or module-level code moving across a symbol — `main()` before a definition versus after it,
   * which no token or residual hash can see because the tokens themselves are identical.
   */
  layout: string[];
  /** Set when `residual` is absent. */
  residualUnavailable?: ResidualUnavailableReason;
}

const requested = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with content hashing switched on for every extraction it awaits. Scoped with
 * `AsyncLocalStorage` rather than a module flag, so a concurrent full build in the same process
 * (the MCP daemon) never starts hashing, and the worker-pool lane never sees it at all.
 */
export function withContentHashes<T>(fn: () => Promise<T>): Promise<T> {
  return requested.run(true, fn);
}

/** True inside {@link withContentHashes}. The extractors check this before walking. */
export function contentHashesRequested(): boolean {
  return requested.getStore() === true;
}

function hash16(h: Hash): string {
  return h.digest('hex').slice(0, 16);
}

/** Node types whose uncovered text is content (whitespace included), not layout. */
const STRING_LIKE = /string|template|heredoc|literal|regex|sigil|char|interpolat|raw_text|text/i;

/**
 * Comments that are not comments: text in comment syntax that changes how the file is built, parsed,
 * or run. They are hashed as code. The list is a closed, documented allowlist rather than a guess —
 * an unrecognized directive still hashes away, which is the one disclosed limit of this hash (a
 * language's own directive that is not listed here reads as a comment). Additions are cheap and
 * safe: keeping more text can only ever report a change that did not happen, never hide one.
 */
const DIRECTIVE_COMMENT: readonly RegExp[] = [
  /^#!/,                                              // shebang — chooses the interpreter
  /^\/\/(go:|export\s|extern\s|line\s)/,                // Go pragmas and cgo
  /^(\/\/|#)\s*\+build\b/,                             // legacy Go build tags
  /^\/\/\/\s*</,                                        // TypeScript triple-slash directives
  /@ts-(ignore|expect-error|nocheck|check)\b/,
  /@(jsx|jsxImportSource|jsxRuntime|flow)\b/,
  /eslint-(disable|enable)|^\/[/*]\s*eslint\s/,
  /prettier-ignore|@format\b|@formatter:(on|off)|clang-format (on|off)/,
  /@__PURE__|webpackChunkName|webpackIgnore|vite-ignore|@vite-ignore/,
  /(istanbul|c8|v8|coverage) ignore/,
  /NOLINT|noinspection\b|@SuppressWarnings/,
  /^#\s*(-\*-\s*coding|coding[:=]|encoding[:=])/,       // Python / Ruby encoding cookie
  /^#\s*frozen_string_literal\s*:/,                    // Ruby: literals become frozen
  /^#\s*(type:|noqa|pragma|pylint:|mypy:|ruff:|fmt:|nosec|rubocop:|shellcheck\b)/,
  /^#\s*(warn_indent|encoding)\s*:/,
];

function isDroppedComment(type: string, text: () => string): boolean {
  if (!type.toLowerCase().includes('comment')) return false;
  const body = text().trimStart();
  return !DIRECTIVE_COMMENT.some(rule => rule.test(body));
}

function childrenOf(n: HashTreeNode): HashTreeNode[] {
  if (typeof n.childCount === 'number' && typeof n.child === 'function') {
    const out: HashTreeNode[] = [];
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) out.push(c);
    }
    return out;
  }
  return n.children ?? [];
}

/** Length-framed token, so no two different token sequences concatenate to the same bytes. */
function frame(kind: string, a: string, b = ''): string {
  return `${kind}${a.length}:${a}${b.length}:${b}`;
}

interface Frame {
  node: HashTreeNode;
  kids: HashTreeNode[];
  next: number;
  prevEnd: number;
  stringLike: boolean;
  /** Indexes into `spans` that fully contain this node. */
  within: number[];
}

/**
 * Hash every span over `root`, and the residual. Iterative (never recursive): a deeply nested
 * expression must not overflow the stack. Deterministic: the same tree yields the same hashes.
 */
export function computeFileContentHashes(
  root: HashTreeNode,
  spans: readonly HashSpan[],
  content: string,
  /** Only {@link PATH_BOUND_IMPORT_LANGUAGES} is read: those bind an import by its module path. */
  language = '',
): FileContentHashes {
  const hashers = spans.map(() => createHash('sha256'));
  const residual = createHash('sha256');
  let residualUnavailable: ResidualUnavailableReason | undefined;
  if (spans.some(s => !(s.startIndex >= 0 && s.endIndex >= s.startIndex && s.endIndex <= content.length))) {
    residualUnavailable = 'invalid-span';
  }

  // Outermost-first order: earlier start, then the wider span, then id and input position.
  const outerFirst = spans.map((_, i) => i).sort((a, b) =>
    spans[a].startIndex - spans[b].startIndex ||
    spans[b].endIndex - spans[a].endIndex ||
    (spans[a].id < spans[b].id ? -1 : spans[a].id > spans[b].id ? 1 : 0) ||
    a - b);
  const rank = new Array<number>(spans.length);
  outerFirst.forEach((spanIndex, r) => { rank[spanIndex] = r; });
  let cursor = 0;
  let active: number[] = [];

  // Layout: the run structure of the file. `placed` catches a span whose tokens are interleaved with
  // residual tokens, which would make the two signals impossible to compare revision to revision.
  const placed = new Set<number>();
  const layout: string[] = [];
  const residualNames = new Set<string>();

  const containing = (n: HashTreeNode): number[] => {
    while (cursor < outerFirst.length && spans[outerFirst[cursor]].startIndex <= n.startIndex) active.push(outerFirst[cursor++]);
    active = active.filter(i => spans[i].endIndex >= n.startIndex);
    return active.filter(i => spans[i].startIndex <= n.startIndex && n.endIndex <= spans[i].endIndex);
  };

  /** An identifier a module-level token names, or a string literal that is exactly an identifier. */
  const noteResidualName = (type: string, text: string): void => {
    if (IDENTIFIER_ONLY.test(text) && /identifier|name/i.test(type)) { residualNames.add(text); return; }
    if (!/string|literal|char/i.test(type)) return;
    const unquoted = text.replace(/^['"`]|['"`]$/g, '');
    if (IDENTIFIER_ONLY.test(unquoted)) residualNames.add(unquoted);
  };

  const emit = (within: number[], token: string): void => {
    if (within.length === 0) {
      residual.update(token);
      const last = layout[layout.length - 1];
      if (last !== undefined && last.startsWith('T:')) layout[layout.length - 1] = `T:${Number(last.slice(2)) + 1}`;
      else layout.push('T:1');
      return;
    }
    for (const i of within) hashers[i].update(token);
  };

  /** A node fully inside a span whose parent is not: record where that span's run starts. */
  const markRun = (within: number[]): void => {
    const outer = within.reduce((best, i) => (rank[i] < rank[best] ? i : best), within[0]);
    const entry = `S:${spans[outer].id}`;
    if (layout[layout.length - 1] === entry) return;
    if (placed.has(outer)) residualUnavailable ??= 'span-not-contiguous';
    placed.add(outer);
    layout.push(entry);
  };

  const emitGap = (f: Frame, from: number, to: number): void => {
    if (to <= from) return;
    const raw = content.slice(from, to);
    const text = f.stringLike ? raw : raw.replace(/\s+/g, ' ').trim();
    if (text.length > 0) emit(f.within, frame('G', text));
  };

  const imports: ImportStatementHash[] = [];
  /** Hash one import statement on its own; its tokens never reach the residual or the layout. */
  const takeImport = (n: HashTreeNode): void => {
    const h = createHash('sha256');
    const names: string[] = [];
    const statementText = content.slice(n.startIndex, n.endIndex);
    // A wildcard binds names this walk cannot enumerate. `*` in an import statement is a wildcard in
    // every language that has one; C++'s `using namespace` is the same idea spelled without a star.
    let wildcard = statementText.includes('*') || /\busing\s+namespace\b/.test(statementText);
    // A blank binding (`import _ "net/http/pprof"`) exists ONLY to run the package's init: the
    // statement binds no usable name, whatever its module path says.
    let blank = false;
    const stack: HashTreeNode[] = [n];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const kids = childrenOf(cur);
      const text = content.slice(cur.startIndex, cur.endIndex);
      if (kids.length === 0) {
        if (isDroppedComment(cur.type, () => text)) continue;
        h.update(frame('L', cur.type, text));
        if (/wildcard|asterisk|glob/i.test(cur.type)) wildcard = true;
        if (text === '_') blank = true;
        else if (/identifier|name/i.test(cur.type) && IDENTIFIER_ONLY.test(text)) names.push(text);
        // Where a language binds an import by its module PATH — Go's `import "net/http"` binds
        // `http` — the string is the binding, and without this the additive-import rule could never
        // fire for that language at all. Elsewhere a bare string import (`import './polyfill'`)
        // binds nothing and only runs code, which must stay a module-level change.
        else if (PATH_BOUND_IMPORT_LANGUAGES.has(language) && /string|literal/i.test(cur.type)) {
          const segment = text.replace(/^['"`]|['"`]$/g, '').split('/').pop() ?? '';
          if (IDENTIFIER_ONLY.test(segment)) names.push(segment);
        }
        continue;
      }
      h.update(frame('(', cur.type));
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    for (const name of names) residualNames.add(name);
    const hash = hash16(h);
    // The statement's PLACE is recorded in the layout: an import that MOVES (across module-level
    // code, or past another import) is a real change, and it would otherwise be hashed nowhere.
    layout.push(`I:${hash}`);
    imports.push({ hash, names: [...new Set(names)].sort(), binds: !wildcard && !blank && names.length > 0 });
  };

  const stack: Frame[] = [];
  const enter = (n: HashTreeNode, parentWithin: number[]): void => {
    // A dropped comment takes its whole subtree with it (Rust doc comments have children).
    if (isDroppedComment(n.type, () => content.slice(n.startIndex, n.endIndex))) return;
    const kids = childrenOf(n);
    const within = containing(n);
    // A top-level import is hashed on its own (see {@link ImportStatementHash}).
    if (within.length === 0 && parentWithin.length === 0 && stack.length === 1 && IMPORT_TYPE.test(n.type)) {
      takeImport(n);
      return;
    }
    if (within.length > 0 && parentWithin.length === 0) markRun(within);
    if (kids.length === 0) {
      const text = content.slice(n.startIndex, n.endIndex);
      if (within.length === 0) noteResidualName(n.type, text);
      emit(within, frame('L', n.type, text));
      return;
    }
    emit(within, frame('(', n.type));
    stack.push({ node: n, kids, next: 0, prevEnd: n.startIndex, stringLike: STRING_LIKE.test(n.type), within });
  };

  enter(root, []);
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (f.next < f.kids.length) {
      const child = f.kids[f.next++];
      emitGap(f, f.prevEnd, child.startIndex);
      f.prevEnd = Math.max(f.prevEnd, child.endIndex);
      enter(child, f.within);
      continue;
    }
    emitGap(f, f.prevEnd, f.node.endIndex);
    emit(f.within, frame(')', f.node.type));
    stack.pop();
  }

  return {
    symbols: spans.map((s, i) => ({ id: s.id, hash: hash16(hashers[i]) })),
    layout,
    imports,
    residualNames: [...residualNames].sort(),
    ...(residualUnavailable ? { residualUnavailable } : { residual: hash16(residual) }),
  };
}
