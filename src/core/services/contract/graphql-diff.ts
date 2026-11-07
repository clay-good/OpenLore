/**
 * GraphQL change rules (change: add-contract-graph-projection, GraphQL phase).
 *
 * The GraphQL rows of the closed rule table in `contract-diff.ts`, over two merged schemas
 * (`mergeGraphqlSchema`). Operations are matched by root KIND and field name — a client writes
 * `query { order }`, never the root type's name, so renaming `Query` to `RootQuery` changes
 * nothing on the wire. Types are matched by name.
 *
 * Nullability follows variance: an OUTPUT may become stricter (`String` → `String!` is safe for
 * every reader) and never looser; an INPUT may become looser (`String!` → `String`) and never
 * stricter. Anything compared only by hash — a directive other than `@deprecated` — is
 * `schema-unassessed`, never silently "no change".
 */

import { type GqlArg, type GqlField, type GqlMergedType, type GqlSchema } from '../../analyzer/contract/graphql.js';
import { CONTRACT_RULES, type ContractChange, type ContractRule } from './contract-diff.js';

interface TypeShape { nonNull: boolean; list?: TypeShape; name?: string }

/** `[ID!]!` → its structure. */
function shape(t: string): TypeShape {
  const nonNull = t.endsWith('!');
  const core = nonNull ? t.slice(0, -1) : t;
  return core.startsWith('[') ? { nonNull, list: shape(core.slice(1, -1)) } : { nonNull, name: core };
}

/** Whether every value of type `n` is a valid value of type `o` (n is a subtype of o: safe for an output). */
function covariant(o: TypeShape, n: TypeShape): boolean {
  if (o.nonNull && !n.nonNull) return false;
  if (!!o.list !== !!n.list) return false;
  return o.list ? covariant(o.list, n.list!) : o.name === n.name;
}

/** The change from `before` to `after` in an output position. */
function outputChange(before: string, after: string): 'same' | 'stricter' | 'changed' {
  if (before === after) return 'same';
  return covariant(shape(before), shape(after)) ? 'stricter' : 'changed';
}

/** The change from `before` to `after` in an input position. */
function inputChange(before: string, after: string): 'same' | 'looser' | 'required' | 'changed' {
  if (before === after) return 'same';
  // A looser input accepts everything the stricter one did: `after` is a supertype of `before`.
  if (covariant(shape(after), shape(before))) return 'looser';
  if (covariant(shape(before), shape(after))) return 'required';
  return 'changed';
}

const change = (file: string, address: string, line: number, rule: ContractRule, detail: string, element?: string): ContractChange =>
  ({ file, address, rule, class: CONTRACT_RULES[rule], ...(element ? { element } : {}), detail, line });

const fileOf = (t: GqlMergedType, f?: { file?: string }) => f?.file ?? t.file;

/** An argument or input field is required when it is non-null and has no default. */
const required = (a: { type: string; defaultValue?: string }) => a.type.endsWith('!') && a.defaultValue === undefined;

function diffArgs(file: string, address: string, line: number, before: GqlArg[], after: GqlArg[], out: ContractChange[]): void {
  const was = new Map(before.map(a => [a.name, a]));
  const now = new Map(after.map(a => [a.name, a]));
  for (const [n, a] of now) {
    const b = was.get(n);
    const el = `argument ${n}`;
    if (!b) {
      out.push(change(file, address, a.line, required(a) ? 'required-param-added' : 'optional-param-added', `argument \`${n}: ${a.type}\` added${required(a) ? ', required' : ''}`, el));
      continue;
    }
    const c = inputChange(b.type, a.type);
    if (c === 'looser') out.push(change(file, address, a.line, 'input-made-optional', `argument \`${n}\`: ${b.type} → ${a.type}`, el));
    // Stricter with a default: omitting it still works, but an explicit `null` is now refused.
    else if (c === 'required') out.push(change(file, address, a.line, a.defaultValue !== undefined ? 'field-type-changed' : 'param-made-required', `argument \`${n}\`: ${b.type} → ${a.type}`, el));
    else if (c === 'changed') out.push(change(file, address, a.line, 'field-type-changed', `argument \`${n}\`: ${b.type} → ${a.type}`, el));
    if ((b.defaultValue ?? null) !== (a.defaultValue ?? null) && c !== 'required') out.push(change(file, address, a.line, 'arg-default-changed', `argument \`${n}\`: default ${b.defaultValue ?? '(none)'} → ${a.defaultValue ?? '(none)'}`, el));
    if (a.deprecated && !b.deprecated) out.push(change(file, address, a.line, 'field-deprecated', `argument \`${n}\` is now deprecated`, el));
    if (a.directivesHash !== b.directivesHash) out.push(change(file, address, a.line, 'schema-unassessed', `argument \`${n}\`: a directive changed (directives are outside the model)`, el));
  }
  for (const n of was.keys()) if (!now.has(n)) out.push(change(file, address, line, 'arg-removed', `argument \`${n}\` removed`, `argument ${n}`));
}

