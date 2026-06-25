/**
 * Intra-procedural control-flow & data-flow overlay (spec: add-intraprocedural-cfg-dataflow-overlay).
 *
 * Builds, per function and purely from AST shape (no types, no inference, no LLM):
 *   1. a control-flow graph (CFG): basic blocks + the edges induced by branches,
 *      loops, early exits (return/break/continue/throw), computed while the parse
 *      tree is live (parse trees are freed before later analysis passes);
 *   2. a reaching-definitions (def-use) overlay over that CFG: a deterministic
 *      fixpoint producing data-dependence edges from each definition site to each
 *      use it reaches without an intervening reassignment.
 *
 * Every data-dependence edge carries a precision label: `exact` for a sound
 * local-scalar def-use, `may` for a conservatively over-approximated dependence
 * (object field, array/dict element, closure capture). The cross-call `may` hop
 * is synthesized by the value-level consumer, not here — this overlay is strictly
 * intra-procedural.
 *
 * The returned {@link FunctionCfg} holds ONLY primitive data (numbers, strings):
 * no AST node references survive the call, so it is WASM-tree-lifetime safe and
 * trivially serializable to the disposable SQLite store.
 *
 * Modeled on the Elixir `walk` closure precedent in call-graph.ts — the first
 * real statement-level AST visitor in the analyzer.
 */

/** Precision provenance of a single data-dependence edge. */
export type DataFlowPrecision = 'exact' | 'may';

/** Kind of a basic block, for branch/loop/exit classification. */
export type CfgBlockKind = 'entry' | 'exit' | 'normal' | 'branch' | 'loop' | 'merge';

/** Kind of a control-flow edge between two blocks. */
export type CfgEdgeKind = 'normal' | 'true' | 'false' | 'back' | 'exit';

export interface CfgBlock {
  /** Index into FunctionCfg.blocks; stable within one CFG. */
  id: number;
  kind: CfgBlockKind;
}

export interface CfgEdge {
  from: number;
  to: number;
  kind: CfgEdgeKind;
}

/**
 * A data-dependence (def-use) edge: the value assigned to `variable` at line
 * `defLine` reaches the read at line `useLine` without an intervening
 * reassignment. `precision` is a deterministic property of the analysis.
 */
export interface DefUseEdge {
  variable: string;
  defLine: number;
  useLine: number;
  precision: DataFlowPrecision;
  /**
   * When this use is the RHS of an assignment/declaration, the start line of the
   * variable it helps define. Lets a forward value slice chain through multi-line
   * initializers (e.g. `const ctx = {\n  x: p,\n}`) where the feeding use and the
   * resulting def sit on different physical lines. Absent for non-feeding uses.
   */
  useInDefLine?: number;
}

/** Compact per-function overlay record. Pure data — no AST nodes retained. */
export interface FunctionCfg {
  blocks: CfgBlock[];
  edges: CfgEdge[];
  /** Reaching-definitions def-use edges over the CFG. */
  defUse: DefUseEdge[];
  /** Parameter names, treated as definitions at function entry. */
  params: string[];
  /** 1-based line at which parameters are considered defined (function start). */
  paramLine: number;
}

// ============================================================================
// MINIMAL AST NODE SHAPE
// ============================================================================

/**
 * Structural subset of tree-sitter's SyntaxNode used by the visitor. Native
 * `Parser.SyntaxNode` satisfies this; keeping it minimal avoids coupling to the
 * concrete parser type and keeps the visitor testable.
 */
export interface CfgNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  namedChildren: CfgNode[];
  /** All children incl. anonymous tokens. Optional — the soft-loaded (spec-08)
   *  node interface exposes only namedChildren. */
  children?: CfgNode[];
  childForFieldName(field: string): CfgNode | null;
}

/**
 * Compare two AST nodes by source position. Native tree-sitter returns FRESH
 * wrapper objects for the same node depending on access path (`childForFieldName`
 * vs `namedChildren`), so `a === b` is unreliable and yields non-deterministic
 * results. A node is uniquely identified by its (startIndex, endIndex) span.
 */
