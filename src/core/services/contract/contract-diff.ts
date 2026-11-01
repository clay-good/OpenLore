/**
 * Contract change rules and parity (change: add-service-contract-certification, OpenAPI phase).
 *
 * Pure functions over the normalized element model of `openapi.ts`:
 *
 * - {@link diffContracts}: a closed rule table, one verdict per changed element. A change the table
 *   cannot prove compatible is `potentially-breaking`, never silently safe.
 * - {@link contractParity}: operations with no indexed route handler, and indexed handlers on a path
 *   a specification covers but does not declare. Matching is literal: method plus normalized path
 *   template. Nothing is matched by similarity.
 */

import { normalizeUrl } from '../../analyzer/http-route-parser.js';
import type { ContractDocument, ContractOperation, ContractParam, ContractProperty } from './openapi.js';

export type ContractChangeClass = 'breaking' | 'dangerous' | 'non-breaking' | 'potentially-breaking';

/** The closed rule table: each rule and its class. */
export const CONTRACT_RULES = {
  'operation-removed': 'breaking',
  'operation-added': 'non-breaking',
  'operation-deprecated': 'dangerous',
  'required-param-added': 'breaking',
  'optional-param-added': 'non-breaking',
  'param-removed': 'non-breaking',
  'param-made-required': 'breaking',
  'param-type-changed': 'breaking',
  'body-added-required': 'breaking',
  'body-made-required': 'breaking',
  'required-body-property-added': 'breaking',
  'optional-body-property-added': 'non-breaking',
  'body-property-made-required': 'breaking',
  'body-property-type-changed': 'breaking',
  'body-property-widened': 'non-breaking',
  'response-property-removed': 'breaking',
  'response-property-made-optional': 'breaking',
  'response-property-added': 'non-breaking',
  'response-property-type-changed': 'breaking',
  'response-property-widened': 'dangerous',
  'schema-unassessed': 'potentially-breaking',
} as const satisfies Record<string, ContractChangeClass>;
export type ContractRule = keyof typeof CONTRACT_RULES;

export interface ContractChange {
  file: string;
  address: string;
  rule: ContractRule;
  class: ContractChangeClass;
  /** The element within the operation, when the rule is about one (`query:limit`, `email`). */
  element?: string;
  detail: string;
  line: number;
}