/** Compare one output field (an object/interface field, or a root field). */
function diffOutputField(file: string, address: string, b: GqlField, f: GqlField, out: ContractChange[], element?: string): void {
  const c = outputChange(b.type, f.type);
  if (c === 'stricter') out.push(change(file, address, f.line, 'output-field-made-non-null', `${element ?? 'result'}: ${b.type} → ${f.type}`, element));
  else if (c === 'changed') out.push(change(file, address, f.line, 'field-type-changed', `${element ?? 'result'}: ${b.type} → ${f.type}`, element));
  diffArgs(file, address, f.line, b.args, f.args, out);
  if (f.deprecated && !b.deprecated) out.push(change(file, address, f.line, element ? 'field-deprecated' : 'operation-deprecated', `${element ?? address} is now deprecated`, element));
  if (f.directivesHash !== b.directivesHash) out.push(change(file, address, f.line, 'schema-unassessed', `${element ?? address}: a directive changed (directives are outside the model)`, element));
}

function diffType(b: GqlMergedType, t: GqlMergedType, out: ContractChange[]): void {
  const push = (rule: ContractRule, detail: string, line: number, element?: string, file = t.file) => out.push(change(file, t.name, line, rule, detail, element));
  if (b.kind !== t.kind) { push('type-removed', `${t.name} changed from ${b.kind} to ${t.kind}`, t.line); return; }
  const was = new Map(b.fields.map(f => [f.name, f]));
  const now = new Map(t.fields.map(f => [f.name, f]));
  for (const [n, f] of now) {
    const old = was.get(n);
    const el = `field ${n}`;
    if (!old) {
      push(t.kind === 'input' && required(f) ? 'required-input-field-added' : 'field-added', `field \`${n}: ${f.type}\` added${t.kind === 'input' && required(f) ? ', required' : ''}`, f.line, el, fileOf(t, f));
      continue;
    }
    if (t.kind === 'input') {
      const c = inputChange(old.type, f.type);
      if (c === 'looser') push('input-made-optional', `field \`${n}\`: ${old.type} → ${f.type}`, f.line, el, fileOf(t, f));
      else if (c === 'required') push(f.defaultValue !== undefined ? 'field-type-changed' : 'param-made-required', `field \`${n}\`: ${old.type} → ${f.type}`, f.line, el, fileOf(t, f));
      else if (c === 'changed') push('field-type-changed', `field \`${n}\`: ${old.type} → ${f.type}`, f.line, el, fileOf(t, f));
      if ((old.defaultValue ?? null) !== (f.defaultValue ?? null) && c !== 'required') push('arg-default-changed', `field \`${n}\`: default ${old.defaultValue ?? '(none)'} → ${f.defaultValue ?? '(none)'}`, f.line, el, fileOf(t, f));
      if (f.deprecated && !old.deprecated) push('field-deprecated', `field \`${n}\` is now deprecated`, f.line, el, fileOf(t, f));
      if (f.directivesHash !== old.directivesHash) push('schema-unassessed', `field \`${n}\`: a directive changed (directives are outside the model)`, f.line, el, fileOf(t, f));
    } else diffOutputField(fileOf(t, f), t.name, old, f, out, el);
  }
  for (const [n, old] of was) if (!now.has(n)) push('field-removed', `field \`${n}\` removed`, t.line, `field ${n}`, fileOf(b, old));
  const bValues = new Map(b.values.map(v => [v.name, v]));
  for (const v of t.values) {
    const old = bValues.get(v.name);
    if (!old) { push('graphql-enum-value-added', `enum value ${v.name} added (a client switching over this enum may not handle it)`, v.line, v.name); continue; }
    if (v.deprecated && !old.deprecated) push('enum-value-deprecated', `enum value ${v.name} is now deprecated`, v.line, v.name);
    if (v.directivesHash !== old.directivesHash) push('schema-unassessed', `enum value ${v.name}: a directive changed (directives are outside the model)`, v.line, v.name);
  }
  const tValues = new Set(t.values.map(v => v.name));
  for (const v of b.values) if (!tValues.has(v.name)) push('enum-value-removed', `enum value ${v.name} removed`, t.line, v.name);
  for (const m of t.members) if (!b.members.includes(m)) push('union-member-added', `union member ${m} added (a client switching over the union may not handle it)`, t.line, m);
  for (const m of b.members) if (!t.members.includes(m)) push('union-member-removed', `union member ${m} removed`, t.line, m);
  for (const i of t.interfaces) if (!b.interfaces.includes(i)) push('interface-added', `now implements ${i}`, t.line, i);
  for (const i of b.interfaces) if (!t.interfaces.includes(i)) push('interface-removed', `no longer implements ${i}`, t.line, i);
  if (b.directivesHash !== t.directivesHash) push('schema-unassessed', `${t.name}: a directive changed (directives are outside the model)`, t.line);
}

