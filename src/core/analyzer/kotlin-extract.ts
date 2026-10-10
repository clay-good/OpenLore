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
