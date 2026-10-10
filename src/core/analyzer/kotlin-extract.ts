/**
 * Kotlin facts read from the parse tree while Pass 1 owns it (issue #546).
 *
 * Everything returned is plain data, so it survives the extraction-worker structured clone and the
 * Pass-1 fact cache. The functions take the minimal structural node view the call-graph extractor
 * already uses; they never import the parser.
 *
 * Grammar note (`tree-sitter-kotlin` 0.3.8): in `class A(d: I) : I by d { … }` the class body is
 * parsed as a trailing lambda of the delegate expression, not as a `class_body`. Every walk over
 * the members of a class therefore goes through {@link kotlinClassMembers}.
 */
import type { ReceiverFieldFact } from './receiver-registry.js';

export interface KotlinNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  parent: KotlinNode | null;
  namedChildren: KotlinNode[];
}

/** A declared parameter of a function or constructor. */
export interface KotlinParameter {
  name: string;
  /** Declared type as written, whitespace-normalized. */
  type?: string;
  hasDefault?: true;
  isVararg?: true;
}

const CLASS_LIKE = new Set(['class_declaration', 'object_declaration', 'companion_object']);
const TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type', 'parenthesized_type', 'dynamic_type', 'not_nullable_type']);

const child = (node: KotlinNode, type: string): KotlinNode | undefined =>
  node.namedChildren.find(c => c.type === type);

const unquote = (name: string): string => (name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name);

/** The declared name of a class, interface, object, or named companion. */
export function kotlinTypeName(node: KotlinNode): string | undefined {
  const name = child(node, 'type_identifier') ?? child(node, 'simple_identifier');
  return name ? unquote(name.text) : undefined;
}

/**
 * The class a member belongs to. A companion object is not an owner: its members belong to the
 * enclosing class, as the existing `enclosingGroupName` rule already has it for an unnamed one.
 */
export function kotlinOwnerName(node: KotlinNode): string | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === 'class_declaration' || cur.type === 'object_declaration') return kotlinTypeName(cur);
  }
  return undefined;
}

/**
 * The member declarations of a class-like node: the children of its body, or — for the delegation
 * grammar quirk described in the module header — the statements of the trailing lambda.
 */
export function kotlinClassMembers(classNode: KotlinNode): KotlinNode[] {
  const body = child(classNode, 'class_body') ?? child(classNode, 'enum_class_body');
  if (body) return body.namedChildren;
  for (const spec of classNode.namedChildren) {
    if (spec.type !== 'delegation_specifier') continue;
    const call = child(spec, 'explicit_delegation') && child(child(spec, 'explicit_delegation')!, 'call_expression');
    const lambda = call && child(call, 'call_suffix') && child(child(call, 'call_suffix')!, 'annotated_lambda');
    const literal = lambda && child(lambda, 'lambda_literal');
    const statements = literal && child(literal, 'statements');
    if (statements) return statements.namedChildren;
  }
  return [];
}

/**
 * Reduce a declared type to the simple name a receiver can be looked up by: `Repo?` → `Repo`,
 * `List<Repo>` → `List`, `a.b.Repo` → `Repo`. A function type, a `dynamic` type, and a lower-case
 * name (a type parameter or a primitive alias) give nothing.
 */
export function kotlinReceiverTypeName(typeNode: KotlinNode | undefined): string | undefined {
  let node = typeNode;
  for (let guard = 0; node && guard < 6; guard++) {
    if (node.type === 'nullable_type' || node.type === 'parenthesized_type' || node.type === 'not_nullable_type') {
      node = node.namedChildren.find(c => TYPE_NODES.has(c.type));
      continue;
    }
    if (node.type !== 'user_type') return undefined;
    const names = node.namedChildren.filter(c => c.type === 'type_identifier');
    const name = names.at(-1)?.text;
    return name && /^[A-Z]/.test(name) ? name : undefined;
  }
  return undefined;
}

