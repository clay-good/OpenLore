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
 * module-level statements, class fields, decorators outside a span, and where each symbol sits
 * among them (an anonymous marker per span; the spans' order is returned beside it). Every non-comment token of the file lands in exactly one of the two, so two
 * revisions whose symbol hashes and residual hash all agree have the same non-comment tree. That is
 * the property a symbol-level changed-set rests on: a change can only hide from the per-symbol
 * hashes by showing up in the residual.
 *
 * Text a node owns but no child covers (a template literal's raw text in some grammars) is hashed
 * too: verbatim inside string-like nodes, where whitespace is content, and whitespace-collapsed
 * elsewhere. A directive comment that changes behavior (Go `//go:embed`, `//go:build`, cgo
 * `//export`) is kept as a token rather than dropped.
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

/** Why a file's residual hash could not be computed. */
export type ResidualUnavailableReason = 'invalid-span' | 'span-not-contiguous';

/** Per-file result: one hash per symbol (in input order) plus the residual. */
export interface FileContentHashes {
  /** One entry per input span, same order. Ids may repeat when an extractor emits a twin. */
  symbols: Array<{ id: string; hash: string }>;
  /**
   * Hash of everything outside every symbol span, with each span's position marked by an anonymous
   * placeholder. The placeholder carries no id, so renaming a symbol leaves the residual alone; the
   * order of the spans is reported separately in {@link order}.
   */
  residual?: string;
  /** Ids of the outermost spans in the order they occur in the file. */
  order: string[];
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

/** Go directive comments that change the build or the binary. They are code, not comments. */
const GO_DIRECTIVE = /^\/\/(go:|export\s|extern\s|line\s|\s*\+build)/;

function isDroppedComment(type: string, text: () => string, language: string): boolean {
  if (!type.toLowerCase().includes('comment')) return false;
  if (language === 'Go' && GO_DIRECTIVE.test(text())) return false;
  return true;
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
  language: string,
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

  // Residual placeholders: the last one written, and every span already given one.
  let lastPlaceholder = -1;
  let residualTokenSinceLast = true;
  const placed = new Set<number>();
  const order: string[] = [];

  const containing = (n: HashTreeNode): number[] => {
    while (cursor < outerFirst.length && spans[outerFirst[cursor]].startIndex <= n.startIndex) active.push(outerFirst[cursor++]);
    active = active.filter(i => spans[i].endIndex >= n.startIndex);
    return active.filter(i => spans[i].startIndex <= n.startIndex && n.endIndex <= spans[i].endIndex);
  };

  const emit = (within: number[], token: string): void => {
    if (within.length === 0) {
      residual.update(token);
      residualTokenSinceLast = true;
      return;
    }
    for (const i of within) hashers[i].update(token);
  };

  /** A node fully inside a span whose parent is not: mark the span's position in the residual. */
  const markRun = (within: number[]): void => {
    const outer = within.reduce((best, i) => (rank[i] < rank[best] ? i : best), within[0]);
    if (outer === lastPlaceholder && !residualTokenSinceLast) return;
    if (placed.has(outer)) residualUnavailable ??= 'span-not-contiguous';
    placed.add(outer);
    order.push(spans[outer].id);
    residual.update(frame('P', ''));
    lastPlaceholder = outer;
    residualTokenSinceLast = false;
  };

  const emitGap = (f: Frame, from: number, to: number): void => {
    if (to <= from) return;
    const raw = content.slice(from, to);
    const text = f.stringLike ? raw : raw.replace(/\s+/g, ' ').trim();
    if (text.length > 0) emit(f.within, frame('G', text));
  };

  const stack: Frame[] = [];
  const enter = (n: HashTreeNode, parentWithin: number[]): void => {
    // A dropped comment takes its whole subtree with it (Rust doc comments have children).
    if (isDroppedComment(n.type, () => content.slice(n.startIndex, n.endIndex), language)) return;
    const kids = childrenOf(n);
    const within = containing(n);
    if (within.length > 0 && parentWithin.length === 0) markRun(within);
    if (kids.length === 0) {
      emit(within, frame('L', n.type, content.slice(n.startIndex, n.endIndex)));
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
    order,
    ...(residualUnavailable ? { residualUnavailable } : { residual: hash16(residual) }),
  };
}