function sameNode(a: CfgNode | null | undefined, b: CfgNode | null | undefined): boolean {
  return !!a && !!b && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

// ============================================================================
// PER-LANGUAGE GRAMMAR SPEC
// ============================================================================

interface CfgLangSpec {
  /** `if`-style branch node types. */
  ifTypes: Set<string>;
  /** Loop node types (while/for/range). */
  loopTypes: Set<string>;
  /** `try`/`catch`/`finally` node type (exception branch). */
  tryTypes: Set<string>;
  /** `switch`/`match` node type (multi-way branch). */
  switchTypes: Set<string>;
  /** Nested function/closure node types — not descended into as outer CFG; their
   *  free-variable reads become `may` (closure-capture) uses of the outer scope. */
  nestedFnTypes: Set<string>;
  /** True for C-style switch where a case without `break` falls into the next
   *  (TS/JS); false where each case auto-breaks (Go switch, Python match). */
  switchFallsThrough: boolean;
  /** True when nested `{ }` blocks introduce a new variable scope (TS/JS `let`/
   *  `const`, Go `:=`) — enables shadowing detection. False for Python (function
   *  scope; its shadowing comes from comprehensions/closures, handled separately). */
  blockScoped: boolean;
  /** Comprehension node types that introduce their own scope (Python). */
  comprehensionTypes: Set<string>;
  /** Early-exit statement node types. */
  returnTypes: Set<string>;
  breakTypes: Set<string>;
  continueTypes: Set<string>;
  throwTypes: Set<string>;
  /** Statement-container (compound) node types whose children are statements. */
  blockTypes: Set<string>;
  /** Plain assignment node types (target = value). */
  assignTypes: Set<string>;
  /** Augmented assignment node types (target op= value) — target is both use+def. */
  augAssignTypes: Set<string>;
  /** Declaration-with-initializer node types (e.g. variable_declarator, short_var_declaration). */
  declTypes: Set<string>;
  /** Container node types that wrap one or more declarations (e.g. lexical_declaration). */
  declContainerTypes: Set<string>;
  /** Field-access node types — a write/read through these is a `may` dependence. */
  memberTypes: Set<string>;
  /** Subscript/index node types — a write/read through these is a `may` dependence. */
  subscriptTypes: Set<string>;
  /** Pointer-dereference node types (C/C++ `*p`). A write through these (`*p = x`)
   *  mutates the pointee, not the pointer binding, so the base pointer is a *use*
   *  and the l-value is a `may` def — never an exact reassignment of `p`.
   *  Optional: only C/C++ have pointer-deref l-values. */
  derefTypes?: Set<string>;
  /** Identifier node type for variable names. */
  identTypes: Set<string>;
  /** Call-expression node types (used to skip the callee name as a use). */
  callTypes: Set<string>;
  /** Field name holding the callee/method name on a call node (so it is skipped
   *  as a use while the receiver/args are still read). 'function' for most; Java
   *  uses 'name', Ruby uses 'method'. */
  callNameField: string;
  /** Increment/decrement node types (`x++`/`x--`) — a combined use+def of the operand. */
  updateTypes: Set<string>;
  /** Field name for the condition of an if/loop, when present. */
  conditionField: string;
  /** Field names for an if's then / else branches. */
  consequenceField: string;
  alternativeField: string;
  /** Field name for a loop / function body. */
  bodyField: string;
  /** Field names for assignment left / right. */
  leftField: string;
  rightField: string;
  /** Field name for a function's parameter list. */
  paramsField: string;
}

const TS_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement', 'for_in_statement', 'do_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['switch_statement']),
  nestedFnTypes: new Set(['arrow_function', 'function_expression', 'function_declaration', 'generator_function', 'generator_function_declaration', 'method_definition']),
  switchFallsThrough: true,
  blockScoped: true,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['throw_statement']),
  blockTypes: new Set(['statement_block']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set(['augmented_assignment_expression']),
  declTypes: new Set(['variable_declarator']),
  declContainerTypes: new Set(['lexical_declaration', 'variable_declaration']),
  memberTypes: new Set(['member_expression']),
  subscriptTypes: new Set(['subscript_expression']),
  identTypes: new Set(['identifier', 'shorthand_property_identifier']),
  callTypes: new Set(['call_expression', 'new_expression']),
  callNameField: 'function',
  updateTypes: new Set(['update_expression']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const PY_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['match_statement']),
  nestedFnTypes: new Set(['lambda', 'function_definition']),
  switchFallsThrough: false,
  blockScoped: false,
  comprehensionTypes: new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['raise_statement']),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment']),
  augAssignTypes: new Set(['augmented_assignment']),
  declTypes: new Set([]),
  declContainerTypes: new Set([]),
  memberTypes: new Set(['attribute']),
  subscriptTypes: new Set(['subscript']),
  identTypes: new Set(['identifier']),
  callTypes: new Set(['call']),
  callNameField: 'function',
  updateTypes: new Set([]),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const GO_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['for_statement']),
  tryTypes: new Set([]),
  switchTypes: new Set(['expression_switch_statement', 'type_switch_statement']),
  nestedFnTypes: new Set(['func_literal', 'function_declaration', 'method_declaration']),
  switchFallsThrough: false,
  blockScoped: true,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set([]),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment_statement']),
  augAssignTypes: new Set([]),
  declTypes: new Set(['short_var_declaration', 'var_spec', 'const_spec']),
  declContainerTypes: new Set(['var_declaration', 'const_declaration']),
  memberTypes: new Set(['selector_expression']),
  subscriptTypes: new Set(['index_expression']),
  identTypes: new Set(['identifier', 'field_identifier']),
  callTypes: new Set(['call_expression']),
  callNameField: 'function',
  updateTypes: new Set(['inc_statement', 'dec_statement']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const JAVA_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement', 'enhanced_for_statement', 'do_statement']),
  tryTypes: new Set(['try_statement', 'try_with_resources_statement']),
  switchTypes: new Set(['switch_expression', 'switch_statement']),
  nestedFnTypes: new Set(['lambda_expression']),
  switchFallsThrough: true,
  blockScoped: true,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['throw_statement']),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set([]),
  declTypes: new Set(['variable_declarator']),
  declContainerTypes: new Set(['local_variable_declaration']),
  memberTypes: new Set(['field_access']),
  subscriptTypes: new Set(['array_access']),
  identTypes: new Set(['identifier']),
  callTypes: new Set(['method_invocation', 'object_creation_expression']),
  callNameField: 'name',
  updateTypes: new Set(['update_expression']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const CPP_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement', 'for_range_loop', 'do_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['switch_statement']),
  nestedFnTypes: new Set(['lambda_expression']),
  switchFallsThrough: true,
  blockScoped: true,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['throw_statement']),
  blockTypes: new Set(['compound_statement']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set([]),
  declTypes: new Set(['init_declarator']),
  declContainerTypes: new Set(['declaration']),
  memberTypes: new Set(['field_expression']),
  subscriptTypes: new Set(['subscript_expression']),
  derefTypes: new Set(['pointer_expression']),
  identTypes: new Set(['identifier', 'field_identifier']),
  callTypes: new Set(['call_expression']),
  callNameField: 'function',
  updateTypes: new Set(['update_expression']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const RUST_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_expression']),
  loopTypes: new Set(['while_expression', 'for_expression', 'loop_expression']),
  tryTypes: new Set([]),
  switchTypes: new Set(['match_expression']),
  nestedFnTypes: new Set(['closure_expression', 'function_item']),
  switchFallsThrough: false,
  blockScoped: true,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_expression']),
  breakTypes: new Set(['break_expression']),
  continueTypes: new Set(['continue_expression']),
  throwTypes: new Set([]),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set(['compound_assignment_expr']),
  declTypes: new Set(['let_declaration']),
  declContainerTypes: new Set([]),
  memberTypes: new Set(['field_expression']),
  subscriptTypes: new Set(['index_expression']),
  identTypes: new Set(['identifier']),
  callTypes: new Set(['call_expression', 'macro_invocation']),
  callNameField: 'function',
  updateTypes: new Set([]),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const RUBY_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if', 'unless']),
  loopTypes: new Set(['while', 'until', 'for']),
  tryTypes: new Set(['begin', 'rescue']),
  switchTypes: new Set(['case']),
  nestedFnTypes: new Set(['block', 'do_block', 'lambda', 'method', 'singleton_method']),
  switchFallsThrough: false,
  blockScoped: false,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return']),
  breakTypes: new Set(['break']),
  continueTypes: new Set(['next']),
  throwTypes: new Set(['raise']),
  blockTypes: new Set(['body_statement', 'then', 'else', 'do', 'ensure']),
  assignTypes: new Set(['assignment']),
  augAssignTypes: new Set(['operator_assignment']),
  declTypes: new Set([]),
  declContainerTypes: new Set([]),
  memberTypes: new Set(['call']),
  subscriptTypes: new Set(['element_reference']),
  identTypes: new Set(['identifier']),
  callTypes: new Set(['call', 'method_call']),
  callNameField: 'method',
  updateTypes: new Set([]),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const CSHARP_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement', 'foreach_statement', 'do_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['switch_statement']),
  nestedFnTypes: new Set(['lambda_expression', 'anonymous_method_expression', 'local_function_statement']),
  switchFallsThrough: false,
  blockScoped: true,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['throw_statement']),
  blockTypes: new Set(['block']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set([]),
  declTypes: new Set(['variable_declarator']),
  declContainerTypes: new Set(['local_declaration_statement', 'variable_declaration']),
  memberTypes: new Set(['member_access_expression']),
  subscriptTypes: new Set(['element_access_expression']),
  identTypes: new Set(['identifier']),
  callTypes: new Set(['invocation_expression', 'object_creation_expression']),
  callNameField: 'function',
  updateTypes: new Set(['postfix_unary_expression', 'prefix_unary_expression']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const PHP_SPEC: CfgLangSpec = {
  ifTypes: new Set(['if_statement']),
  loopTypes: new Set(['while_statement', 'for_statement', 'foreach_statement', 'do_statement']),
  tryTypes: new Set(['try_statement']),
  switchTypes: new Set(['switch_statement']),
  nestedFnTypes: new Set(['anonymous_function', 'arrow_function', 'function_definition', 'method_declaration']),
  switchFallsThrough: true,
  blockScoped: false,
  comprehensionTypes: new Set([]),
  returnTypes: new Set(['return_statement']),
  breakTypes: new Set(['break_statement']),
  continueTypes: new Set(['continue_statement']),
  throwTypes: new Set(['throw_expression', 'throw_statement']),
  blockTypes: new Set(['compound_statement']),
  assignTypes: new Set(['assignment_expression']),
  augAssignTypes: new Set(['augmented_assignment_expression']),
  declTypes: new Set([]),
  declContainerTypes: new Set([]),
  memberTypes: new Set(['member_access_expression']),
  subscriptTypes: new Set(['subscript_expression']),
  identTypes: new Set(['variable_name']),
  callTypes: new Set(['function_call_expression', 'member_call_expression', 'object_creation_expression']),
  callNameField: 'function',
  updateTypes: new Set(['update_expression']),
  conditionField: 'condition',
  consequenceField: 'body',
  alternativeField: 'alternative',
  bodyField: 'body',
  leftField: 'left',
  rightField: 'right',
  paramsField: 'parameters',
};

const SPEC_BY_LANGUAGE: Record<string, CfgLangSpec> = {
  TypeScript: TS_SPEC,
  JavaScript: TS_SPEC,
  Python: PY_SPEC,
  Go: GO_SPEC,
  Java: JAVA_SPEC,
  'C++': CPP_SPEC,
  C: CPP_SPEC, // C is a syntactic subset of C++; the same node types apply.
  'C#': CSHARP_SPEC,
  PHP: PHP_SPEC,
  Rust: RUST_SPEC,
  Ruby: RUBY_SPEC,
};

/**
 * Languages for which a CFG overlay is built — the keys of {@link SPEC_BY_LANGUAGE}.
 * Authoritative source for the `cfgOverlay` capability flag in the declarative
 * language-support registry; exported so a completeness test can assert every one is a
 * registry key (no stealth under-claim when a CFG spec is added).
 */
export const CFG_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(SPEC_BY_LANGUAGE));

/** Languages for which CFG construction is implemented (spec v1 scope). */
export function cfgSupportsLanguage(language: string): boolean {
  return language in SPEC_BY_LANGUAGE;
}

// ============================================================================
// BUILDER
// ============================================================================

interface InternalBlock extends CfgBlock {
  /** Defs/uses recorded in this block, in source order. */
  ops: Op[];
}

type Op =
  // `variable` is the source name (for display / value-level matching); `key` is
  // the scope-resolved identity (`name#scopeId`) used by reaching-defs so that a
  // shadowed inner declaration never conflates with the outer same-named var.
  // `weak` defs (logical-assignment `||=`/`&&=`/`??=`, which assign only
  // conditionally) do NOT kill prior defs — the old value can survive, so both
  // reach a later use.
  | { op: 'def'; variable: string; key: string; line: number; precision: DataFlowPrecision; seq?: number; weak?: boolean }
  // `inDefLine` is the start line of the assignment/declaration this use feeds
  // (its RHS), if any — so a forward value slice can chain through a multi-line
  // initializer whose feeding use sits on a different physical line than the def.
  | { op: 'use'; variable: string; key: string; line: number; precision: DataFlowPrecision; inDefLine?: number };

interface LoopCtx {
  continueTarget: number;
  breakTarget: number;
}

class CfgBuilder {
  blocks: InternalBlock[] = [];
  edges: CfgEdge[] = [];
  readonly ENTRY: number;
  readonly EXIT: number;

  /** identifier startIndex → scope-resolved key (`name#scopeId`). */
  constructor(private readonly spec: CfgLangSpec, private readonly scopeKeys: Map<number, string> = new Map(), private readonly language: string = '') {
    this.ENTRY = this.newBlock('entry');
    this.EXIT = this.newBlock('exit');
  }

  /** Scope-resolved key for an identifier occurrence; falls back to the bare name. */
  private keyFor(node: CfgNode, name: string): string {
    return this.scopeKeys.get(node.startIndex) ?? `${name}#0`;
  }

  /**
   * Build the CFG from a function body's statement list. Any path that falls
   * through the end of the body is wired to the exit block.
   */
  build(body: CfgNode): void {
    // Statements never land directly on ENTRY: a dedicated start block keeps the
    // entry node a stable, never-relabeled root (so it can be relabeled
    // 'branch'/'loop' when the first statement is a control-flow construct).
    const start = this.newBlock('normal');
    this.addEdge(this.ENTRY, start, 'normal');
    const exit = this.processSeq(this.stmtChildren(body), start, null);
    if (exit !== null) this.addEdge(exit, this.EXIT, 'normal');
  }

  private newBlock(kind: CfgBlockKind): number {
    const id = this.blocks.length;
    this.blocks.push({ id, kind, ops: [] });
    return id;
  }

  private addEdge(from: number, to: number, kind: CfgEdgeKind): void {
    this.edges.push({ from, to, kind });
  }

  private setKind(block: number, kind: CfgBlockKind): void {
    // Don't downgrade entry/exit.
    const b = this.blocks[block];
    if (b.kind === 'entry' || b.kind === 'exit') return;
    b.kind = kind;
  }

  /**
   * Process a statement list starting from `entry`. Returns the single block id
   * that "falls through" after the sequence, or null if every path diverted
   * (return/throw/break/continue) and nothing falls through.
   */
  private processSeq(stmts: CfgNode[], entry: number, loop: LoopCtx | null): number | null {
    let current: number | null = entry;
    for (const stmt of stmts) {
      if (current === null) break; // unreachable after a divert
      current = this.processStmt(stmt, current, loop);
    }
    return current;
  }

  private processStmt(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const t = stmt.type;
    const { spec } = this;

    // `label: <stmt>` — unwrap so a labeled loop is still processed as a loop.
    // (A labeled break/continue still targets the innermost loop; label-precise
    // targeting is a known minor over-approximation.)
    if (t === 'labeled_statement') {
      const inner = stmt.childForFieldName('body') ?? stmt.namedChildren[stmt.namedChildren.length - 1];
      if (inner && inner !== stmt) return this.processStmt(inner, current, loop);
      return current;
    }

    // Expression-oriented languages (Rust) wrap control-flow in an
    // expression_statement: `if a { … }` is an expression_statement → if_expression.
    // Unwrap so it is processed as control flow, not flattened to plain uses.
    if (t === 'expression_statement' && stmt.namedChildren.length === 1) {
      const inner = stmt.namedChildren[0];
      if (
        spec.ifTypes.has(inner.type) || spec.loopTypes.has(inner.type) || spec.switchTypes.has(inner.type) ||
        spec.tryTypes.has(inner.type) || spec.returnTypes.has(inner.type) || spec.throwTypes.has(inner.type) ||
        spec.breakTypes.has(inner.type) || spec.continueTypes.has(inner.type)
      ) return this.processStmt(inner, current, loop);
    }

    if (spec.ifTypes.has(t)) return this.processIf(stmt, current, loop);
    if (spec.loopTypes.has(t)) return this.processLoop(stmt, current, loop);
    if (spec.tryTypes.has(t)) return this.processTry(stmt, current, loop);
    if (spec.switchTypes.has(t)) return this.processSwitch(stmt, current, loop);
    if (t === 'with_statement') return this.processWith(stmt, current, loop);

    // A nested function/closure declared as a statement: its body is a separate
    // scope, not part of this CFG. Record only its free-variable (closure) reads
    // as `may` captures of the enclosing scope.
    if (spec.nestedFnTypes.has(t)) {
      this.recordClosureCaptures(stmt, current);
      return current;
    }

    if (spec.returnTypes.has(t) || spec.throwTypes.has(t)) {
      this.recordExpr(stmt, current); // return/throw value is a use
      this.addEdge(current, this.EXIT, 'exit');
      return null;
    }
    if (spec.breakTypes.has(t)) {
      if (loop) this.addEdge(current, loop.breakTarget, 'normal');
      else this.addEdge(current, this.EXIT, 'exit');
      return null;
    }
    if (spec.continueTypes.has(t)) {
      if (loop) this.addEdge(current, loop.continueTarget, 'back');
      else this.addEdge(current, this.EXIT, 'exit');
      return null;
    }

    // Ruby statement modifiers (`x = 2 if c`, `… while c`): the wrapped statement
    // runs CONDITIONALLY, so treating it as unconditional would let it kill the
    // prior def and emit a wrong `exact`. Model it as a one-armed branch / loop.
    if (t === 'if_modifier' || t === 'unless_modifier' || t === 'while_modifier' || t === 'until_modifier') {
      return this.processModifier(stmt, current, loop);
    }

    // Compound block (bare `{ ... }`) — recurse into its statements.
    if (spec.blockTypes.has(t)) {
      return this.processSeq(stmt.namedChildren, current, loop);
    }

    // Straight-line statement: record defs/uses into the current block.
    this.recordStmt(stmt, current);
    return current;
  }

  /** Ruby `<stmt> if/unless/while/until <cond>` — the wrapped statement is
   *  conditional, so its def does not unconditionally kill the prior one. */
  private processModifier(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const cond = stmt.childForFieldName('condition');
    const body = stmt.childForFieldName('body');
    const isLoop = stmt.type === 'while_modifier' || stmt.type === 'until_modifier';
    this.setKind(current, isLoop ? 'loop' : 'branch');
    if (cond) this.recordUses(cond, current);
    const bodyBlock = this.newBlock('normal');
    this.addEdge(current, bodyBlock, 'true');
    const bodyExit = body ? this.processStmt(body, bodyBlock, loop) : bodyBlock;
    const merge = this.newBlock('merge');
    this.addEdge(current, merge, 'false');     // condition false → skip the body
    if (bodyExit !== null) this.addEdge(bodyExit, isLoop ? current : merge, isLoop ? 'back' : 'normal');
    return merge;
  }

  private processIf(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    this.setKind(current, 'branch');
    const cond = stmt.childForFieldName(spec.conditionField);
    if (cond) this.recordUses(cond, current);

    const consequence = stmt.childForFieldName(spec.consequenceField);
    const thenBlock = this.newBlock('normal');
    this.addEdge(current, thenBlock, 'true');
    const thenExit = consequence
      ? this.processSeq(this.stmtChildren(consequence), thenBlock, loop)
      : thenBlock;

    const merge = this.newBlock('merge');
    if (thenExit !== null) this.addEdge(thenExit, merge, 'normal');

    // Python `if/elif*/else?` exposes each alternative as a separate child
    // (elif_clause / else_clause); a single childForFieldName('alternative')
    // would drop all but the first, silently losing branches. Collect them all.
    const elifs = stmt.namedChildren.filter(c => c.type === 'elif_clause');
    if (elifs.length > 0) {
      const pyElse = stmt.namedChildren.find(c => c.type === 'else_clause');
      let falseSrc = current;
      for (const elif of elifs) {
        const elifBlock = this.newBlock('branch');
        this.addEdge(falseSrc, elifBlock, 'false');
        const ec = elif.childForFieldName(spec.conditionField);
        if (ec) this.recordUses(ec, elifBlock);
        const eb = elif.childForFieldName(spec.consequenceField) ?? elif.childForFieldName(spec.bodyField);
        const thenB = this.newBlock('normal');
        this.addEdge(elifBlock, thenB, 'true');
        const ex = eb ? this.processSeq(this.stmtChildren(eb), thenB, loop) : thenB;
        if (ex !== null) this.addEdge(ex, merge, 'normal');
        falseSrc = elifBlock;
      }
      if (pyElse) {
        const elseBlock = this.newBlock('normal');
        this.addEdge(falseSrc, elseBlock, 'false');
        const eb = pyElse.childForFieldName(spec.bodyField) ?? pyElse.namedChildren.find(c => spec.blockTypes.has(c.type));
        const ex = eb ? this.processSeq(this.stmtChildren(eb), elseBlock, loop) : elseBlock;
        if (ex !== null) this.addEdge(ex, merge, 'normal');
      } else {
        this.addEdge(falseSrc, merge, 'false');
      }
      return merge;
    }

    const alternative = stmt.childForFieldName(spec.alternativeField);
    if (alternative) {
      const elseBlock = this.newBlock('normal');
      this.addEdge(current, elseBlock, 'false');
      // `else if` chains: the alternative is itself an if (or an else_clause wrapping one).
      const elseExit = this.processSeq(this.elseChildren(alternative), elseBlock, loop);
      if (elseExit !== null) this.addEdge(elseExit, merge, 'normal');
    } else {
      // No else: the false edge skips straight to the merge.
      this.addEdge(current, merge, 'false');
    }
    return merge;
  }

  /**
   * Python `with ctx as v:` (and `with a() as x, b() as y:`). Linear flow: the
   * context expression is a use, the `as` target is a definition, then the body
   * runs as a normal statement sequence (it may itself branch/return).
   */
  private processWith(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    const clause = stmt.namedChildren.find(c => c.type === 'with_clause') ?? stmt;
    for (const item of clause.namedChildren) {
      if (item.type !== 'with_item') continue;
      const inner = item.childForFieldName('value') ?? item.namedChildren[0];
      if (inner && inner.type === 'as_pattern') {
        const value = inner.namedChildren[0];
        if (value) this.recordUses(value, current);
        const tgt = inner.childForFieldName('alias') ?? inner.namedChildren.find(c => c.type === 'as_pattern_target');
        if (tgt) this.recordTarget(tgt, current, tgt.startPosition.row + 1);
      } else if (inner) {
        this.recordUses(inner, current); // bare `with cm:` (no binding)
      }
    }
    const body = stmt.childForFieldName(spec.bodyField);
    return body ? this.processSeq(this.stmtChildren(body), current, loop) : current;
  }

  private processLoop(stmt: CfgNode, current: number, _loop: LoopCtx | null): number | null {
    const { spec } = this;
    // `do { body } while (cond)` is a POST-test loop: the body always runs once
    // BEFORE the condition, so a pre-loop def is killed by the body before the
    // condition or post-loop code sees it. Wiring it as a pre-test loop would
    // leak that pre-loop def through as an unsound `exact`.
    if (stmt.type === 'do_statement') return this.processDoWhile(stmt, current);

    // Loop init / range target: a `for (let i = 0; ...)` or `for x := range ...`
    // introduces a definition; record it into the pre-loop block.
    this.recordLoopHeader(stmt, current);

    const condBlock = this.newBlock('loop');
    this.addEdge(current, condBlock, 'normal');
    let cond = stmt.childForFieldName(spec.conditionField) ?? loopHeaderField(stmt, spec.conditionField);
    // Go exposes `for cond {}` as a bare expression child with no condition field —
    // recover it (the named child that is neither the body nor a for/range clause)
    // so its loop-variable reads are recorded and it is not mistaken for `for {}`.
    if (!cond && this.language === 'Go' && stmt.type === 'for_statement') {
      const bodyNode = stmt.childForFieldName(spec.bodyField);
      cond = stmt.namedChildren.find(c =>
        !spec.blockTypes.has(c.type) && c.type !== 'for_clause' && c.type !== 'range_clause' && !sameNode(c, bodyNode)
      ) ?? null;
    }
    if (cond) this.recordUses(cond, condBlock);

    const bodyBlock = this.newBlock('normal');
    this.addEdge(condBlock, bodyBlock, 'true');
    const afterBlock = this.newBlock('merge');
    // A pre-test or foreach/range loop can skip its body (condition false on
    // entry, or an empty iterable), so the condition gets a false edge straight
    // to the merge. An INFINITE loop (Rust `loop {}`, Go `for {}`, C-family
    // `for(;;)`) always executes its body — its only exits are `break`s (already
    // wired to afterBlock). A false edge there would let a pre-loop def bypass
    // the body and reach post-loop code as an unsound `exact`.
    if (!this.isInfiniteLoop(stmt, cond)) this.addEdge(condBlock, afterBlock, 'false');

    const body = stmt.childForFieldName(spec.bodyField);
    const innerLoop: LoopCtx = { continueTarget: condBlock, breakTarget: afterBlock };
    const bodyExit = body
      ? this.processSeq(this.stmtChildren(body), bodyBlock, innerLoop)
      : bodyBlock;
    if (bodyExit !== null) this.addEdge(bodyExit, condBlock, 'back');

    return afterBlock;
  }

  /**
   * An infinite loop always executes its body (only `break` exits it), so it has
   * no "skip the body" path. A loop WITH a condition, or a foreach/range loop
   * (which skips its body on an empty iterable), is NOT infinite and keeps its
   * false→merge edge. Detected forms: Rust `loop {}`, Go bare `for {}`, and
   * C-family `for(;;)` (a `for_statement` with no condition that is neither
   * Python's foreach `for` nor a Go `range` loop). Unknown forms default to
   * not-infinite (keep the edge) — the safe direction for precision.
   */
  private isInfiniteLoop(stmt: CfgNode, cond: CfgNode | null): boolean {
    if (cond) return false;                            // a test can be false on entry
    if (stmt.type === 'loop_expression') return true;  // Rust `loop {}`
    if (stmt.type === 'for_statement') {
      if (this.language === 'Python') return false;                              // Python `for x in xs` = foreach
      if (stmt.namedChildren.some(c => c.type === 'range_clause')) return false;  // Go `for range`
      // A conditionless c-style `for` (`for(;;)`, `for(init;;update)`) and Go's
      // bare `for {}` always run their body — only `break` exits.
      return true;
    }
    return false;
  }

  /** `do { body } while (cond)` — post-test: body runs first, then the condition
   *  decides whether to loop. The body's defs therefore reach the condition and
   *  the exit, killing any pre-loop def. */
  private processDoWhile(stmt: CfgNode, current: number): number | null {
    const { spec } = this;
    const bodyBlock = this.newBlock('normal');
    this.addEdge(current, bodyBlock, 'normal');
    const condBlock = this.newBlock('loop');
    const afterBlock = this.newBlock('merge');

    const body = stmt.childForFieldName(spec.bodyField);
    const innerLoop: LoopCtx = { continueTarget: condBlock, breakTarget: afterBlock };
    const bodyExit = body ? this.processSeq(this.stmtChildren(body), bodyBlock, innerLoop) : bodyBlock;
    if (bodyExit !== null) this.addEdge(bodyExit, condBlock, 'normal');

    const cond = stmt.childForFieldName(spec.conditionField);
    if (cond) this.recordUses(cond, condBlock);
    this.addEdge(condBlock, bodyBlock, 'back');   // true → run the body again
    this.addEdge(condBlock, afterBlock, 'false'); // false → exit
    return afterBlock;
  }

  /**
   * try / catch / finally. The catch body is modeled as an alternative path from
   * the same predecessor (an exception may occur anywhere in the try), so try-body
   * and catch-body definitions do NOT linearly kill each other — they both reach
   * the join. A `finally` runs on every path, so it is processed from the merge.
   */
  private processTry(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    this.setKind(current, 'branch');

    const tryBody = stmt.childForFieldName(spec.bodyField) ?? stmt.namedChildren.find(c => spec.blockTypes.has(c.type));
    const tryBlock = this.newBlock('normal');
    this.addEdge(current, tryBlock, 'true');
    const tryExit = tryBody ? this.processSeq(this.stmtChildren(tryBody), tryBlock, loop) : tryBlock;

    // Python `try ... else:` runs on the NO-exception path, after the try body
    // completes — so the normal path continues through it before the join.
    let normalExit = tryExit;
    const elseClause = stmt.namedChildren.find(c => c.type === 'else_clause');
    if (elseClause && normalExit !== null) {
      const elseBody = elseClause.childForFieldName(spec.bodyField) ?? elseClause.namedChildren.find(c => spec.blockTypes.has(c.type));
      normalExit = elseBody ? this.processSeq(this.stmtChildren(elseBody), normalExit, loop) : normalExit;
    }

    const merge = this.newBlock('merge');
    if (normalExit !== null) this.addEdge(normalExit, merge, 'normal');

    // Each catch/except clause is an alternative path from `current`.
    let sawCatch = false;
    for (const clause of stmt.namedChildren) {
      if (clause.type !== 'catch_clause' && clause.type !== 'except_clause') continue;
      sawCatch = true;
      const catchBlock = this.newBlock('normal');
      this.addEdge(current, catchBlock, 'false');
      // The bound exception variable is a definition (TS `catch (e)`, Py `except X as e`).
      const param = clause.childForFieldName('parameter');
      if (param && spec.identTypes.has(param.type)) {
        this.block(catchBlock).ops.push({ op: 'def', variable: param.text, key: this.keyFor(param, param.text), line: param.startPosition.row + 1, precision: 'exact' });
      } else {
        const asName = clause.namedChildren.find(c => spec.identTypes.has(c.type));
        if (asName) this.block(catchBlock).ops.push({ op: 'def', variable: asName.text, key: this.keyFor(asName, asName.text), line: asName.startPosition.row + 1, precision: 'may' });
      }
      const catchBody = clause.childForFieldName(spec.bodyField) ?? clause.namedChildren.find(c => spec.blockTypes.has(c.type));
      const catchExit = catchBody ? this.processSeq(this.stmtChildren(catchBody), catchBlock, loop) : catchBlock;
      if (catchExit !== null) this.addEdge(catchExit, merge, 'normal');
    }
    // No catch (try/finally only): the try body may still throw past the merge,
    // but the non-exceptional path reaches it — keep `current`→merge as that edge.
    if (!sawCatch) this.addEdge(current, merge, 'false');

    // finally runs on every path → process it sequentially from the join.
    const finallyClause = stmt.namedChildren.find(c => c.type === 'finally_clause');
    if (finallyClause) {
      const finBody = finallyClause.childForFieldName(spec.bodyField) ?? finallyClause.namedChildren.find(c => spec.blockTypes.has(c.type));
      const finExit = finBody ? this.processSeq(this.stmtChildren(finBody), merge, loop) : merge;
      return finExit;
    }
    return merge;
  }

  /**
   * switch / match. Each case body is an alternative path from the discriminant
   * block; cases that do not break/return fall through to the next case (sound
   * for reaching-definitions). `break` exits to the post-switch merge; `continue`
   * still targets an enclosing loop.
   */
  private processSwitch(stmt: CfgNode, current: number, loop: LoopCtx | null): number | null {
    const { spec } = this;
    this.setKind(current, 'branch');
    const value = stmt.childForFieldName('value') ?? stmt.childForFieldName('condition');
    if (value) this.recordUses(value, current);

    // The case clauses live under a `*_body` node (TS switch_body) or, in Go,
    // are direct children of the switch statement itself.
    const body = stmt.childForFieldName(spec.bodyField) ?? stmt.namedChildren.find(c => c.type.endsWith('_body'));
    const caseContainer = body ?? stmt;
    const merge = this.newBlock('merge');
    const caseCtx: LoopCtx = { breakTarget: merge, continueTarget: loop?.continueTarget ?? merge };

    const isCaseNode = (ty: string): boolean =>
      ty === 'switch_case' || ty === 'switch_default' ||      // TS
      ty === 'case_clause' || ty === 'case_block' ||           // Py match (case_clause)
      ty === 'expression_case' || ty === 'default_case' || ty === 'type_case' || // Go
      ty === 'case_statement' ||                               // C/C++
      ty === 'switch_block_statement_group' || ty === 'switch_rule' || // Java (colon + arrow)
      ty === 'switch_section' || ty === 'default_statement' || // C# / PHP
      ty === 'match_arm' ||                                    // Rust
      ty === 'when' || ty === 'else';                          // Ruby (when + else)
    const cases = caseContainer.namedChildren.filter(c => isCaseNode(c.type));
    // Arrow-style cases (Java `case N ->`, Rust arms, Ruby when) never fall through.
    const fallsThrough = spec.switchFallsThrough &&
      !cases.some(c => c.type === 'switch_rule' || c.type === 'match_arm' || c.type === 'when' || c.type === 'else');
    let sawDefault = false;
    let prevFallthrough: number | null = null;
    for (const cs of cases) {
      const { labels, stmts, isDefault } = this.caseParts(cs);
      if (isDefault) sawDefault = true;
      const caseBlock = this.newBlock('normal');
      this.addEdge(current, caseBlock, isDefault ? 'false' : 'true');
      // C-style fall-through: a previous case that did not break/return flows in.
      if (fallsThrough && prevFallthrough !== null) this.addEdge(prevFallthrough, caseBlock, 'normal');
      // The case label expression(s) are uses of the discriminant context.
      for (const lbl of labels) this.recordUses(lbl, current);
      const caseExit = this.processSeq(stmts, caseBlock, caseCtx);
      if (fallsThrough) {
        prevFallthrough = caseExit;
      } else if (caseExit !== null) {
        // Each case auto-breaks (arrow/match/when, Go/Python): tail → merge.
        this.addEdge(caseExit, merge, 'normal');
      }
    }
    if (fallsThrough && prevFallthrough !== null) this.addEdge(prevFallthrough, merge, 'normal');
    // No default: the discriminant can match nothing and skip to the merge.
    if (!sawDefault) this.addEdge(current, merge, 'false');
    return merge;
  }

  /**
   * Decompose one case/arm/when clause into its label expression(s) (uses of the
   * discriminant) and its body statements. The structure differs sharply per
   * language: Rust `match_arm` and Ruby `when` put the body in a field, Java
   * groups statements under switch_label markers, and C-family put the label in
   * a `value` field with statements as siblings.
   */
  private caseParts(cs: CfgNode): { labels: CfgNode[]; stmts: CfgNode[]; isDefault: boolean } {
    const t = cs.type;
    if (t === 'match_arm') { // Rust: pattern => body
      const pat = cs.childForFieldName('pattern');
      const body = cs.childForFieldName('value');
      const isDefault = !!pat && (pat.text === '_' || pat.text.includes('_'));
      return { labels: pat ? [pat] : [], stmts: body ? this.stmtChildren(body) : [], isDefault };
    }
    if (t === 'when') { // Ruby: when <pattern> then <body>
      const pats = cs.namedChildren.filter(c => c.type === 'pattern' || (c.type !== 'then' && c.type !== 'do'));
      const body = cs.childForFieldName('then') ?? cs.namedChildren.find(c => c.type === 'then' || this.spec.blockTypes.has(c.type));
      return { labels: pats, stmts: body ? body.namedChildren : [], isDefault: false };
    }
    if (t === 'else') { // Ruby case `else` clause = the default
      return { labels: [], stmts: cs.namedChildren, isDefault: true };
    }
    if (t === 'switch_block_statement_group') { // Java colon: switch_label* + statements
      const labels = cs.namedChildren.filter(c => c.type === 'switch_label');
      const stmts = cs.namedChildren.filter(c => c.type !== 'switch_label');
      const isDefault = labels.some(l => l.text.includes('default'));
      return { labels, stmts, isDefault };
    }
    if (t === 'switch_rule') { // Java arrow `case N -> body`: switch_label* + body
      const labels = cs.namedChildren.filter(c => c.type === 'switch_label');
      const stmts = cs.namedChildren.filter(c => c.type !== 'switch_label').flatMap(b => this.stmtChildren(b));
      const isDefault = labels.some(l => l.text.includes('default'));
      return { labels, stmts, isDefault };
    }
    if (t === 'switch_section') { // C#: (case label | pattern)* + statements
      const isLabel = (c: CfgNode): boolean =>
        c.type.endsWith('_switch_label') || c.type.endsWith('_pattern');
      const labels = cs.namedChildren.filter(isLabel);
      const stmts = cs.namedChildren.filter(c => !isLabel(c));
      const isDefault = labels.length === 0 || labels.some(l => l.type.includes('default') || l.text.trim().startsWith('default'));
      return { labels, stmts, isDefault };
    }
    // TS switch_case/switch_default, C/C++ case_statement, Go expression_case/etc.
    const value = cs.childForFieldName('value');
    const stmts = cs.namedChildren.filter(c => !sameNode(c, value));
    return { labels: value ? [value] : [], stmts, isDefault: t.includes('default') || (!value && (t === 'case_statement' || t === 'switch_case')) };
  }

  /**
   * Record the free-variable reads of a nested function/closure as `may`
   * (closure-capture) uses of the enclosing scope. Names bound by the nested
   * function (its parameters) are excluded; an outer definition of any remaining
   * name forms a conservative `may` dependence. The nested body's own defs are
   * deliberately NOT recorded — they belong to a different scope.
   */
  private recordClosureCaptures(fnNode: CfgNode, block: number): void {
    const { spec } = this;
    const bound = new Set<string>(extractParamNames(fnNode, spec));
    const body = findBody(fnNode, spec);
    if (!body) return;
    const seen = new Set<string>();
    const visit = (n: CfgNode): void => {
      // Do not descend into a further-nested function — that is yet another scope.
      if (n !== fnNode && spec.nestedFnTypes.has(n.type)) { this.recordClosureCaptures(n, block); return; }
      if (spec.callTypes.has(n.type)) {
        const fn = n.childForFieldName(spec.callNameField) ?? n.childForFieldName('function') ?? n.namedChildren[0];
        for (const c of n.namedChildren) { if (sameNode(c, fn) && fn && spec.identTypes.has(fn.type)) continue; visit(c); }
        return;
      }
      if (spec.identTypes.has(n.type)) {
        if (!bound.has(n.text)) {
          const key = `${n.text}|${n.startPosition.row + 1}`;
          if (!seen.has(key)) {
            seen.add(key);
            this.block(block).ops.push({ op: 'use', variable: n.text, key: this.keyFor(n, n.text), line: n.startPosition.row + 1, precision: 'may' });
          }
        }
        return;
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(body);
  }

  // ── Statement / expression def-use extraction ─────────────────────────────

  private recordStmt(stmt: CfgNode, block: number): void {
    // Unwrap expression_statement / simple_statement wrappers.
    for (const node of this.unwrap(stmt)) {
      if (this.spec.declContainerTypes.has(node.type)) {
        // e.g. `let a = 1, b = 2;` — descend into each declarator.
        for (const child of node.namedChildren) {
          if (this.spec.declTypes.has(child.type)) this.recordDeclaration(child, block);
          else this.recordStmt(child, block);
        }
      } else if (this.spec.updateTypes.has(node.type)) {
        this.recordUpdate(node, block);
      } else if (this.spec.assignTypes.has(node.type)) {
        this.recordAssignment(node, block, false);
      } else if (this.spec.augAssignTypes.has(node.type)) {
        this.recordAssignment(node, block, true);
      } else if (this.spec.declTypes.has(node.type)) {
        this.recordDeclaration(node, block);
      } else {
        // Any other statement: collect uses (call args, conditions, etc.).
        this.recordUses(node, block);
      }
    }
  }

  /** A return/throw value, or any embedded expression, contributes uses. */
  private recordExpr(stmt: CfgNode, block: number): void {
    this.recordUses(stmt, block);
  }

  /** `x++` / `x--` (and Go `inc_statement`/`dec_statement`): a use of the operand
   *  followed by a def of it. */
  private recordUpdate(node: CfgNode, block: number): void {
    const operand = node.childForFieldName('argument') ?? node.childForFieldName('operand')
      ?? node.childForFieldName('expression') ?? node.namedChildren[0];
    if (!operand) return;
    const line = node.startPosition.row + 1;
    this.recordUses(operand, block);
    this.recordTarget(operand, block, line);
  }

  private recordAssignment(node: CfgNode, block: number, augmented: boolean): void {
    const { spec } = this;
    const left = node.childForFieldName(spec.leftField) ?? node.namedChildren[0];
    const right = node.childForFieldName(spec.rightField) ?? node.namedChildren[node.namedChildren.length - 1];
    const line = node.startPosition.row + 1;

    // Detect a compound operator (`+=`, `-=`, …) from its text, so languages that
    // use ONE node type for `=` and `+=` (Java, C/C++) are handled correctly.
    const op = node.childForFieldName('operator')?.text;
    const compound = !!op && op.length >= 2 && op.endsWith('=') &&
      op !== '==' && op !== '!=' && op !== '<=' && op !== '>=' && op !== '=>' && op !== '===' && op !== '!==';
    const reads = augmented || compound; // a compound assignment reads the target first

    // Tag RHS uses with the line of the variable they feed (`left`), so a forward
    // value slice chains through a multi-line initializer.
    if (right) this.recordUses(right, block, line);
    // Augmented/compound assignment (x += 1) reads the target before writing it.
    if (reads && left) this.recordUses(left, block);
    const weak = op === '||=' || op === '&&=' || op === '??=';

    if (left) this.recordTarget(left, block, line, weak);
  }

  private recordDeclaration(node: CfgNode, block: number): void {
    const { spec } = this;
    const line = node.startPosition.row + 1;
    // Go short_var_declaration / var_spec: left & right are expression_lists.
    // C/C++ init_declarator uses a `declarator` field for the binding target.
    const left = node.childForFieldName(spec.leftField) ?? node.childForFieldName('name') ?? node.childForFieldName('declarator');
    const right = node.childForFieldName(spec.rightField) ?? node.childForFieldName('value');
    if (right) this.recordUses(right, block, line);
    if (left) {
      this.recordTarget(left, block, line);
    } else {
      // tree-sitter shapes without named left/right fields (var_spec lists):
      // first identifier child is the def, remaining expressions are uses.
      const idents = node.namedChildren.filter(c => spec.identTypes.has(c.type));
      for (const id of idents) this.block(block).ops.push({ op: 'def', variable: id.text, key: this.keyFor(id, id.text), line, precision: 'exact' });
    }
  }

  /** Record an assignment/declaration target as a definition (exact for scalars,
   *  may for member/subscript). `weak` marks a conditional (logical-assignment)
   *  def that does not kill the prior value. */
  private recordTarget(target: CfgNode, block: number, line: number, weak = false): void {
    const { spec } = this;
    // A destructuring binding leaf: `{ a, b }` exposes each name as a
    // `shorthand_property_identifier_pattern` (no children), which the generic
    // container recurse below would silently drop.
    if (target.type === 'shorthand_property_identifier_pattern' || target.type === 'shorthand_property_identifier') {
      this.block(block).ops.push({ op: 'def', variable: target.text, key: this.keyFor(target, target.text), line, precision: 'exact' });
      return;
    }
    // `{ key: binding }` — the value is the binding; the key is a property name.
    if (target.type === 'pair_pattern') {
      const val = target.childForFieldName('value') ?? target.namedChildren[target.namedChildren.length - 1];
      if (val) this.recordTarget(val, block, line);
      return;
    }
    // `{ a = default }` / `[a = default]` — left is the binding, right is a use.
    if (target.type === 'object_assignment_pattern' || target.type === 'assignment_pattern') {
      const def = target.childForFieldName('right') ?? target.namedChildren[target.namedChildren.length - 1];
      const bind = target.childForFieldName('left') ?? target.namedChildren[0];
      if (def && !sameNode(def, bind)) this.recordUses(def, block);
      if (bind) this.recordTarget(bind, block, line);
      return;
    }
    // Destructuring / multiple targets: expression_list, array/object patterns.
    if (
      target.type === 'expression_list' ||
      target.type.endsWith('_pattern') ||
      target.type === 'tuple_pattern' ||
      target.type === 'array_pattern' ||
      target.type === 'object_pattern' ||
      target.type === 'pattern_list'
    ) {
      for (const child of target.namedChildren) this.recordTarget(child, block, line);
      return;
    }
    if (spec.identTypes.has(target.type)) {
      this.block(block).ops.push({ op: 'def', variable: target.text, key: this.keyFor(target, target.text), line, precision: 'exact', weak });
      return;
    }
    if (
      spec.memberTypes.has(target.type) ||
      spec.subscriptTypes.has(target.type) ||
      // `*p = x` (C/C++): a write through the pointer mutates the pointee, not the
      // binding `p`. Treating it like obj.field keeps `p` a *use* (we read it to
      // dereference) and the l-value `*p` a `may` def — never an exact reassign of
      // `p`, which would falsely kill `p`'s real def and mislabel its provenance.
      // Guard against `&x` (address-of shares the node type but never appears as an
      // assignment target in valid code).
      (spec.derefTypes?.has(target.type) && !target.text.startsWith('&'))
    ) {
      // obj.field = ... / arr[i] = ... / *p = ... — the base object is read, the
      // whole l-value is a conservatively over-approximated (`may`) definition
      // keyed by its source text (e.g. "obj.field", "*p").
      const base = target.namedChildren[0];
      if (base && spec.identTypes.has(base.type)) {
        this.block(block).ops.push({ op: 'use', variable: base.text, key: this.keyFor(base, base.text), line, precision: 'exact' });
      }
      this.block(block).ops.push({ op: 'def', variable: normalizeLValue(target.text), key: normalizeLValue(target.text), line, precision: 'may', weak });
      return;
    }
    // Anything else (rare): collect identifier defs conservatively.
    for (const child of target.namedChildren) this.recordTarget(child, block, line);
  }

  /** Loop init / range header introduces loop-variable definitions. */
  private recordLoopHeader(stmt: CfgNode, block: number): void {
    const { spec } = this;
    const line = stmt.startPosition.row + 1;
    // C-style for: initializer field. for-of/for-in/range: left field. Go wraps
    // these in a for_clause/range_clause child (loopHeaderField descends into it).
    const init = loopHeaderField(stmt, 'initializer') ?? loopHeaderField(stmt, 'init');
    if (init) this.recordStmt(init, block);
    const update = loopHeaderField(stmt, 'update') ?? loopHeaderField(stmt, 'increment');
    if (update) this.recordUses(update, block);
    // for (const x of xs) / for x in xs / for i, v := range xs / Rust `for i in xs` /
    // Java enhanced-for `for (T name : value)` exposes the loop var in `name`.
    const left = loopHeaderField(stmt, 'left') ?? loopHeaderField(stmt, 'pattern') ?? loopHeaderField(stmt, 'name');
    const right = loopHeaderField(stmt, 'right') ?? loopHeaderField(stmt, 'value');
    if (right) this.recordUses(right, block);
    if (left && (spec.identTypes.has(left.type) || left.type.includes('pattern') || left.type === 'expression_list')) {
      this.recordTarget(left, block, line);
    }
  }

  /**
   * Walk an expression subtree collecting variable reads. Skips the callee name
   * of a call, the property name of a member access, and identifiers in def
   * position. A member/subscript read of a variable contributes a `may` use of
   * the l-value plus an `exact` use of the base object.
   */
  private recordUses(node: CfgNode, block: number, enclosingDefLine?: number): void {
    const { spec } = this;
    const visit = (n: CfgNode): void => {
      const t = n.type;
      // A nested function/closure (callback, IIFE): its body is a separate scope.
      // Record its free-variable reads as `may` captures, do not descend further.
      if (spec.nestedFnTypes.has(t)) {
        this.recordClosureCaptures(n, block);
        return;
      }
      // Nested assignment/declaration inside an expression: handle as a statement.
      if (spec.updateTypes.has(t)) {
        this.recordUpdate(n, block);
        return;
      }
      if (spec.assignTypes.has(t) || spec.augAssignTypes.has(t)) {
        this.recordAssignment(n, block, spec.augAssignTypes.has(t));
        return;
      }
      // Walrus (`n := value`, Python named_expression): a definition embedded in
      // an expression — record the value's uses, then the name's def.
      if (t === 'named_expression') {
        const val = n.childForFieldName('value');
        const name = n.childForFieldName('name');
        if (val) visit(val);
        if (name && spec.identTypes.has(name.type)) {
          this.block(block).ops.push({ op: 'def', variable: name.text, key: this.keyFor(name, name.text), line: name.startPosition.row + 1, precision: 'exact' });
        }
        return;
      }
      if (spec.memberTypes.has(t)) {
        // obj.field read: base obj is an exact use, the field path is a may use.
        const base = n.namedChildren[0];
        if (base) visit(base);
        this.block(block).ops.push({ op: 'use', variable: normalizeLValue(n.text), key: normalizeLValue(n.text), line: n.startPosition.row + 1, precision: 'may', inDefLine: enclosingDefLine });
        return;
      }
      if (spec.subscriptTypes.has(t)) {
        for (const c of n.namedChildren) visit(c);
        this.block(block).ops.push({ op: 'use', variable: normalizeLValue(n.text), key: normalizeLValue(n.text), line: n.startPosition.row + 1, precision: 'may', inDefLine: enclosingDefLine });
        return;
      }
      if (spec.callTypes.has(t)) {
        // Skip the callee identifier; collect uses from arguments and receiver.
        const fn = n.childForFieldName(spec.callNameField) ?? n.childForFieldName('function') ?? n.namedChildren[0];
        for (const c of n.namedChildren) {
          if (sameNode(c, fn) && fn && spec.identTypes.has(fn.type)) continue;
          visit(c);
        }
        return;
      }
      if (spec.identTypes.has(t)) {
        this.block(block).ops.push({ op: 'use', variable: n.text, key: this.keyFor(n, n.text), line: n.startPosition.row + 1, precision: 'exact', inDefLine: enclosingDefLine });
        return;
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(node);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private block(id: number): InternalBlock {
    return this.blocks[id];
  }

  /** Children of a compound/block node, or the node itself wrapped as one statement. */
  private stmtChildren(node: CfgNode): CfgNode[] {
    if (this.spec.blockTypes.has(node.type)) return node.namedChildren;
    return [node];
  }

  /** Children of an else branch — unwrap else_clause (TS/C++/Rust) / else (Ruby). */
  private elseChildren(node: CfgNode): CfgNode[] {
    if (node.type === 'else_clause') {
      const body = node.childForFieldName(this.spec.bodyField) ?? node.namedChildren.find(c => this.spec.blockTypes.has(c.type)) ?? node.namedChildren[0];
      return body ? this.stmtChildren(body) : [];
    }
    if (node.type === 'else') return node.namedChildren; // Ruby `else` directly holds statements
    // `else if`: the alternative is the nested if_statement itself.
    return [node];
  }

  /** Unwrap expression_statement / simple_statement to its meaningful children. */
  private unwrap(stmt: CfgNode): CfgNode[] {
    if (stmt.type === 'expression_statement' || stmt.type === 'simple_statement') {
      return stmt.namedChildren.length > 0 ? stmt.namedChildren : [stmt];
    }
    return [stmt];
  }
}

/** Strip whitespace and array-index noise so an l-value is a stable key. */
function normalizeLValue(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * Read a loop-header field (`initializer`/`condition`/`update`/`left`/`right`).
 * Go wraps the header in a `for_clause` (C-style) or `range_clause` (range)
 * child, so the fields live there, not on the `for_statement`; TS/JS expose them
 * directly. This descends into the clause when present.
 */
function loopHeaderField(stmt: CfgNode, field: string): CfgNode | null {
  const clause = stmt.namedChildren.find(c => c.type === 'for_clause' || c.type === 'range_clause');
  return (clause ?? stmt).childForFieldName(field);
}

/**
 * Collect the local names that ESCAPE the straightforward intra-procedural model
 * and therefore cannot carry a sound `exact` dependence:
 *   - a variable assigned inside a nested closure (the closure may run at any time
 *     and reassign it), and
 *   - a variable whose address is taken (`&x` in Go — a pointer can mutate it).
 * Reaching-definitions edges for these names are downgraded to `may`. The set is
 * deliberately OVER-approximated: a false inclusion only weakens precision (more
 * `may`), it never produces an unsound `exact`.
 */
function collectEscapedVars(body: CfgNode, spec: CfgLangSpec): Set<string> {
  const escaped = new Set<string>();

  const collectClosureMutations = (fnNode: CfgNode): void => {
    const bound = new Set<string>(extractParamNames(fnNode, spec));
    const fbody = findBody(fnNode, spec);
    if (!fbody) return;
    // PHP `use (&$x)` captures $x by reference: the closure can mutate the outer
    // $x out of band (even via a subscript/member write that addLeftIdents skips),
    // so a by-ref capture escapes unconditionally.
    const useClause = fnNode.namedChildren.find(c => c.type === 'anonymous_function_use_clause');
    if (useClause) {
      for (const cap of useClause.namedChildren) {
        if (cap.type === 'by_ref') {
          const v = cap.namedChildren.find(x => spec.identTypes.has(x.type));
          if (v) escaped.add(v.text);
        }
      }
    }
    // Names declared inside this closure are local to it (not outer mutations).
    const collectBound = (n: CfgNode): void => {
      if (n !== fnNode && spec.nestedFnTypes.has(n.type)) return; // a deeper closure has its own scope
      if (spec.declTypes.has(n.type)) {
        const nm = n.childForFieldName('name') ?? n.childForFieldName(spec.leftField);
        if (nm && spec.identTypes.has(nm.type)) bound.add(nm.text);
        for (const c of n.namedChildren) if (spec.identTypes.has(c.type)) bound.add(c.text);
      }
      for (const c of n.namedChildren) collectBound(c);
    };
    collectBound(fbody);
    // Add the simple-identifier targets of an assignment LHS to `escaped` (skip
    // member/subscript writes — those rebind a field, not the scalar). Handles
    // Go's `expression_list` LHS (`x, y = ...`) by descending.
    const addLeftIdents = (left: CfgNode | null): void => {
      if (!left) return;
      if (spec.memberTypes.has(left.type) || spec.subscriptTypes.has(left.type)) return;
      // A shorthand-destructuring binding (`({a, b} = …)`) reassigns the bare
      // name; its leaves are shorthand_property_identifier_pattern, not plain
      // identifiers, so descend them explicitly (mirrors collectIdentLeaves).
      if (spec.identTypes.has(left.type) || left.type === 'shorthand_property_identifier_pattern' || left.type === 'shorthand_property_identifier') {
        if (!bound.has(left.text)) escaped.add(left.text); return;
      }
      for (const c of left.namedChildren) addLeftIdents(c);
    };
    // A mutation (assignment / `x++` / `&x`) of an outer name inside the closure.
    const collectMut = (n: CfgNode): void => {
      if (n !== fnNode && spec.nestedFnTypes.has(n.type)) { collectClosureMutations(n); return; }
      if (spec.assignTypes.has(n.type) || spec.augAssignTypes.has(n.type)) {
        addLeftIdents(n.childForFieldName(spec.leftField) ?? n.namedChildren[0]);
      }
      if (n.type === 'update_expression' || n.type === 'inc_statement' || n.type === 'dec_statement') {
        const arg = n.childForFieldName('argument') ?? n.childForFieldName('operand') ?? n.namedChildren[0];
        if (arg && spec.identTypes.has(arg.type) && !bound.has(arg.text)) escaped.add(arg.text);
      }
      if (n.type === 'unary_expression') {
        const op = n.childForFieldName('operator'), operand = n.childForFieldName('operand');
        if (op?.text === '&' && operand && spec.identTypes.has(operand.type) && !bound.has(operand.text)) escaped.add(operand.text);
      }
      // Rust mutable borrow `&mut x` of an outer local inside the closure.
      if (n.type === 'reference_expression' && n.namedChildren.some(c => c.type === 'mutable_specifier')) {
        const operand = n.childForFieldName('value') ?? n.namedChildren[n.namedChildren.length - 1];
        if (operand && spec.identTypes.has(operand.type) && !bound.has(operand.text)) escaped.add(operand.text);
      }
      // `&mut x` inside a macro token_tree (`write!(&mut x, …)`) within the closure.
      if (n.type === 'token_tree') {
        const ch = n.children ?? [];
        for (let i = 1; i + 1 < ch.length; i++) {
          if (ch[i].type === 'mutable_specifier' && ch[i - 1].text === '&' && spec.identTypes.has(ch[i + 1].type) && !bound.has(ch[i + 1].text)) {
            escaped.add(ch[i + 1].text);
          }
        }
      }
      for (const c of n.namedChildren) collectMut(c);
    };
    collectMut(fbody);
  };

  const walk = (n: CfgNode): void => {
    if (spec.nestedFnTypes.has(n.type)) { collectClosureMutations(n); return; }
    // Address-of (`&x`): a pointer to a local escapes scalar tracking. Go uses a
    // `unary_expression` with `&`; C/C++ use a `pointer_expression` with `&`.
    if (n.type === 'unary_expression' || n.type === 'pointer_expression') {
      const op = n.childForFieldName('operator') ?? n.children?.find(c => c.text === '&' || c.text === '*');
      const operand = n.childForFieldName('operand') ?? n.childForFieldName('argument') ?? n.namedChildren[0];
      if (op?.text === '&' && operand && spec.identTypes.has(operand.type)) escaped.add(operand.text);
    }
    // Rust mutable borrow `&mut x`: the callee can mutate the local out of band,
    // so its def can change before a later use — it can never carry a sound
    // `exact`. A shared borrow `&x` (no `mutable_specifier`) cannot mutate x, so
    // it is intentionally left alone and stays exact.
    if (n.type === 'reference_expression' && n.namedChildren.some(c => c.type === 'mutable_specifier')) {
      const operand = n.childForFieldName('value') ?? n.namedChildren[n.namedChildren.length - 1];
      if (operand && spec.identTypes.has(operand.type)) escaped.add(operand.text);
    }
    // Rust macro bodies (`write!(&mut buf, …)`, ubiquitous) keep their args as a
    // raw token_tree, so `&mut x` is a flat token sequence (`&`, mutable_specifier,
    // identifier) rather than a reference_expression. Scan for it so a macro-borrowed
    // local is not mislabeled exact.
    if (n.type === 'token_tree') {
      const ch = n.children ?? [];
      for (let i = 1; i + 1 < ch.length; i++) {
        if (ch[i].type === 'mutable_specifier' && ch[i - 1].text === '&' && spec.identTypes.has(ch[i + 1].type)) {
          escaped.add(ch[i + 1].text);
        }
      }
    }
    // C/C++ reference binding `T& r = x;` aliases x — writes through r mutate x,
    // so x can change out of band: it can never carry a sound `exact`.
    if (n.type === 'init_declarator' && n.childForFieldName('declarator')?.type === 'reference_declarator') {
      const ref = n.childForFieldName('value');
      if (ref && spec.identTypes.has(ref.type)) escaped.add(ref.text);
    }
    // PHP reference assignment `$r = &$x` aliases $x (second operand) the same way.
    if (n.type === 'reference_assignment_expression') {
      const referent = n.namedChildren[n.namedChildren.length - 1];
      if (referent && spec.identTypes.has(referent.type)) escaped.add(referent.text);
    }
    // PHP `foreach ($a as &$v)`: $v is a by-ref alias to each element and stays
    // aliased to the last element after the loop, so it changes out of band.
    if (n.type === 'foreach_statement') {
      for (const c of n.namedChildren) {
        if (c.type === 'by_ref') {
          const v = c.namedChildren.find(x => spec.identTypes.has(x.type));
          if (v) escaped.add(v.text);
        }
      }
    }
    // C# `ref` local (`ref int r = ref e;`): r aliases e — writes through r mutate
    // e out of band, so e can never carry a sound `exact`. ref_expression is
    // C#-specific, so this matches no other language's variable_declarator.
    if (n.type === 'variable_declarator') {
      const refExpr = n.namedChildren.find(c => c.type === 'ref_expression');
      const ref = refExpr?.namedChildren.find(c => spec.identTypes.has(c.type));
      if (ref) escaped.add(ref.text);
    }
    // C# `ref`/`out` argument: the callee can (ref) or must (out) reassign the
    // variable, so its prior/declaration def can change out of band → `may`.
    if (n.type === 'argument' && (n.text.startsWith('ref ') || n.text.startsWith('out '))) {
      const id = n.namedChildren.find(c => spec.identTypes.has(c.type));
      if (id) escaped.add(id.text);
    }
    // Python `global x` / `nonlocal x`: the name binds a module-global or an
    // enclosing local, so an intervening call (or another thread/callback) can
    // rebind it — its def-use can never be a sound `exact`.
    if (n.type === 'global_statement' || n.type === 'nonlocal_statement') {
      for (const c of n.namedChildren) if (spec.identTypes.has(c.type)) escaped.add(c.text);
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(body);
  return escaped;
}

// ============================================================================
// REACHING DEFINITIONS
// ============================================================================

/** A definition site identity within one function: variable + line. */
interface DefSite {
  variable: string;
  /** Scope-resolved identity (`name#scopeId`) — the key reaching-defs groups by. */
  key: string;
  line: number;
  precision: DataFlowPrecision;
  /** Block where the def lives (for GEN/KILL bookkeeping). */
  block: number;
  /** Sequence index for deterministic ordering. */
  seq: number;
  /** Conditional def (logical-assignment) — does not kill prior defs. */
  weak: boolean;
}

/**
 * Compute the reaching-definitions def-use edges over a built CFG. Standard
 * iterative fixpoint: IN[b] = ∪ OUT[preds]; OUT[b] = GEN[b] ∪ (IN[b] − KILL[b]).
 * Then, walking each block's ops in order, every use is wired to the defs of the
 * same variable that reach it.
 */
/**
 * Reaching-definitions fixpoint sweep budget. Real code converges in O(loop-nesting
 * depth) sweeps (a handful); a function needing more than this is pathologically
 * nested (e.g. machine-generated) and is failed soft to no overlay rather than
 * spending quadratic time. 128 sweeps bounds the build to well under a second even
 * on adversarial input while never firing on real code.
 */
const REACHING_MAX_SWEEPS = 128;

/** Upper bound on CFG blocks per function; above this the overlay is skipped
 *  (fail soft) so an adversarial / machine-generated function can't blow up the
 *  build. Real functions are far below this. */
const MAX_CFG_BLOCKS = 4000;

function computeReachingDefs(builder: CfgBuilder, params: string[], paramLine: number, escaped: Set<string>): DefUseEdge[] | null {
  const blocks = builder.blocks;
  const n = blocks.length;

  // Predecessors per block.
  const preds: number[][] = Array.from({ length: n }, () => []);
  for (const e of builder.edges) preds[e.to].push(e.from);

  // Enumerate all def sites. Parameters are defs at the entry block.
  const allDefs: DefSite[] = [];
  let seq = 0;
  for (const p of params) {
    // Params live in the function's root scope (id 0) — uses resolve to `name#0`.
    allDefs.push({ variable: p, key: `${p}#0`, line: paramLine, precision: 'exact', block: builder.ENTRY, seq: seq++, weak: false });
  }
  // Per-block ordered def sites (entry block also carries param defs first).
  const blockDefSites: DefSite[][] = Array.from({ length: n }, () => []);
  for (const pd of allDefs) blockDefSites[pd.block].push(pd);
  for (const b of blocks) {
    for (const op of b.ops) {
      if (op.op === 'def') {
        const site: DefSite = { variable: op.variable, key: op.key, line: op.line, precision: op.precision, block: b.id, seq: seq++, weak: op.weak ?? false };
        op.seq = site.seq; // back-reference so the wiring pass can find this def's seq
        allDefs.push(site);
        blockDefSites[b.id].push(site);
      }
    }
  }

  // Index defs by scope-resolved key for KILL (so a shadowed inner `x` never
  // kills the outer `x`).
  const defsByVar = new Map<string, DefSite[]>();
  for (const d of allDefs) {
    const arr = defsByVar.get(d.key) ?? [];
    arr.push(d);
    defsByVar.set(d.key, arr);
  }

  // GEN[b]: defs generated in b that survive to its end. A STRONG def of v
  // replaces all earlier in-block defs of v; a WEAK def (conditional assignment)
  // accumulates alongside them. KILL[b]: only a STRONG def of v kills incoming
  // defs of v — a weak def leaves them reaching.
  const gen: Set<number>[] = Array.from({ length: n }, () => new Set());
  const kill: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let b = 0; b < n; b++) {
    const liveByVar = new Map<string, Set<number>>();
    const stronglyDefined = new Set<string>();
    for (const d of blockDefSites[b]) {
      const cur = liveByVar.get(d.key) ?? new Set<number>();
      if (d.weak) { cur.add(d.seq); }            // accumulate — old in-block defs survive
      else { cur.clear(); cur.add(d.seq); stronglyDefined.add(d.key); } // replace
      liveByVar.set(d.key, cur);
    }
    for (const set of liveByVar.values()) for (const s of set) gen[b].add(s);
    for (const v of stronglyDefined) {
      for (const killed of defsByVar.get(v) ?? []) kill[b].add(killed.seq);
    }
    // A def never kills itself out of its own GEN set.
    for (const g of gen[b]) kill[b].delete(g);
  }

  // Fixpoint over OUT sets (def seqs).
  const inSet: Set<number>[] = Array.from({ length: n }, () => new Set());
  const outSet: Set<number>[] = Array.from({ length: n }, (_, b) => new Set(gen[b]));

  let changed = true;
  let sweeps = 0;
  const maxSweeps = Math.min(n * n + 16, REACHING_MAX_SWEEPS);
  while (changed && sweeps++ < maxSweeps) {
    changed = false;
    for (let b = 0; b < n; b++) {
      const nin = new Set<number>();
      for (const p of preds[b]) for (const s of outSet[p]) nin.add(s);
      // OUT = GEN ∪ (IN − KILL)
      const nout = new Set<number>(gen[b]);
      for (const s of nin) if (!kill[b].has(s)) nout.add(s);
      if (!setEq(nin, inSet[b])) { inSet[b] = nin; changed = true; }
      if (!setEq(nout, outSet[b])) { outSet[b] = nout; changed = true; }
    }
  }
  // Did not converge within the budget → a pathologically deep CFG. Fail soft
  // (no overlay) rather than emit incomplete data or spend quadratic time.
  if (changed) return null;

  // Wire uses to reaching defs. Walk each block's ops in order, threading a
  // "currently reaching" map (variable → def seqs) seeded from IN[b].
  const defBySeq = new Map<number, DefSite>();
  for (const d of allDefs) defBySeq.set(d.seq, d);

  const edges: DefUseEdge[] = [];
  const emitted = new Set<string>();
  for (let b = 0; b < n; b++) {
    const reaching = new Map<string, Set<number>>();
    for (const s of inSet[b]) {
      const d = defBySeq.get(s)!;
      (reaching.get(d.key) ?? reaching.set(d.key, new Set()).get(d.key)!).add(s);
    }
    for (const op of blocks[b].ops) {
      if (op.op === 'use') {
        const defs = reaching.get(op.key);
        if (defs) {
          for (const s of defs) {
            const d = defBySeq.get(s)!;
            // Edge precision: `may` if either endpoint is conservative.
            // A variable that escapes (closure-mutated or address-taken) can be
            // changed outside the visible control flow, so its dependence is `may`.
            const precision: DataFlowPrecision =
              (d.precision === 'may' || op.precision === 'may' || escaped.has(op.variable)) ? 'may' : 'exact';
            const ekey = `${op.variable}|${d.line}|${op.line}|${precision}|${op.inDefLine ?? ''}`;
            if (!emitted.has(ekey)) {
              emitted.add(ekey);
              edges.push({ variable: op.variable, defLine: d.line, useLine: op.line, precision, ...(op.inDefLine !== undefined ? { useInDefLine: op.inDefLine } : {}) });
            }
          }
        }
      } else if (op.seq !== undefined) {
        if (op.weak) {
          // Conditional assignment: the new def joins the prior reaching defs.
          (reaching.get(op.key) ?? reaching.set(op.key, new Set()).get(op.key)!).add(op.seq);
        } else {
          // A strong def replaces (kills) all prior reaching defs of that variable.
          reaching.set(op.key, new Set([op.seq]));
        }
      }
    }
  }

  // Deterministic ordering.
  edges.sort((a, b) =>
    a.defLine - b.defLine || a.useLine - b.useLine ||
    (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0) ||
    (a.precision < b.precision ? -1 : a.precision > b.precision ? 1 : 0) ||
    // Total ordering: two edges can otherwise differ only in useInDefLine. Make
    // the comparator total so output never relies on sort stability.
    ((a.useInDefLine ?? -1) - (b.useInDefLine ?? -1))
  );
  return edges;
}

function setEq(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ============================================================================
// PUBLIC ENTRY POINT
// ============================================================================

// ============================================================================
// LEXICAL SCOPE RESOLUTION
// ============================================================================

/** Collect the identifier leaves bound by a target pattern (skips object-pattern keys). */
function collectIdentLeaves(node: CfgNode, spec: CfgLangSpec, into: Set<string>): void {
  if (spec.identTypes.has(node.type) || node.type === 'shorthand_property_identifier_pattern' || node.type === 'shorthand_property_identifier') {
    into.add(node.text); return;
  }
  if (node.type === 'pair_pattern') {
    const v = node.childForFieldName('value') ?? node.namedChildren[node.namedChildren.length - 1];
    if (v) collectIdentLeaves(v, spec, into);
    return;
  }
  for (const c of node.namedChildren) collectIdentLeaves(c, spec, into);
}

/** Names bound by a single declaration node (variable_declarator / short_var_declaration / var_spec). */
function collectDeclNames(node: CfgNode, spec: CfgLangSpec, into: Set<string>): void {
  const name = node.childForFieldName('name') ?? node.childForFieldName(spec.leftField);
  if (name) { collectIdentLeaves(name, spec, into); return; }
  for (const c of node.namedChildren) if (spec.identTypes.has(c.type)) into.add(c.text);
}

/** Does this node open a new lexical scope (in the given language)? */
function opensScope(n: CfgNode, spec: CfgLangSpec): boolean {
  if (spec.nestedFnTypes.has(n.type) || spec.comprehensionTypes.has(n.type)) return true;
  if (n.type === 'catch_clause' || n.type === 'except_clause') return true;
  if (spec.blockScoped && (spec.blockTypes.has(n.type) || spec.loopTypes.has(n.type))) return true;
  return false;
}

/** Names a scope-opening node declares directly (without crossing into deeper scopes). */
function scopeDeclaredNames(scopeNode: CfgNode, spec: CfgLangSpec): Set<string> {
  const names = new Set<string>();
  if (spec.nestedFnTypes.has(scopeNode.type)) for (const p of extractParamNames(scopeNode, spec)) names.add(p);
  if (scopeNode.type === 'catch_clause' || scopeNode.type === 'except_clause') {
    const param = scopeNode.childForFieldName('parameter');
    if (param) collectIdentLeaves(param, spec, names);
    else { const as = scopeNode.namedChildren.find(c => spec.identTypes.has(c.type)); if (as) names.add(as.text); }
  }
  if (spec.loopTypes.has(scopeNode.type)) {
    const init = loopHeaderField(scopeNode, 'initializer') ?? loopHeaderField(scopeNode, 'init');
    if (init) {
      if (spec.declTypes.has(init.type)) collectDeclNames(init, spec, names);
      for (const c of init.namedChildren) if (spec.declTypes.has(c.type)) collectDeclNames(c, spec, names);
    }
    const left = loopHeaderField(scopeNode, 'left') ?? loopHeaderField(scopeNode, 'name'); // for-of / range / Java for-each
    if (left) collectIdentLeaves(left, spec, names);
  }
  const scan = (n: CfgNode): void => {
    if (n !== scopeNode && opensScope(n, spec)) return; // a deeper scope owns its own decls
    if (n.type === 'for_in_clause') { const l = n.childForFieldName('left'); if (l) collectIdentLeaves(l, spec, names); }
    if (spec.declTypes.has(n.type)) collectDeclNames(n, spec, names);
    else if (spec.declContainerTypes.has(n.type)) for (const c of n.namedChildren) if (spec.declTypes.has(c.type)) collectDeclNames(c, spec, names);
    for (const c of n.namedChildren) scan(c);
  };
  scan(scopeNode);
  return names;
}

/**
 * Map every identifier occurrence (by startIndex) to a scope-qualified key
 * `name#scopeId`. A reference resolves to the nearest enclosing scope that
 * declares the name; otherwise to the root scope (`name#0`, i.e. a parameter,
 * an outer/free variable, or a global). This is what lets reaching-defs keep a
 * shadowed inner `x` distinct from the outer `x`.
 */
function resolveScopes(body: CfgNode, spec: CfgLangSpec, params: string[]): Map<number, string> {
  const occ = new Map<number, string>();
  let nextId = 1;
  const root = { id: 0, names: new Set<string>(params) };
  for (const nm of scopeDeclaredNames(body, spec)) root.names.add(nm);
  const stack: Array<{ id: number; names: Set<string> }> = [root];
  const resolveRef = (name: string): string => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].names.has(name)) return `${name}#${stack[i].id}`;
    return `${name}#0`;
  };
  const visit = (n: CfgNode): void => {
    const isScope = n !== body && opensScope(n, spec);
    if (isScope) stack.push({ id: nextId++, names: scopeDeclaredNames(n, spec) });
    if (spec.identTypes.has(n.type)) occ.set(n.startIndex, resolveRef(n.text));
    for (const c of n.namedChildren) visit(c);
    if (isScope) stack.pop();
  };
  visit(body);
  return occ;
}

/**
 * Build the per-function CFG + reaching-definitions overlay from a function's
 * AST node, while its parse tree is live. Returns undefined for an unsupported
 * language or a function with no usable body (fail-soft — never throws).
 *
 * @param fnNode    The function/method declaration node.
 * @param language  Source language (TypeScript/JavaScript/Python/Go in v1).
 */
export function buildFunctionCfg(fnNode: CfgNode, language: string): FunctionCfg | undefined {
  const spec = SPEC_BY_LANGUAGE[language];
  if (!spec) return undefined;
  try {
    const body = findBody(fnNode, spec);
    if (!body) return undefined;
    const params = extractParamNames(fnNode, spec);
    const paramLine = fnNode.startPosition.row + 1;

    // Resolve every identifier occurrence to a scope-qualified key so a shadowed
    // inner declaration never conflates with the outer same-named variable.
    const scopeKeys = resolveScopes(body, spec, params);
    const builder = new CfgBuilder(spec, scopeKeys, language);
    builder.build(body);

    // A function whose CFG is implausibly large is machine-generated or
    // adversarial — skip the overlay (fail soft) to bound time and memory.
    if (builder.blocks.length > MAX_CFG_BLOCKS) return undefined;

    // Names that escape visible control flow (closure-mutated or address-taken)
    // cannot carry a sound `exact` dependence — their edges are downgraded to `may`.
    const escaped = collectEscapedVars(body, spec);
    const defUse = computeReachingDefs(builder, params, paramLine, escaped);
    if (defUse === null) return undefined; // fixpoint did not converge — fail soft

    const cfg: FunctionCfg = {
      blocks: builder.blocks.map(b => ({ id: b.id, kind: b.kind })),
      edges: builder.edges,
      defUse,
      params,
      paramLine,
    };
    // Safety net: a structurally-invalid overlay is WORSE than none (an agent
    // would trust corrupt context). If any invariant fails, emit no overlay.
    return isStructurallyValid(cfg) ? cfg : undefined;
  } catch {
    return undefined; // fail-soft: any visitor/grammar surprise yields no overlay
  }
}

/**
 * Structural invariants every emitted overlay must satisfy. A violation means a
 * builder bug or grammar drift produced a malformed CFG; returning false makes
 * {@link buildFunctionCfg} emit no overlay rather than wrong context. Cheap,
 * linear, and run on every function. Exported for the invariant test.
 */
export function isStructurallyValid(cfg: FunctionCfg): boolean {
  if (!Array.isArray(cfg.blocks) || cfg.blocks.length < 2) return false;
  const ids = new Set(cfg.blocks.map(b => b.id));
  if (cfg.blocks.filter(b => b.kind === 'entry').length !== 1) return false;
  if (cfg.blocks.filter(b => b.kind === 'exit').length !== 1) return false;
  for (const e of cfg.edges) if (!ids.has(e.from) || !ids.has(e.to)) return false;
  if (!Array.isArray(cfg.params) || !Number.isInteger(cfg.paramLine) || cfg.paramLine < 1) return false;
  for (const d of cfg.defUse) {
    if (d.defLine < 1 || d.useLine < 1) return false;
    if (d.precision !== 'exact' && d.precision !== 'may') return false;
    if (typeof d.variable !== 'string' || d.variable.length === 0) return false;
  }
  return true;
}

/**
 * Forward data-flow slice: the set of source lines a value reaches through
 * def-use edges within one function (a Weiser forward slice = the value's impact
 * set). Seeds from `target` (a parameter or local variable name) or, when
 * omitted, from every parameter. Propagates through chained assignments: a line
 * that defines a variable from a tainted read becomes tainted itself.
 *
 * Used by the value-level opt-in on `analyze_impact`/`trace_execution_path` to
 * narrow downstream results to the calls whose arguments are data-dependent on
 * the targeted value. Over-approximating (line-granular for chained defs) and
 * therefore sound toward "may affect".
 */
export function valueReachableLines(cfg: FunctionCfg, target?: string): Set<number> {
  const seedVars = target ? [target] : cfg.params;
  const tainted = new Set<string>(); // "variable|defLine"
  for (const v of seedVars) tainted.add(`${v}|${cfg.paramLine}`);
  // A targeted local (non-parameter) is seeded from all of its definition sites.
  if (target && !cfg.params.includes(target)) {
    for (const e of cfg.defUse) if (e.variable === target) tainted.add(`${e.variable}|${e.defLine}`);
  }

  // Index the variables defined at each line, so when a tainted value FEEDS a
  // definition (an assignment RHS) we can taint that new def — even when the
  // feeding use and the def sit on different physical lines (a multi-line
  // initializer). `useInDefLine` carries the fed def's start line.
  const defVarsAtLine = new Map<number, Set<string>>();
  for (const e of cfg.defUse) {
    (defVarsAtLine.get(e.defLine) ?? defVarsAtLine.set(e.defLine, new Set()).get(e.defLine)!).add(e.variable);
  }

  const reached = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of cfg.defUse) {
      if (!tainted.has(`${e.variable}|${e.defLine}`)) continue;
      if (!reached.has(e.useLine)) { reached.add(e.useLine); changed = true; }
      // Chain forward: this tainted use feeds the def(s) at `useInDefLine`.
      const fedLine = e.useInDefLine;
      if (fedLine !== undefined) {
        for (const w of defVarsAtLine.get(fedLine) ?? []) {
          const key = `${w}|${fedLine}`;
          if (!tainted.has(key)) { tainted.add(key); changed = true; }
        }
      }
    }
  }
  return reached;
}

function findBody(fnNode: CfgNode, spec: CfgLangSpec): CfgNode | undefined {
  const direct = fnNode.childForFieldName(spec.bodyField);
  if (direct) return direct;
  // Fallback: first block-type child (arrow functions, lambdas with block bodies).
  for (const c of fnNode.namedChildren) if (spec.blockTypes.has(c.type)) return c;
  return undefined;
}

/** Breadth-first search for a node of `type` up to `maxDepth` levels deep. */
function findDescendantOfType(node: CfgNode, type: string, maxDepth: number): CfgNode | undefined {
  let frontier = [...node.namedChildren];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: CfgNode[] = [];
    for (const n of frontier) { if (n.type === type) return n; next.push(...n.namedChildren); }
    frontier = next;
  }
  return undefined;
}

function extractParamNames(fnNode: CfgNode, spec: CfgLangSpec): string[] {
  const params = fnNode.childForFieldName(spec.paramsField)
    // C/C++ nest the parameter_list under the `function_declarator`.
    ?? fnNode.childForFieldName('declarator')?.childForFieldName('parameters')
    ?? fnNode.namedChildren.find(c => c.type === 'parameters' || c.type === 'parameter_list' || c.type === 'formal_parameters')
    ?? findDescendantOfType(fnNode, 'parameter_list', 4);
  if (!params) return [];
  const names: string[] = [];
  const isBinder = (ty: string): boolean => ty === 'identifier' || spec.identTypes.has(ty); // PHP: variable_name
  const visit = (n: CfgNode): void => {
    // A parameter's binding identifier: required_parameter/optional_parameter
    // (TS), typed_parameter/identifier (Python), parameter_declaration (Go),
    // simple_parameter/variable_name (PHP).
    if (isBinder(n.type)) { names.push(n.text); return; }
    for (const c of n.namedChildren) {
      // Only descend into parameter wrappers, not default-value expressions.
      if (isBinder(c.type)) { names.push(c.text); return; }
      // Descend parameter wrappers and any binding pattern — tuple/object/array
      // plus variadics (TS `...rest` → rest_pattern, Python `*args`/`**kwargs` →
      // list_splat_pattern/dictionary_splat_pattern) — but not default-value exprs.
      if (c.type.includes('parameter') || c.type === 'pattern' || c.type.endsWith('_pattern')) {
        visit(c);
      }
    }
  };
  for (const c of params.namedChildren) visit(c);
  // Go named return values (`func f() (x int) { x = 5; return }`) live in a
  // second `parameter_list` under the `result` field — they are real in-scope
  // locals (zero-initialized), so treat them as parameters.
  const result = fnNode.childForFieldName('result');
  if (result && result.type === 'parameter_list') for (const c of result.namedChildren) visit(c);
  // Dedup, preserve order.
  return [...new Set(names)];
}