const typeChild = (node: KotlinNode): KotlinNode | undefined => node.namedChildren.find(c => TYPE_NODES.has(c.type));
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `Foo(...)` — a call whose callee is one capitalized identifier. */
function constructedType(value: KotlinNode | undefined): string | undefined {
  if (value?.type !== 'call_expression') return undefined;
  const callee = value.namedChildren[0];
  return callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text) ? callee.text : undefined;
}

/** Parameters of a `function_declaration` or `secondary_constructor`, in source order. */
export function kotlinFunctionParameters(fnNode: KotlinNode): KotlinParameter[] {
  const list = child(fnNode, 'function_value_parameters');
  if (!list) return [];
  const out: KotlinParameter[] = [];
  const children = list.namedChildren;
  for (let i = 0; i < children.length; i++) {
    const param = children[i];
    if (param.type !== 'parameter') continue;
    const name = child(param, 'simple_identifier');
    if (!name) continue;
    const type = typeChild(param);
    const modifiers = children[i - 1]?.type === 'parameter_modifiers' ? children[i - 1].text : '';
    // A default value is a sibling expression that follows the parameter in this grammar.
    const next = children[i + 1];
    const hasDefault = !!next && next.type !== 'parameter' && next.type !== 'parameter_modifiers';
    out.push({
      name: unquote(name.text),
      ...(type ? { type: normalize(type.text) } : {}),
      ...(hasDefault ? { hasDefault: true as const } : {}),
      ...(/\bvararg\b/.test(modifiers) ? { isVararg: true as const } : {}),
    });
  }
  return out;
}

/** The declared return type of a `function_declaration`, as written; undefined when not written. */
export function kotlinReturnType(fnNode: KotlinNode): string | undefined {
  const params = child(fnNode, 'function_value_parameters');
  if (!params) return undefined;
  const type = fnNode.namedChildren.find(c => TYPE_NODES.has(c.type) && c.startIndex >= params.endIndex);
  return type ? normalize(type.text) : undefined;
}

/** `name → receiver type` for the parameters of one function, dropping conflicting duplicates. */
export function kotlinParameterReceiverTypes(fnNode: KotlinNode): Record<string, string> {
  const list = child(fnNode, 'function_value_parameters');
  const out: Record<string, string> = {};
  const refused = new Set<string>();
  for (const param of list?.namedChildren ?? []) {
    if (param.type !== 'parameter') continue;
    const name = child(param, 'simple_identifier');
    const type = kotlinReceiverTypeName(typeChild(param));
    if (!name || !type) continue;
    const key = unquote(name.text);
    if (out[key] !== undefined && out[key] !== type) refused.add(key);
    out[key] = type;
  }
  for (const key of refused) delete out[key];
  return out;
}

/**
 * `Class.property → declared type` for every class in the file
 * (change: add-kotlin-declared-type-receivers). A property types a receiver when the source says
 * its type: a primary-constructor `val` / `var`, a body property with a written type, or a body
 * property initialized by a constructor call. Nothing is inferred from use. Conflicting
 * observations are kept as separate facts; the registry refuses the pair.
 */
export function collectKotlinReceiverFields(root: KotlinNode): ReceiverFieldFact[] {
  const facts: ReceiverFieldFact[] = [];
  const stack: KotlinNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
    if (!CLASS_LIKE.has(node.type)) continue;
    const className = node.type === 'companion_object' ? kotlinOwnerName(node) : kotlinTypeName(node);
    if (!className) continue;
    const constructor = child(node, 'primary_constructor');
    for (const param of constructor?.namedChildren ?? []) {
      if (param.type !== 'class_parameter' || !child(param, 'binding_pattern_kind')) continue;
      const name = child(param, 'simple_identifier');
      const type = kotlinReceiverTypeName(typeChild(param));
      if (name && type) facts.push({ className, field: unquote(name.text), type });
    }
    for (const member of kotlinClassMembers(node)) {
      if (member.type !== 'property_declaration') continue;
      const declaration = child(member, 'variable_declaration');
      const name = declaration && child(declaration, 'simple_identifier');
      if (!declaration || !name) continue;
      const type = kotlinReceiverTypeName(typeChild(declaration))
        ?? constructedType(member.namedChildren.find(c => c.type === 'call_expression'));
      if (type) facts.push({ className, field: unquote(name.text), type });
    }
  }
  return facts;
}

