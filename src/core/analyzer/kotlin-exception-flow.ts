/**
 * Kotlin exception facts (change: add-kotlin-error-propagation, issue #546).
 *
 * Kotlin has no checked exceptions, and `throw` and `try` are expressions. The result is a sound
 * lower bound, as for every other language: what cannot be decided from syntax is a disclosed
 * boundary, never a silent "no exception".
 */
import type Parser from 'tree-sitter';
import type { CallReceiver, CallSite, CatchHandler, FunctionExceptionFacts, ThrowSite, TryGuard } from './exception-flow.js';

type Node = Parser.SyntaxNode;

const DYNAMIC = '<dynamic>';

/**
 * Standard-library inline functions whose lambda argument runs as part of the enclosing function
 * body: scope functions, `use`, `synchronized`, `repeat`, and the eager collection operations.
 * A throw inside such a lambda escapes the enclosing function. Any other lambda is a nested
 * function: it may run later, or never.
 */
export const KOTLIN_INLINE_LAMBDA_CALLS: ReadonlySet<string> = new Set([
  'let', 'run', 'apply', 'also', 'with', 'takeIf', 'takeUnless', 'use', 'synchronized', 'repeat', 'runCatching',
  'forEach', 'forEachIndexed', 'onEach', 'map', 'mapIndexed', 'mapNotNull', 'flatMap', 'filter', 'filterNot',
  'filterIndexed', 'fold', 'reduce', 'any', 'all', 'none', 'count', 'sumOf', 'maxOf', 'minOf', 'first',
  'firstOrNull', 'last', 'lastOrNull', 'find', 'single', 'singleOrNull', 'associate', 'associateBy',
  'associateWith', 'groupBy', 'partition', 'sortedBy', 'sortedByDescending', 'takeWhile', 'dropWhile',
  'getOrElse', 'getOrPut', 'ifEmpty', 'ifBlank', 'buildList', 'buildMap', 'buildSet', 'buildString',
  'require', 'requireNotNull', 'check', 'checkNotNull', 'lazy',
]);

/** Standard-library contract calls and the exception each one throws. */
export const KOTLIN_CONTRACT_THROWS: Readonly<Record<string, string>> = {
  require: 'IllegalArgumentException',
  requireNotNull: 'IllegalArgumentException',
  check: 'IllegalStateException',
  checkNotNull: 'IllegalStateException',
  error: 'IllegalStateException',
  TODO: 'NotImplementedError',
};

export const KOTLIN_COROUTINE_BOUNDARY =
  'Kotlin coroutine cancellation and exceptions delivered through a Job, Deferred, or Flow are not modeled.';

const child = (node: Node, type: string): Node | undefined => node.namedChildren.find(c => c.type === type);

interface KotlinCall { name: string; receiverText?: string; lambdas: Node[] }

/** A call with its callee name, receiver, and lambda arguments (trailing or in parentheses). */
function callOf(node: Node): KotlinCall | undefined {
  if (node.type !== 'call_expression') return undefined;
  let callee = node.namedChildren[0];
  const lambdas: Node[] = [];
  const collect = (call: Node): void => {
    for (const suffix of call.namedChildren.filter(c => c.type === 'call_suffix')) {
      const annotated = child(suffix, 'annotated_lambda');
      const literal = annotated && child(annotated, 'lambda_literal');
      if (literal) lambdas.push(literal);
      for (const arg of child(suffix, 'value_arguments')?.namedChildren ?? []) {
        const value = arg.namedChildren.at(-1);
        if (value?.type === 'lambda_literal') lambdas.push(value);
      }
    }
  };
  collect(node);
  if (callee?.type === 'call_expression') { collect(callee); callee = callee.namedChildren[0]; }
  if (!callee) return undefined;
  if (callee.type === 'simple_identifier') return { name: callee.text, lambdas };
  if (callee.type === 'navigation_expression') {
    const suffix = callee.namedChildren.at(-1);
    const name = suffix?.type === 'navigation_suffix' ? child(suffix, 'simple_identifier') : undefined;
    if (name) return { name: name.text, receiverText: callee.namedChildren[0]?.text, lambdas };
  }
  return undefined;
}