/** `string{["\"a\"","\"b\""]}` → its base type and encoded enum values (empty when it has none). */
function splitType(t: string | undefined): { base: string; values: string[] } {
  const m = /^([^{]*)(?:\{(.*)\})?$/.exec(t ?? '');
  let values: string[];
  try { values = m?.[2] !== undefined ? (JSON.parse(m[2]) as string[]) : []; } catch { values = []; }
  return { base: m?.[1] ?? '', values };
}

/**
 * A type change. A widening accepts every value the old type accepted: the same types (plus
 * possibly `null` or others) and format, with an enum that only gained values or was dropped.
 */
function typeChange(before: string | undefined, after: string | undefined): 'same' | 'widened' | 'changed' {
  if (before === after) return 'same';
  if (before === undefined || after === undefined) return 'changed';
  const b = splitType(before);
  const a = splitType(after);
  const [bTypes, bFmt = ''] = b.base.split(':');
  const [aTypes, aFmt = ''] = a.base.split(':');
  const aSet = new Set(aTypes.split('|'));
  if (bFmt !== aFmt || !bTypes.split('|').every(t => aSet.has(t))) return 'changed';
  if (a.values.length && !(b.values.length && b.values.every(v => a.values.includes(v)))) return 'changed';
  return 'widened';
}

function change(file: string, op: ContractOperation, rule: ContractRule, detail: string, element?: string): ContractChange {
  return { file, address: op.address, rule, class: CONTRACT_RULES[rule], ...(element ? { element } : {}), detail, line: op.line };
}

function diffParams(file: string, beforeOp: ContractOperation, after: ContractOperation, out: ContractChange[]): void {
  // A path parameter is matched by its position in the template: renaming `{id}` is not a wire change.
  const keyFor = (op: ContractOperation) => {
    const names = [...op.path.matchAll(/\{([^}]*)\}/g)].map(m => m[1]);
    // Header names are case-insensitive on the wire.
    return (p: ContractParam) => (p.in === 'path' && names.includes(p.name) ? `path:#${names.indexOf(p.name)}` : p.in === 'header' ? `header:${p.name.toLowerCase()}` : `${p.in}:${p.name}`);
  };
  const kb = keyFor(beforeOp);
  const ka = keyFor(after);
  const was = new Map(beforeOp.params.map(p => [kb(p), p]));
  const now = new Map(after.params.map(p => [ka(p), p]));
  for (const [k, p] of now) {
    const b = was.get(k);
    const el = `${p.in}:${p.name}`;
    if (!b) out.push(change(file, after, p.required ? 'required-param-added' : 'optional-param-added', `${p.in} parameter \`${p.name}\` added${p.required ? ', required' : ''}`, el));
    else {
      if (p.required && !b.required) out.push(change(file, after, 'param-made-required', `${p.in} parameter \`${p.name}\` is now required`, el));
      // A parameter only accepts a wider type safely; any other change breaks some caller.
      if (typeChange(b.type, p.type) === 'changed') out.push(change(file, after, 'param-type-changed', `${p.in} parameter \`${p.name}\`: ${b.type ?? '?'} → ${p.type ?? '?'}`, el));
      if (p.hash !== b.hash) out.push(change(file, after, 'schema-unassessed', `${p.in} parameter \`${p.name}\` changed outside the model (constraints, nested schema, or style)`, el));
    }
  }
  for (const [k, p] of was) if (!now.has(k)) out.push(change(file, after, 'param-removed', `${p.in} parameter \`${p.name}\` removed`, `${p.in}:${p.name}`));
}

function diffProps(
  file: string, op: ContractOperation, before: ContractProperty[], after: ContractProperty[], side: 'body' | 'response', out: ContractChange[],
): void {
  const was = new Map(before.map(p => [p.name, p]));
  const now = new Map(after.map(p => [p.name, p]));
  if (side === 'body') {
    for (const [n, p] of now) {
      const b = was.get(n);
      if (!b) out.push(change(file, op, p.required ? 'required-body-property-added' : 'optional-body-property-added', `request property \`${n}\` added${p.required ? ', required' : ''}`, n));
      else {
        if (p.required && !b.required) out.push(change(file, op, 'body-property-made-required', `request property \`${n}\` is now required`, n));
        const t = typeChange(b.type, p.type);
        if (t !== 'same') out.push(change(file, op, t === 'widened' ? 'body-property-widened' : 'body-property-type-changed', `request property \`${n}\`: ${b.type ?? '?'} → ${p.type ?? '?'}`, n));
        if (p.hash !== b.hash) out.push(change(file, op, 'schema-unassessed', `request property \`${n}\` changed outside the model (nested schema or constraints)`, n));
      }
    }
  } else {
    for (const [n, b] of was) {
      const p = now.get(n);
      if (!p) out.push(change(file, op, 'response-property-removed', `response property \`${n}\` removed`, n));
      else {
        const t = typeChange(b.type, p.type);
        if (t !== 'same') out.push(change(file, op, t === 'widened' ? 'response-property-widened' : 'response-property-type-changed', `response property \`${n}\`: ${b.type ?? '?'} → ${p.type ?? '?'}`, n));
        if (b.required && !p.required) out.push(change(file, op, 'response-property-made-optional', `response property \`${n}\` may now be absent`, n));
        if (p.hash !== b.hash) out.push(change(file, op, 'schema-unassessed', `response property \`${n}\` changed outside the model (nested schema or constraints)`, n));
      }
    }
    for (const n of now.keys()) if (!was.has(n)) out.push(change(file, op, 'response-property-added', `response property \`${n}\` added`, n));
  }
}