// ── Executable bodies that are not named functions (change: add-kotlin-callable-node-shapes) ──

export interface KotlinSpan { start: number; end: number }

export type KotlinBodyKind = 'constructor' | 'class-initializer' | 'file-initializer' | 'script' | 'getter' | 'setter' | 'function-property';

/** A graph node for a Kotlin body that executes but is not a `fun` declaration. */
export interface KotlinBodyNode {
  kind: KotlinBodyKind;
  /** `<init>`, `<clinit>`, `<script>`, `<get-x>`, `<set-x>`, or the property name. */
  name: string;
  className?: string;
  startIndex: number;
  endIndex: number;
  /** More source regions that run as part of this body (init blocks, property initializers). */
  bodySpans?: KotlinSpan[];
  /** True for a name that is not a source identifier. */
  synthetic: boolean;
  parameters?: KotlinParameter[];
}

const span = (node: KotlinNode): KotlinSpan => ({ start: node.startIndex, end: node.endIndex });

/** A lambda or an anonymous function: the initializer shape that makes a property callable. */
const isFunctionValue = (node: KotlinNode | undefined): boolean =>
  node?.type === 'lambda_literal' || node?.type === 'anonymous_function';

const propertyName = (property: KotlinNode): string | undefined => {
  const declaration = child(property, 'variable_declaration');
  const name = declaration && child(declaration, 'simple_identifier');
  return name ? unquote(name.text) : undefined;
};

/** The value a property is initialized with: its last child that is not part of the header. */
function propertyInitializer(property: KotlinNode): KotlinNode | undefined {
  const header = new Set(['modifiers', 'binding_pattern_kind', 'variable_declaration', 'multi_variable_declaration', 'type_parameters', 'type_constraints', 'getter', 'setter', 'user_type', 'nullable_type', 'function_type', 'parenthesized_type']);
  return property.namedChildren.find(c => !header.has(c.type));
}

/**
 * Accessors of a property. A getter or setter is either a child of the `property_declaration`
 * (`val x: Int get() = …` on one line) or a following sibling (the usual multi-line form).
 */
function accessorsOf(members: KotlinNode[], index: number): KotlinNode[] {
  const property = members[index];
  const out = property.namedChildren.filter(c => c.type === 'getter' || c.type === 'setter');
  for (let i = index + 1; i < members.length; i++) {
    if (members[i].type !== 'getter' && members[i].type !== 'setter') break;
    out.push(members[i]);
  }
  return out;
}

const hasBody = (accessor: KotlinNode): boolean => !!child(accessor, 'function_body');

function parametersOfConstructor(primary: KotlinNode | undefined): KotlinParameter[] {
  const out: KotlinParameter[] = [];
  for (const param of primary?.namedChildren ?? []) {
    if (param.type !== 'class_parameter') continue;
    const name = child(param, 'simple_identifier');
    if (!name) continue;
    const type = typeChild(param);
    const hasDefault = param.namedChildren.some(c => c !== name && !TYPE_NODES.has(c.type)
      && c.type !== 'modifiers' && c.type !== 'binding_pattern_kind');
    out.push({ name: unquote(name.text), ...(type ? { type: normalize(type.text) } : {}), ...(hasDefault ? { hasDefault: true as const } : {}) });
  }
  return out;
}

/** Body nodes of the properties among `members`, plus the spans that belong to the initializer. */
function collectPropertyBodies(
  members: KotlinNode[],
  className: string | undefined,
  out: KotlinBodyNode[],
  initializerSpans: KotlinSpan[],
): void {
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member.type === 'anonymous_initializer') { initializerSpans.push(span(member)); continue; }
    if (member.type !== 'property_declaration') continue;
    const name = propertyName(member);
    if (!name) continue;
    const initializer = propertyInitializer(member);
    if (isFunctionValue(initializer)) {
      out.push({ kind: 'function-property', name, className, startIndex: member.startIndex, endIndex: member.endIndex, synthetic: false });
    } else if (initializer) {
      initializerSpans.push(span(initializer));
    }
    for (const accessor of accessorsOf(members, i)) {
      if (!hasBody(accessor)) continue;
      const kind = accessor.type === 'getter' ? 'getter' : 'setter';
      out.push({
        kind, name: `<${kind === 'getter' ? 'get' : 'set'}-${name}>`, className,
        startIndex: accessor.startIndex, endIndex: accessor.endIndex, synthetic: true,
      });
    }
  }
}