/** Compare the merged GraphQL schemas of two revisions. */
export function diffGraphql(base: GqlSchema, head: GqlSchema): ContractChange[] {
  const out: ContractChange[] = [];
  const rootSet = (s: GqlSchema) => new Set(Object.values(s.roots));
  const baseRoots = rootSet(base);
  const headRoots = rootSet(head);
  // ── Operations, by root kind ──
  for (const kind of ['query', 'mutation', 'subscription'] as const) {
    // A root type defined in two files is absent from the merged map: its fields are not compared,
    // never read as every operation removed (or added).
    const bAmbiguous = base.ambiguous.find(a => a.name === base.roots[kind]);
    const hAmbiguous = head.ambiguous.find(a => a.name === head.roots[kind]);
    if (bAmbiguous || hAmbiguous) {
      const one = hAmbiguous ?? bAmbiguous!;
      if (!(bAmbiguous && hAmbiguous)) out.push(change(one.files[0], one.name, 1, 'schema-unassessed', `the ${kind} root type ${one.name} is defined in more than one file ${hAmbiguous ? 'at head' : 'at the base revision'}, so its operations are not compared`));
      continue;
    }
    const b = base.types.get(base.roots[kind]);
    const h = head.types.get(head.roots[kind]);
    const was = new Map((b?.fields ?? []).map(f => [f.name, f]));
    const now = new Map((h?.fields ?? []).map(f => [f.name, f]));
    for (const [n, f] of now) {
      const address = `${h!.name}.${n}`;
      const old = was.get(n);
      if (!old) { out.push(change(fileOf(h!, f), address, f.line, 'operation-added', `${kind} ${n} added`)); continue; }
      diffOutputField(fileOf(h!, f), address, old, f, out);
    }
    for (const [n, old] of was) {
      if (now.has(n)) continue;
      out.push(change(fileOf(b!, old), `${b!.name}.${n}`, old.line, 'operation-removed', `${kind} ${n} removed`));
    }
  }
  // ── Types, by name ──
  for (const [name, b] of base.types) {
    if (baseRoots.has(name)) continue;
    const t = head.types.get(name);
    if (!t) {
      // Defined twice at head is ambiguous there, not removed.
      if (head.ambiguous.some(a => a.name === name)) out.push(change(b.file, name, b.line, 'schema-unassessed', `${name} is defined in more than one file at head, so it is not compared`));
      else if (!headRoots.has(name)) out.push(change(b.file, name, b.line, 'type-removed', `${b.kind} ${name} removed`));
      continue;
    }
    if (headRoots.has(name)) continue;
    diffType(b, t, out);
  }
  for (const [name, t] of head.types) {
    if (headRoots.has(name) || base.types.has(name) || baseRoots.has(name)) continue;
    if (base.ambiguous.some(a => a.name === name)) out.push(change(t.file, name, t.line, 'schema-unassessed', `${name} was defined in more than one file at the base revision, so it is not compared`));
    else out.push(change(t.file, name, t.line, 'type-added', `${t.kind} ${name} added`));
  }
  const sortKey = (c: ContractChange) => `${c.address}\0${c.rule}\0${c.element ?? ''}\0${c.detail}`;
  return out.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
}