/** One operation's comparable content (no file, line, or path-parameter names). */
const fingerprint = (op: ContractOperation) => JSON.stringify([op.deprecated, op.params, op.body ?? null, op.response ?? null]);

function diffOperation(file: string, b: ContractOperation, op: ContractOperation, out: ContractChange[]): void {
  if (op.deprecated && !b.deprecated) out.push(change(file, op, 'operation-deprecated', `operation ${op.address} is now deprecated`));
  diffParams(file, b, op, out);
  // Request body.
  if (op.body && !b.body && op.body.required) out.push(change(file, op, 'body-added-required', 'a required request body was added'));
  else if (op.body && b.body) {
    if (op.body.required && !b.body.required) out.push(change(file, op, 'body-made-required', 'the request body is now required'));
    if (op.body.assessed && b.body.assessed) diffProps(file, op, b.body.properties, op.body.properties, 'body', out);
    // The hash covers what the property rules do not compare: any difference there is unassessed.
    if (op.body.hash !== b.body.hash) {
      out.push(change(file, op, 'schema-unassessed', 'the request body schema changed outside the model (oneOf/anyOf, an external $ref, arrays, or constraints)'));
    }
  }
  // Success response.
  if (b.response && op.response) {
    if (op.response.assessed && b.response.assessed) diffProps(file, op, b.response.properties, op.response.properties, 'response', out);
    if (op.response.hash !== b.response.hash) {
      out.push(change(file, op, 'schema-unassessed', 'the response schema changed outside the model (oneOf/anyOf, an external $ref, arrays, or constraints)'));
    }
  } else if (b.response && !op.response) {
    out.push(change(file, op, 'schema-unassessed', 'the success response schema was removed or is no longer readable'));
  }
}

/**
 * Compare the operations of two revisions of the specifications. Operations are matched by method
 * and path template with parameter names erased (renaming `{id}` is not a wire change), across all
 * files (an operation moved between files is not removed). An operation declared in more than one
 * file is compared as a set: any difference is `schema-unassessed`.
 */
export function diffContracts(base: readonly ContractDocument[], head: readonly ContractDocument[]): ContractChange[] {
  // Paths whose operations a side cannot read (behind an external or unresolved ref): an operation
  // missing there is not known to be removed or added.
  const opaque = (docs: readonly ContractDocument[]) => new Set(docs.flatMap(d => d.opaquePaths));
  const opaqueBase = opaque(base);
  const opaqueHead = opaque(head);
  const pathOf = (key: string) => key.slice(key.indexOf(' ') + 1);
  const index = (docs: readonly ContractDocument[]) => {
    const m = new Map<string, Array<{ file: string; op: ContractOperation }>>();
    for (const d of docs) for (const op of d.operations) m.set(op.key, [...(m.get(op.key) ?? []), { file: d.file, op }]);
    return m;
  };
  const was = index(base);
  const now = index(head);
  const out: ContractChange[] = [];
  for (const [key, bs] of was) {
    const ns = now.get(key);
    const b = bs[0];
    if (!ns) {
      if (opaqueHead.has(pathOf(key))) out.push(change(b.file, b.op, 'schema-unassessed', `operation ${b.op.address} is now behind a reference the model does not read`));
      else out.push(change(b.file, b.op, 'operation-removed', `operation ${b.op.address} removed`));
      continue;
    }
    if (bs.length > 1 || ns.length > 1) {
      const set = (l: typeof bs) => l.map(x => fingerprint(x.op)).sort().join('\n');
      if (set(bs) !== set(ns)) out.push(change(ns[0].file, ns[0].op, 'schema-unassessed', `operation ${ns[0].op.address} is declared more than once and changed`));
      continue;
    }
    diffOperation(ns[0].file, b.op, ns[0].op, out);
  }
  for (const [key, ns] of now) {
    if (was.has(key)) continue;
    if (opaqueBase.has(pathOf(key))) out.push(change(ns[0].file, ns[0].op, 'schema-unassessed', `operation ${ns[0].op.address} was behind a reference the model does not read`));
    else out.push(change(ns[0].file, ns[0].op, 'operation-added', `operation ${ns[0].op.address} added`));
  }
  const sortKey = (c: ContractChange) => `${c.address}\0${c.rule}\0${c.element ?? ''}\0${c.detail}`;
  return out.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
}

