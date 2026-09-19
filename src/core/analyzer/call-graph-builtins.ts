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

// Elixir special forms and control-flow macros: ignored at any argument count, since no
// project function shadows them in practice. Deliberately NOT the union's generic names
// (`map`, `find`, `new`, `parse`, `delete`, …): Kernel does not define them, so in Elixir
// they are ordinary project functions. (issue #507)
const ELIXIR_IGNORED = new Set([
  'if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive',
  'quote', 'unquote', 'unquote_splicing', 'super', 'import', 'alias', 'require', 'use',
]);

// Kernel's auto-imported functions and macros, by arity. A module may define the same
// name at another arity (`def send(a, b, c)` beside Kernel's `send/2`) and call it bare,
// so a call is Kernel's only when its argument count is one of Kernel's.
const ELIXIR_KERNEL_ARITIES: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ['raise', [1, 2]], ['reraise', [2, 3]], ['throw', [1]], ['exit', [1]],
  ['send', [2]], ['spawn', [1, 3]], ['spawn_link', [1, 3]], ['spawn_monitor', [1, 3]],
  ['self', [0]], ['make_ref', [0]], ['apply', [2, 3]], ['node', [0, 1]],
  ['is_atom', [1]], ['is_binary', [1]], ['is_bitstring', [1]], ['is_boolean', [1]],
  ['is_exception', [1, 2]], ['is_float', [1]], ['is_function', [1, 2]], ['is_integer', [1]],
  ['is_list', [1]], ['is_map', [1]], ['is_map_key', [2]], ['is_nil', [1]], ['is_number', [1]],
  ['is_pid', [1]], ['is_port', [1]], ['is_reference', [1]], ['is_struct', [1, 2]], ['is_tuple', [1]],
  ['elem', [2]], ['put_elem', [3]], ['hd', [1]], ['tl', [1]], ['length', [1]],
  ['map_size', [1]], ['tuple_size', [1]], ['byte_size', [1]], ['bit_size', [1]], ['binary_part', [3]],
  ['div', [2]], ['rem', [2]], ['abs', [1]], ['round', [1]], ['trunc', [1]], ['floor', [1]], ['ceil', [1]],
  ['max', [2]], ['min', [2]], ['not', [1]],
  ['inspect', [1, 2]], ['to_string', [1]], ['to_charlist', [1]], ['struct', [1, 2]], ['struct!', [1, 2]],
  ['get_in', [2]], ['put_in', [2, 3]], ['update_in', [2, 3]], ['pop_in', [1, 2]], ['get_and_update_in', [2, 3]],
  ['then', [2]], ['tap', [2]], ['dbg', [0, 1, 2]], ['match?', [2]], ['binding', [0, 1]],
  ['var!', [1, 2]], ['destructure', [2]], ['function_exported?', [3]], ['macro_exported?', [3]],
]);

/**
 * Is a BARE Elixir call language noise? `arity` is the call's argument count, counting
 * the piped-in value of `x |> f()`. (issue #507)
 */
export function isIgnoredElixirCall(name: string, arity: number): boolean {
  return ELIXIR_IGNORED.has(name) || (ELIXIR_KERNEL_ARITIES.get(name)?.includes(arity) ?? false);
}

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
  Elixir: ELIXIR_IGNORED,
};

// Union of the legacy per-language sets — the fallback for callers that pass no
// language (and languages without a dedicated set), preserving legacy behavior.
// Listed explicitly rather than derived from IGNORED_BY_LANGUAGE, so adding a
// language's set never widens what those other callers drop.
const ALL_IGNORED_CALLEES = new Set<string>(
  [PYTHON_IGNORED, JS_IGNORED, GO_IGNORED, RUST_IGNORED, RUBY_IGNORED, JVM_IGNORED, SWIFT_IGNORED, CFAMILY_IGNORED]
    .flatMap(s => Array.from(s))
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