/**
 * Every Kotlin body that executes and is not a `fun` declaration: constructors with their `init`
 * blocks and property initializers, object and companion initializers, accessors with a body,
 * function-typed properties, the file's top-level property initializers, and a script body.
 *
 * One `<init>` stands for all constructors of a class, as overloads share one node everywhere in
 * the graph. Spans never overlap a `fun` declaration, so a call site still belongs to exactly one
 * innermost node.
 */
export function collectKotlinBodyNodes(root: KotlinNode, isScript: boolean): KotlinBodyNode[] {
  const out: KotlinBodyNode[] = [];
  const stack: KotlinNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
    if (!CLASS_LIKE.has(node.type)) continue;
    const isInterface = kotlinIsInterface(node);
    const owner = node.type === 'companion_object' ? kotlinOwnerName(node) : kotlinTypeName(node);
    if (!owner) continue;
    const members = kotlinClassMembers(node);
    const spans: KotlinSpan[] = [];
    collectPropertyBodies(members, owner, out, spans);
    if (isInterface) continue;
    const primary = child(node, 'primary_constructor');
    const secondaries = members.filter(m => m.type === 'secondary_constructor');
    // Supertype constructor arguments and delegate expressions run during construction.
    for (const spec of node.namedChildren) {
      if (spec.type !== 'delegation_specifier') continue;
      const invocation = child(spec, 'constructor_invocation');
      const args = invocation && child(invocation, 'value_arguments');
      if (args) spans.push(span(args));
    }
    for (const secondary of secondaries) spans.push(span(secondary));
    const anchor = primary ?? node.namedChildren.find(c => c.type === 'type_identifier') ?? node;
    // A companion's initializer runs when the class loads; an object's when it is first used.
    const name = node.type === 'companion_object' ? '<clinit>' : '<init>';
    const anchorSpan = anchor === node ? { start: node.startIndex, end: Math.min(node.endIndex, node.startIndex + 'companion object'.length) } : span(anchor);
    out.push({
      kind: node.type === 'companion_object' ? 'class-initializer' : 'constructor',
      name, className: owner,
      startIndex: anchorSpan.start, endIndex: anchorSpan.end,
      ...(spans.length ? { bodySpans: spans } : {}),
      synthetic: true,
      ...(node.type === 'class_declaration'
        ? { parameters: primary ? parametersOfConstructor(primary) : (secondaries[0] ? kotlinFunctionParameters(secondaries[0]) : []) }
        : {}),
    });
  }

  // Package level.
  const top = root.namedChildren;
  const fileSpans: KotlinSpan[] = [];
  collectPropertyBodies(top, undefined, out, fileSpans);
  if (isScript) {
    out.push({ kind: 'script', name: '<script>', startIndex: root.startIndex, endIndex: root.endIndex, synthetic: true });
  } else if (fileSpans.length > 0) {
    const [first, ...rest] = fileSpans;
    out.push({
      kind: 'file-initializer', name: '<clinit>', startIndex: first.start, endIndex: first.end,
      ...(rest.length ? { bodySpans: rest } : {}), synthetic: true,
    });
  }
  return out;
}

/**
 * The keywords written before the name of a class-like node (`sealed interface`, `enum class`,
 * `data object`, …). The grammar gives interfaces and classes the same node type, so the keyword
 * is the only evidence of which one a declaration is.
 */
export function kotlinDeclarationKeywords(node: KotlinNode): string[] {
  const name = node.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'simple_identifier');
  const modifiers = child(node, 'modifiers');
  const from = modifiers ? modifiers.endIndex - node.startIndex : 0;
  const to = name ? name.startIndex - node.startIndex : Math.min(node.text.length, 40);
  const words = node.text.slice(Math.max(0, from), Math.max(from, to)).split(/\s+/).filter(w => /^[a-z]+$/.test(w));
  return [...(modifiers ? kotlinModifiers(node) : []), ...words];
}

