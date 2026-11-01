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
  'body-enum-widened': 'non-breaking',
  'response-property-removed': 'breaking',
  'response-property-added': 'non-breaking',
  'response-property-type-changed': 'breaking',
  'response-enum-widened': 'dangerous',
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

/** `string{a,b}` → its base type and enum values (empty when it has none). */
function splitType(t: string | undefined): { base: string; values: string[] } {
  const m = /^([^{]*)(?:\{(.*)\})?$/.exec(t ?? '');
  return { base: m?.[1] ?? '', values: m?.[2] !== undefined ? m[2].split(',') : [] };
}

/** A type change: an enum that only gained values is a widening; anything else is a change. */
function typeChange(before: string | undefined, after: string | undefined): 'same' | 'widened' | 'changed' {
  if (before === after) return 'same';
  if (before === undefined || after === undefined) return 'changed';
  const b = splitType(before);
  const a = splitType(after);
  if (b.base === a.base && b.values.length && b.values.every(v => a.values.includes(v))) return 'widened';
  return 'changed';
}

function change(file: string, op: ContractOperation, rule: ContractRule, detail: string, element?: string): ContractChange {
  return { file, address: op.address, rule, class: CONTRACT_RULES[rule], ...(element ? { element } : {}), detail, line: op.line };
}

function diffParams(file: string, before: ContractParam[], after: ContractOperation, out: ContractChange[]): void {
  const key = (p: ContractParam) => `${p.in}:${p.name}`;
  const was = new Map(before.map(p => [key(p), p]));
  const now = new Map(after.params.map(p => [key(p), p]));
  for (const [k, p] of now) {
    const b = was.get(k);
    if (!b) out.push(change(file, after, p.required ? 'required-param-added' : 'optional-param-added', `${p.in} parameter \`${p.name}\` added${p.required ? ', required' : ''}`, k));
    else {
      if (p.required && !b.required) out.push(change(file, after, 'param-made-required', `${p.in} parameter \`${p.name}\` is now required`, k));
      if (typeChange(b.type, p.type) !== 'same') out.push(change(file, after, 'param-type-changed', `${p.in} parameter \`${p.name}\`: ${b.type ?? '?'} → ${p.type ?? '?'}`, k));
    }
  }
  for (const [k, p] of was) if (!now.has(k)) out.push(change(file, after, 'param-removed', `${p.in} parameter \`${p.name}\` removed`, k));
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
        if (t !== 'same') out.push(change(file, op, t === 'widened' ? 'body-enum-widened' : 'body-property-type-changed', `request property \`${n}\`: ${b.type ?? '?'} → ${p.type ?? '?'}`, n));
      }
    }
  } else {
    for (const [n, b] of was) {
      const p = now.get(n);
      if (!p) out.push(change(file, op, 'response-property-removed', `response property \`${n}\` removed`, n));
      else {
        const t = typeChange(b.type, p.type);
        if (t !== 'same') out.push(change(file, op, t === 'widened' ? 'response-enum-widened' : 'response-property-type-changed', `response property \`${n}\`: ${b.type ?? '?'} → ${p.type ?? '?'}`, n));
      }
    }
    for (const n of now.keys()) if (!was.has(n)) out.push(change(file, op, 'response-property-added', `response property \`${n}\` added`, n));
  }
}

/**
 * Compare the operations of two revisions of the specifications. Operations are matched by
 * address across all files (an operation moved between files is not removed).
 */
export function diffContracts(base: readonly ContractDocument[], head: readonly ContractDocument[]): ContractChange[] {
  const index = (docs: readonly ContractDocument[]) => {
    const m = new Map<string, { file: string; op: ContractOperation }>();
    for (const d of docs) for (const op of d.operations) if (!m.has(op.address)) m.set(op.address, { file: d.file, op });
    return m;
  };
  const was = index(base);
  const now = index(head);
  const out: ContractChange[] = [];
  for (const [addr, b] of was) {
    const n = now.get(addr);
    if (!n) { out.push(change(b.file, b.op, 'operation-removed', `operation ${addr} removed`)); continue; }
    const { file, op } = n;
    if (op.deprecated && !b.op.deprecated) out.push(change(file, op, 'operation-deprecated', `operation ${addr} is now deprecated`));
    diffParams(file, b.op.params, op, out);
    // Request body.
    if (op.body && !b.op.body && op.body.required) out.push(change(file, op, 'body-added-required', 'a required request body was added'));
    else if (op.body && b.op.body) {
      if (op.body.required && !b.op.body.required) out.push(change(file, op, 'body-made-required', 'the request body is now required'));
      if (!op.body.assessed || !b.op.body.assessed) {
        if (JSON.stringify(op.body) !== JSON.stringify(b.op.body)) out.push(change(file, op, 'schema-unassessed', 'the request body schema changed and is outside the model (oneOf/anyOf or an external $ref)'));
      } else diffProps(file, op, b.op.body.properties, op.body.properties, 'body', out);
    }
    // Success response.
    if (b.op.response && op.response) {
      if (!op.response.assessed || !b.op.response.assessed) {
        if (JSON.stringify(op.response) !== JSON.stringify(b.op.response)) out.push(change(file, op, 'schema-unassessed', 'the response schema changed and is outside the model'));
      } else diffProps(file, op, b.op.response.properties, op.response.properties, 'response', out);
    } else if (b.op.response && !op.response && b.op.response.properties.length) {
      out.push(change(file, op, 'schema-unassessed', 'the success response schema was removed or is no longer readable'));
    }
  }
  for (const [addr, n] of now) if (!was.has(addr)) out.push(change(n.file, n.op, 'operation-added', `operation ${addr} added`));
  return out.sort((a, b) => (`${a.address}\0${a.rule}\0${a.element ?? ''}` < `${b.address}\0${b.rule}\0${b.element ?? ''}` ? -1 : 1));
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