function receiverKind(call: KotlinCall): CallReceiver {
  if (call.receiverText === undefined) return /^[A-Z]/.test(call.name) ? 'constructor' : 'none';
  if (/^(?:this|super)(?:@\w+)?$/.test(call.receiverText)) return 'self';
  if (/^this\s*\.\s*`?[A-Za-z_]\w*`?(?:!!)?$/.test(call.receiverText)) return 'self-field';
  return 'other';
}

/** The exception type name of a `catch (e: T)` block, and its parameter name. */
function catchOf(block: Node): { parameter?: string; type?: string } {
  const parameter = child(block, 'simple_identifier')?.text;
  const type = child(block, 'user_type')?.namedChildren.filter(c => c.type === 'type_identifier').at(-1)?.text;
  return { ...(parameter ? { parameter } : {}), ...(type ? { type } : {}) };
}

const isJump = (node: Node, keyword: string): boolean => node.type === 'jump_expression' && new RegExp(`^${keyword}\\b`).test(node.text);

/** Top-level statements of a block: a `throw` or `return` among them leaves the block for sure. */
function directStatements(block: Node | undefined): Node[] {
  const statements = block && (block.type === 'statements' ? block : child(block, 'statements'));
  return statements ? statements.namedChildren : [];
}

/**
 * Exception facts of the Kotlin function, constructor, accessor, or initializer whose source
 * regions are `spans`. A node may own several regions (a constructor owns its `init` blocks and
 * property initializers); each is walked.
 */