export function kotlinIsInterface(node: KotlinNode): boolean {
  return node.type === 'class_declaration' && kotlinDeclarationKeywords(node).includes('interface');
}

/** Declaration modifiers of a function (`suspend`, `infix`, `operator`, `override`, `private`, …). */
export function kotlinModifiers(fnNode: KotlinNode): string[] {
  const modifiers = child(fnNode, 'modifiers');
  if (!modifiers) return [];
  const out: string[] = [];
  for (const m of modifiers.namedChildren) {
    if (m.type === 'annotation') continue;
    for (const word of m.text.split(/\s+/)) if (/^[a-z]+$/.test(word)) out.push(word);
  }
  return out;
}

/** A call shape that the call query does not capture, as a plain raw-edge record. */
export interface KotlinExtraCall {
  offset: number;
  line: number;
  calleeName: string;
  calleeObject?: string;
  shape: 'reference' | 'infix' | 'super-constructor';
}

/**
 * Callable references (`::f`, `Type::m`, `obj::m`, `::Type`), infix calls (`a f b`), and
 * supertype constructor invocations (`: Base(args)`, `: super(args)`).
 */
export function collectKotlinExtraCalls(root: KotlinNode): KotlinExtraCall[] {
  const out: KotlinExtraCall[] = [];
  const stack: KotlinNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
    const at = { offset: node.startIndex, line: node.startPosition.row + 1 };
    if (node.type === 'callable_reference') {
      const parts = node.namedChildren;
      const name = parts.at(-1);
      if (!name || name.type !== 'simple_identifier') continue; // `X::class` is not a callable
      const receiver = parts.length > 1 ? parts[0] : undefined;
      // `this::m` and `super::m` appear as an anonymous receiver token before `::`.
      const written = receiver?.text ?? (/^(this|super)\s*::/.exec(node.text)?.[1]);
      out.push({ ...at, calleeName: unquote(name.text), ...(written ? { calleeObject: written } : {}), shape: 'reference' });
    } else if (node.type === 'navigation_expression') {
      // `this::m`, `super::m`, and `a.b::m` are navigation expressions whose suffix is `::name`.
      const suffix = node.namedChildren.at(-1);
      if (suffix?.type !== 'navigation_suffix' || !suffix.text.startsWith('::')) continue;
      const name = child(suffix, 'simple_identifier');
      const receiver = node.namedChildren[0];
      if (name && receiver && receiver !== suffix) {
        out.push({ ...at, calleeName: unquote(name.text), calleeObject: receiver.text, shape: 'reference' });
      }
    } else if (node.type === 'infix_expression') {
      const [left, operator] = node.namedChildren;
      if (operator?.type !== 'simple_identifier' || !left) continue;
      out.push({ ...at, calleeName: unquote(operator.text), calleeObject: left.text, shape: 'infix' });
    } else if (node.type === 'constructor_invocation') {
      const type = kotlinReceiverTypeName(child(node, 'user_type'));
      // Attributed to the class's `<init>` through the argument-list span.
      const args = child(node, 'value_arguments');
      if (type && args) out.push({ offset: args.startIndex, line: args.startPosition.row + 1, calleeName: type, shape: 'super-constructor' });
    } else if (node.type === 'constructor_delegation_call') {
      if (!/^super\b/.test(node.text)) continue; // `this(...)`: constructors of a class are one node
      for (let cur = node.parent; cur; cur = cur.parent) {
        if (cur.type !== 'class_declaration') continue;
        const parent = cur.namedChildren.find(c => c.type === 'delegation_specifier');
        const type = parent && kotlinReceiverTypeName(child(parent, 'user_type') ?? (child(parent, 'constructor_invocation') && child(child(parent, 'constructor_invocation')!, 'user_type')));
        if (type) out.push({ ...at, calleeName: type, shape: 'super-constructor' });
        break;
      }
    }
  }
  return out;
}