/** A server route as the route inventory records it. */
export interface IndexedRoute { method: string; path: string; file: string; handler: string }

export interface ParityResult {
  declaredUnimplemented: Array<{ file: string; address: string; line: number }>;
  implementedUndeclared: Array<{ method: string; path: string; file: string; handler: string }>;
  matched: number;
  /** Routes with a dynamic path segment (`*`): a boundary, never a finding. */
  dynamic: number;
}

const methodMatches = (a: string, b: string) => a === b || a === 'UNKNOWN' || a === 'ALL' || b === 'UNKNOWN';

/** The parent of a normalized path (`/v1/orders/:param` → `/v1/orders`). */
const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

/**
 * Two-way parity between the specifications and the indexed route handlers. A handler is
 * "covered" when its parent path equals a declared operation's path or that path's parent — so
 * with `/v1/orders/{id}` declared, `/v1/orders/export` and `/v1/orders/{id}/refund` are covered
 * while `/v1/ordersX` and `/internal/health` are not. A route is compared both with and without
 * the specification's base path (servers may mount the router under it).
 */
export function contractParity(docs: readonly ContractDocument[], routes: readonly IndexedRoute[]): ParityResult {
  const ops = docs.flatMap(d => d.operations.map(op => ({ file: d.file, op, full: normalizeUrl(op.path), bare: normalizeUrl(op.declaredPath) })));
  const routeNorm = routes.map(r => ({ r, n: normalizeUrl(r.path) }));
  const matchedRoutes = new Set<number>();
  const declaredUnimplemented: ParityResult['declaredUnimplemented'] = [];
  let matched = 0;
  for (const o of ops) {
    let hit = false;
    routeNorm.forEach(({ r, n }, i) => {
      if ((n === o.full || n === o.bare) && methodMatches(r.method.toUpperCase(), o.op.method)) { hit = true; matchedRoutes.add(i); }
    });
    if (hit) matched++;
    else declaredUnimplemented.push({ file: o.file, address: o.op.address, line: o.op.line });
  }
  const covered = new Set<string>();
  for (const o of ops) for (const p of [o.full, o.bare]) { covered.add(p); covered.add(parentOf(p)); }
  const implementedUndeclared: ParityResult['implementedUndeclared'] = [];
  let dynamic = 0;
  routeNorm.forEach(({ r, n }, i) => {
    if (matchedRoutes.has(i)) return;
    if (n.includes('*')) { dynamic++; return; } // a dynamic path is a boundary, not a finding
    if (covered.has(parentOf(n)) && parentOf(n) !== '/') implementedUndeclared.push({ method: r.method.toUpperCase(), path: r.path, file: r.file, handler: r.handler });
  });
  return {
    declaredUnimplemented: declaredUnimplemented.sort((a, b) => (a.address < b.address ? -1 : 1)),
    implementedUndeclared: implementedUndeclared.sort((a, b) => (`${a.path}${a.method}` < `${b.path}${b.method}` ? -1 : 1)),
    matched,
    dynamic,
  };
}

/** The version bump a set of changes calls for; `null` when compatibility is not proven. */
export function contractBump(changes: readonly ContractChange[]): 'major' | 'minor' | 'patch' | null {
  if (changes.some(c => c.class === 'breaking')) return 'major';
  if (changes.some(c => c.class === 'potentially-breaking')) return null;
  if (changes.some(c => c.rule.endsWith('-added') || c.rule.endsWith('-widened'))) return 'minor';
  return 'patch';
}
