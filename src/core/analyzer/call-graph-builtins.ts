/**
 * Callee-ignore tables & receiver predicates — extracted from `call-graph.ts`
 * (change: modularize-call-graph-builder; analyzer: StableCallGraphBarrel).
 *
 * Pure, dependency-free data + string predicates that the language extractors use
 * to decide whether a call target is language noise to drop (`isIgnoredCallee`) and
 * whether a member-call receiver denotes the enclosing object/class so it bypasses
 * the ignore filter (`isSelfReceiver`). The `*_IGNORED` tables stay private to this
 * module; only the two predicates are imported back by the extractors. These were
 * file-internal (never on `call-graph.ts`'s public surface), so they are not
 * re-exported — the public import surface is unchanged.
 */

// Builtins / stdlib names to ignore as call targets, partitioned BY LANGUAGE.
// This used to be one global set applied to every language, which dropped
// legitimate calls: a Java `repo.find(id)`, `list.contains(x)`, or
// `cache.remove(k)` vanished because `find`/`contains`/`remove` are C++ STL /
// Swift names. Each language now only ignores its own builtins; unknown
// languages fall back to the union (legacy behavior) — see isIgnoredCallee.

const PYTHON_IGNORED = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'bool', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'sum', 'min', 'max',
  'open', 'input', 'format', 'repr', 'id', 'hash', 'abs', 'round', 'pow',
  'super', 'object', 'property', 'staticmethod', 'classmethod',
  'assert', 'raise', 'return', 'yield', 'await', 'pass', 'del',
]);

const JS_IGNORED = new Set([
  'console', 'log', 'error', 'warn', 'JSON', 'parse', 'stringify',
  'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'Date',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'import', 'exports',
  'map', 'filter', 'reduce', 'forEach',
  // Node.js
  'readFile', 'writeFile', 'mkdir', 'join', 'resolve', 'basename', 'dirname',
  'existsSync', 'readFileSync', 'writeFileSync',
]);

const GO_IGNORED = new Set([
  'make', 'new', 'append', 'copy', 'delete', 'close', 'panic', 'recover',
  'println', 'printf', 'sprintf', 'errorf', 'fprintf', 'print',
]);

const RUST_IGNORED = new Set([
  'println', 'eprintln', 'format', 'vec', 'assert', 'unwrap', 'expect',
  'ok', 'err', 'some', 'none',
]);

const RUBY_IGNORED = new Set([
  'puts', 'print', 'p', 'raise', 'require', 'require_relative', 'include',
  'extend', 'attr_accessor', 'attr_reader', 'attr_writer',
]);

// JVM family (Java/Kotlin/Scala) + C# share these Object/print builtins. Note:
// generic collection methods (find/insert/remove/contains/size/...) are NOT
// ignored here — they are legitimate, frequently user-defined method names.
const JVM_IGNORED = new Set([
  'toString', 'equals', 'hashCode', 'getClass', 'println', 'printf', 'print',
]);

const SWIFT_IGNORED = new Set([
  'print', 'debugPrint', 'dump', 'fatalError', 'precondition', 'preconditionFailure',
  'assert', 'assertionFailure', 'withUnsafePointer', 'withUnsafeMutablePointer',
  'DispatchQueue', 'main', 'async', 'sync', 'append', 'remove', 'insert', 'contains',
  'map', 'filter', 'reduce', 'forEach', 'compactMap', 'flatMap', 'sorted', 'first', 'last',
]);

const CFAMILY_IGNORED = new Set([
  'cout', 'cin', 'cerr', 'endl', 'malloc', 'free', 'memcpy', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strcat', 'strcmp', 'sprintf', 'snprintf', 'fprintf', 'printf',
  'push_back', 'pop_back', 'emplace_back', 'begin', 'end', 'size', 'empty',
  'find', 'insert', 'erase', 'at', 'front', 'back', 'clear', 'reserve', 'resize',
  'make_shared', 'make_unique', 'move', 'forward', 'swap',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
]);

const IGNORED_BY_LANGUAGE: Record<string, Set<string>> = {
  Python: PYTHON_IGNORED,
  TypeScript: JS_IGNORED,
  JavaScript: JS_IGNORED,
  Go: GO_IGNORED,
  Rust: RUST_IGNORED,
  Ruby: RUBY_IGNORED,
  Java: JVM_IGNORED,
  Kotlin: JVM_IGNORED,
  Scala: JVM_IGNORED,
  'C#': JVM_IGNORED,
  Swift: SWIFT_IGNORED,
  'C++': CFAMILY_IGNORED,
  C: CFAMILY_IGNORED,
};

// Union of every language's set — the fallback for callers that pass no
// language (and languages without a dedicated set), preserving legacy behavior.
const ALL_IGNORED_CALLEES = new Set<string>(
  Object.values(IGNORED_BY_LANGUAGE).flatMap(s => Array.from(s))
);

/**
 * Returns true if the name should be skipped as a call target.
 * Pass the source `language` so only that language's builtins are ignored;
 * omit it (or pass an unmapped language) to fall back to the cross-language
 * union (legacy behavior).
 */
export function isIgnoredCallee(name: string, language?: string): boolean {
  // ALL_CAPS names (3+ chars) are almost certainly C/C++ macros (or constants),
  // not function calls — skip regardless of language.
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) return true;
  const set = language ? IGNORED_BY_LANGUAGE[language] : undefined;
  if (set) return set.has(name);
  if (ALL_IGNORED_CALLEES.has(name)) return true;
  return false;
}

/** Receivers that denote the enclosing object/class — a member call through one is
 *  an intra-object method call, not the arbitrary-receiver noise (`arr.map()`,
 *  `JSON.parse()`) the ignore-list targets. So `this.parse()` / `self.map()` must
 *  bypass the name-only ignore filter: the class may genuinely define that method,
 *  and the resolver will bind it (or drop it if not). */
const SELF_CALL_RECEIVERS: ReadonlySet<string> = new Set(['this', 'super', 'self', 'cls']);
export function isSelfReceiver(receiver: string | undefined): boolean {
  return receiver !== undefined && SELF_CALL_RECEIVERS.has(receiver);
}