export function extractKotlinExceptionFacts(
  root: Node,
  spans: ReadonlyArray<{ start: number; end: number }>,
): FunctionExceptionFacts {
  const throwSites: Array<ThrowSite & { contractCallee?: string }> = [];
  const tryGuards: TryGuard[] = [];
  const rawCalls: Array<{ calleeName: string; line: number; index: number; receiver: CallReceiver }> = [];
  const boundaries = new Set<string>();
  let nestedThrows = 0;
  let assertions = 0;
  let unsafeCasts = 0;

  const smallestCovering = (start: number, end: number): Node => {
    let node: Node = root;
    for (;;) {
      const next = node.namedChildren.find(c => c.startIndex <= start && c.endIndex >= end);
      if (!next) return node;
      node = next;
    }
  };

  /** Count throws below a nested function; they are not this function's. */
  const countNestedThrows = (node: Node): void => {
    const stack: Node[] = [node];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (isJump(cur, 'throw')) nestedThrows++;
      for (const c of cur.namedChildren) stack.push(c);
    }
  };

  /** `@Throws(IOException::class)` on a declaration: declared escapes. */
  const declaredThrows = (declaration: Node): void => {
    const modifiers = child(declaration, 'modifiers');
    for (const annotation of modifiers?.namedChildren.filter(c => c.type === 'annotation') ?? []) {
      if (!/^@(?:[a-z]+:)?(?:kotlin\.(?:jvm\.)?)?Throws\b/.test(annotation.text)) continue;
      for (const m of annotation.text.matchAll(/([A-Z][A-Za-z0-9_]*)\s*::\s*class/g)) {
        throwSites.push({ type: m[1], line: annotation.startPosition.row + 1, index: annotation.startIndex, locallyHandled: false, source: 'throws_clause' });
      }
    }
  };

  // `depth` counts the functions entered: 0 outside any function (a file or a class body), 1
  // inside the function under analysis. A function met at depth 1 is a nested one.
  const walk = (node: Node, inline: ReadonlySet<number>, catchParameters: ReadonlyMap<string, string>, outerDepth: number): void => {
    const line = node.startPosition.row + 1;
    let depth = outerDepth;
    if (node.type === 'function_declaration' || node.type === 'anonymous_function') {
      if (depth >= 1) { countNestedThrows(node); return; }
      depth = 1;
      declaredThrows(node);
    } else if (depth >= 1 && (node.type === 'object_literal' || node.type === 'class_declaration' || node.type === 'object_declaration')) {
      countNestedThrows(node);
      return;
    } else if (node.type === 'lambda_literal' && !inline.has(node.startIndex)) {
      countNestedThrows(node);
      return;
    }

    if (isJump(node, 'throw')) {
      const operand = node.namedChildren[0];
      let type = DYNAMIC;
      if (operand?.type === 'call_expression') {
        const callee = operand.namedChildren[0];
        const name = callee?.type === 'simple_identifier' ? callee.text
          : callee?.type === 'navigation_expression' ? callee.namedChildren.at(-1)?.namedChildren.find(c => c.type === 'simple_identifier')?.text
            : undefined;
        if (name && /^[A-Z]/.test(name)) type = name;
      } else if (operand?.type === 'simple_identifier' && catchParameters.has(operand.text)) {
        // `throw e` inside `catch (e: T)` rethrows a `T`.
        type = catchParameters.get(operand.text)!;
      }
      throwSites.push({ type, line, index: node.startIndex, locallyHandled: false, source: 'throw' });
    } else if (node.type === 'try_expression') {
      const body = child(node, 'statements');
      const handlers: CatchHandler[] = [];
      const caughtTypes: string[] = [];
      let catchAll = false;
      let rethrows = false;
      const blocks = node.namedChildren.filter(c => c.type === 'catch_block');
      for (const block of blocks) {
        const { parameter, type } = catchOf(block);
        const all = type === undefined || type === 'Throwable';
        const clauseRethrows = directStatements(block).some(s => isJump(s, 'throw')
          && (s.namedChildren[0]?.type !== 'simple_identifier' || s.namedChildren[0].text === parameter));
        if (all) catchAll = true; else caughtTypes.push(type!);
        if (clauseRethrows) rethrows = true;
        handlers.push({ catchAll: all, caughtTypes: all ? [] : [type!], rethrows: clauseRethrows });
      }
      const finallyBlock = child(node, 'finally_block');
      const suppresses = !!finallyBlock && directStatements(finallyBlock).some(s => isJump(s, 'return') || isJump(s, 'throw'));
      if (finallyBlock) {
        boundaries.add(suppresses
          ? `Kotlin definitely abrupt finally suppresses try-body completion at line ${line}`
          : `Kotlin finally control transfer/effects are not modeled at line ${line}`);
      }
      const span = body ?? node;
      if (blocks.length > 0 || suppresses) {
        tryGuards.push({
          fromLine: span.startPosition.row + 1, toLine: span.endPosition.row + 1,
          fromIndex: span.startIndex, toIndex: span.endIndex,
          catchAll, caughtTypes: [...new Set(caughtTypes)], rethrows, handlers,
          ...(suppresses ? { suppresses: true } : {}),
        });
      }
      // Each catch body sees its own parameter for rethrow typing.
      for (const c of node.namedChildren) {
        if (c.type !== 'catch_block') { walk(c, inline, catchParameters, depth); continue; }
        const { parameter, type } = catchOf(c);
        const scoped = new Map(catchParameters);
        if (parameter && type) scoped.set(parameter, type);
        for (const inner of c.namedChildren) walk(inner, inline, scoped, depth);
      }
      return;
    } else if (node.type === 'postfix_expression' && node.text.endsWith('!!')) {
      assertions++;
    } else if (node.type === 'as_expression' && !/\bas\?/.test(node.text)) {
      unsafeCasts++;
    }

    let nextInline = inline;
    const call = callOf(node);
    if (call) {
      rawCalls.push({ calleeName: call.name, line, index: node.startIndex, receiver: receiverKind(call) });
      if (call.receiverText === undefined && KOTLIN_CONTRACT_THROWS[call.name]) {
        throwSites.push({ type: KOTLIN_CONTRACT_THROWS[call.name], line, index: node.startIndex, locallyHandled: false, source: 'throw', contractCallee: call.name });
      }
      if (KOTLIN_INLINE_LAMBDA_CALLS.has(call.name) && call.lambdas.length > 0) {
        nextInline = new Set([...inline, ...call.lambdas.map(l => l.startIndex)]);
      }
      if (call.name === 'runCatching') {
        // Everything thrown in the block is caught, unless the chain asks for it back.
        let top: Node = node;
        while (top.parent && (top.parent.type === 'navigation_expression' || top.parent.type === 'call_expression')) top = top.parent;
        const rethrown = /\.\s*getOrThrow\s*\(/.test(top.text.slice(node.endIndex - top.startIndex));
        for (const lambda of call.lambdas) {
          if (rethrown) continue;
          tryGuards.push({
            fromLine: lambda.startPosition.row + 1, toLine: lambda.endPosition.row + 1,
            fromIndex: lambda.startIndex, toIndex: lambda.endIndex,
            catchAll: true, caughtTypes: [], rethrows: false, handlers: [{ catchAll: true, caughtTypes: [], rethrows: false }],
          });
        }
      } else if (call.name === 'use' && call.lambdas.length > 0) {
        boundaries.add(`Kotlin use { } resource-cleanup exceptions are not modeled at line ${line}`);
      }
    }
    for (const c of node.namedChildren) walk(c, nextInline, catchParameters, depth);
  };

  for (const span of spans) {
    const start = smallestCovering(span.start, span.end);
    // A whole file or a class body is outside any function; a function node enters at depth 0
    // and becomes depth 1; any other region (an `init` block, an accessor, a property
    // initializer) is already the body under analysis.
    const outside = start.type === 'source_file' || start.type === 'class_body' || start.type === 'class_declaration'
      || start.type === 'object_declaration' || start.type === 'function_declaration' || start.type === 'anonymous_function';
    walk(start, new Set(), new Map(), outside ? 0 : 1);
  }

  const enclosing = (index: number): TryGuard[] =>
    tryGuards.filter(g => g.fromIndex <= index && index < g.toIndex).sort((a, b) => (a.toIndex - a.fromIndex) - (b.toIndex - b.fromIndex));
  const catches = (guard: TryGuard, type: string): boolean => {
    if (guard.suppresses) return true;
    const clauses = guard.handlers ?? [{ catchAll: guard.catchAll, caughtTypes: guard.caughtTypes, rethrows: guard.rethrows }];
    for (const clause of clauses) {
      if (clause.catchAll || clause.caughtTypes.includes(type)) return !clause.rethrows;
    }
    return false;
  };
  for (const site of throwSites) {
    if (site.source === 'throws_clause') continue;
    site.locallyHandled = enclosing(site.index).some(g => catches(g, site.type));
  }
  const callSites: CallSite[] = rawCalls.map(c => ({ calleeName: c.calleeName, line: c.line, receiver: c.receiver, guards: enclosing(c.index) }));

  if (nestedThrows > 0) boundaries.add(`${nestedThrows} throw(s) inside a stored lambda or nested function are not attributed to this function`);
  if (assertions > 0 || unsafeCasts > 0) {
    boundaries.add(`${assertions} non-null assertion(s) (!!) and ${unsafeCasts} unsafe cast(s) (as) may throw at run time; implicit runtime exceptions are not throw sites`);
  }
  return {
    language: 'Kotlin', supported: true, throwSites, tryGuards, callSites,
    dynamicThrowCount: throwSites.filter(t => t.type === DYNAMIC).length,
    boundaries: [...boundaries].sort(),
  };
}
