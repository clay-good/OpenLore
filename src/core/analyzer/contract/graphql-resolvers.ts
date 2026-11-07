/**
 * GraphQL resolver maps (change: add-contract-graph-projection, GraphQL phase).
 *
 * A schema-first GraphQL server names the function behind each root field in ONE literal place:
 *
 *   JS/TS    const resolvers = { Query: { order: getOrder, orders(parent, args) { … } } }
 *            const Query = { order: getOrder }                       (spread into `resolvers` later)
 *   Python   query = QueryType()            @query.field("order")\ndef resolve_order(…): …
 *            query.set_field("orders", resolve_orders)     (Ariadne; also ObjectType("Query"))
 *
 * That literal is the evidence an `implements_endpoint` edge rests on. No name similarity: a
 * function named `order` that no map names binds nothing. Scanning is a regex pass over source with
 * comments and strings blanked (`maskNonCode`), so a map written in a comment or a test fixture's
 * string is not read; the field names Python writes as strings are read back from the original
 * text at the same offsets, which masking preserves. Code-first servers (Strawberry, Graphene,
 * Nexus, gqlgen) have no such map and are a disclosed boundary.
 */

import { maskNonCode } from '../code-mask.js';
import { nodeImplMap, importedNames, lineAt } from './grpc-registration.js';

export type ResolverRuntime = 'node' | 'python';

export interface ResolverEntry {
  /** The root field the entry resolves. */
  field: string;
  /** The function it names; absent when written inline (an arrow function, a lambda). */
  fn?: string;
  /** Node: the function is imported into the map's file, so it may be looked for outside it. */
  imported?: true;
  line: number;
}

export interface ResolverMap {
  file: string;
  line: number;
  runtime: ResolverRuntime;
  /** The root type the map resolves (`Query`), as written. */
  root: string;
  entries: ResolverEntry[];
  /** Why the map is not literal (a spread, a computed key), when it is not. */
  notLiteral?: string;
}

/** Characters of one resolver object read at most. */
const MAX_MAP_CHARS = 65_536;
/** Resolver-shaped matches examined per file. */
const MAX_MATCHES_PER_FILE = 1_000;

const GENERATED = /(?:\.generated\.[cm]?[jt]sx?|__generated__\/)/i;

function runtimeOf(file: string): ResolverRuntime | undefined {
  if (/\.[cm]?[jt]sx?$/i.test(file)) return 'node';
  if (/\.pyw?$/i.test(file)) return 'python';
  return undefined;
}

/** The balanced `{…}` starting at `open`, or undefined when it does not close within the bound. */
function objectAt(text: string, open: number): string | undefined {
  let depth = 0;
  const end = Math.min(text.length, open + MAX_MAP_CHARS);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { if (--depth === 0) return text.slice(open, i + 1); }
  }
  return undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Masking blanks every string, so a quoted key (`"Query": {`, `'order': getOrder`) would be lost.
 * Put back a quoted identifier the masked text follows with a `:` — a key. In a comment the colon
 * is blanked too, so nothing there comes back.
 */
function restoreQuotedKeys(content: string, masked: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const m of content.matchAll(/(["'])([A-Za-z_$][\w$]*)\1/g)) {
    const i = m.index!;
    const end = i + m[0].length;
    if (i < at || masked.slice(i + 1, end - 1).trim() !== '' || !/^\s*:/.test(masked.slice(end, end + 64))) continue;
    parts.push(masked.slice(at, i), m[0]);
    at = end;
  }
  if (!parts.length) return masked;
  parts.push(masked.slice(at));
  return parts.join('');
}

/**
 * Every resolver map for the given root type names in one source file. `roots` comes from the
 * schema (its `schema { query: … }` block, or the default names), so a map is read only for a root
 * the schema actually has.
 */
export function scanResolverMaps(file: string, content: string, roots: readonly string[]): ResolverMap[] {
  const runtime = runtimeOf(file);
  if (!runtime || GENERATED.test(file) || !roots.length) return [];
  const rootSet = new Set(roots);
  // Cheap gate before masking: a root name must appear literally.
  if (!roots.some(r => content.includes(r)) && !(runtime === 'python' && /\b(?:QueryType|MutationType|SubscriptionType|ObjectType)\b/.test(content))) return [];
  const masked = maskNonCode(content, runtime === 'python' ? 'python' : 'js');
  const text = runtime === 'node' ? restoreQuotedKeys(content, masked) : masked;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out: ResolverMap[] = [];
  const alt = roots.map(escapeRe).join('|');

  if (runtime === 'node') {
    let imports: Map<string, string | null> | undefined;
    let seen = 0;
    // `Query: {` as an object key, or `const Query = {` as a variable.
    const pattern = new RegExp(`(?:[{,]\\s*["']?(${alt})["']?\\s*:|\\b(?:const|let|var)\\s+(${alt})\\s*(?::[^=]{0,200})?=)\\s*\\{`, 'g');
    for (const m of text.matchAll(pattern)) {
      if (++seen > MAX_MATCHES_PER_FILE) break;
      const root = m[1] ?? m[2];
      if (!rootSet.has(root)) continue;
      const open = m.index! + m[0].length - 1;
      const line = lineAt(starts, open);
      const obj = objectAt(text, open);
      const parsed = obj ? nodeImplMap(obj) : undefined;
      if (!parsed) { out.push({ file, line, runtime, root, entries: [], notLiteral: obj ? 'the resolver object has a spread or a computed key' : 'the resolver object could not be read' }); continue; }
      imports ??= importedNames(text);
      const entries: ResolverEntry[] = parsed.map(({ key, fn, base }) => {
        if (!fn) return { field: key, line };
        if (base && imports!.has(base)) {
          const exported = imports!.get(base);
          // Looked up by the name it was exported under, never by a local alias.
          if (base === fn) return exported ? { field: key, fn: exported, imported: true as const, line } : { field: key, fn, line };
          return { field: key, fn, imported: true as const, line };
        }
        return { field: key, fn, line };
      });
      out.push({ file, line, runtime, root, entries });
    }
    return out;
  }

  // Python (Ariadne): which variables hold which root type's bindable.
  const holders = new Map<string, { root: string; line: number }>();
  const ctor = /\b([A-Za-z_]\w*)\s*=\s*(?:ariadne\s*\.\s*)?(QueryType|MutationType|SubscriptionType|ObjectType)\s*\(/g;
  const defaultRoot: Record<string, string> = { QueryType: 'Query', MutationType: 'Mutation', SubscriptionType: 'Subscription' };
  for (const m of text.matchAll(ctor)) {
    let root = defaultRoot[m[2]];
    if (m[2] === 'ObjectType') {
      // `ObjectType("Query")`: the name is a string, blanked in the mask; read it from the source.
      const lit = /^\s*["']([A-Za-z_]\w*)["']/.exec(content.slice(m.index! + m[0].length, m.index! + m[0].length + 200));
      if (!lit) continue;
      root = lit[1];
    }
    if (rootSet.has(root)) holders.set(m[1], { root, line: lineAt(starts, m.index!) });
  }
  if (!holders.size) return out;
  // `from m import a, b as c` / `from m import (a, b)`: a resolver passed to `set_field` by a name
  // imported here may be looked for outside the file, under the name it was exported as.
  const pyImports = new Map<string, string>();
  for (const m of text.matchAll(/^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+(\([^)]{0,2000}\)|[^\n]{1,500})/gm)) {
    for (const part of m[1].replace(/[()]/g, '').split(',')) {
      const a = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
      if (a) pyImports.set(a[2] ?? a[1], a[1]);
    }
  }
  const maps = new Map<string, ResolverMap>();
  const mapFor = (v: string) => {
    let r = maps.get(v);
    if (!r) { const h = holders.get(v)!; r = { file, line: h.line, runtime, root: h.root, entries: [] }; maps.set(v, r); out.push(r); }
    return r;
  };
  const vars = [...holders.keys()].map(escapeRe).join('|');
  let seen = 0;
  // `@query.field("order")` followed by `def resolve_order(`.
  for (const m of text.matchAll(new RegExp(`@(${vars})\\s*\\.\\s*field\\s*\\(`, 'g'))) {
    if (++seen > MAX_MATCHES_PER_FILE) break;
    const after = m.index! + m[0].length;
    const field = /^\s*["']([A-Za-z_]\w*)["']\s*\)/.exec(content.slice(after, after + 300));
    const def = /^[^\n]*\n(?:\s*@[^\n]*\n){0,8}\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(text.slice(after, after + 2_000));
    if (!field) continue;
    mapFor(m[1]).entries.push({ field: field[1], ...(def ? { fn: def[1] } : {}), line: lineAt(starts, m.index!) });
  }
  // `query.set_field("orders", resolve_orders)`.
  for (const m of text.matchAll(new RegExp(`\\b(${vars})\\s*\\.\\s*set_field\\s*\\(`, 'g'))) {
    if (++seen > MAX_MATCHES_PER_FILE) break;
    const after = m.index! + m[0].length;
    const args = /^\s*["']([A-Za-z_]\w*)["']\s*,\s*([A-Za-z_]\w*)?/.exec(content.slice(after, after + 300));
    if (!args) continue;
    const fn = args[2] && args[2] !== 'lambda' ? args[2] : undefined;
    const exported = fn ? pyImports.get(fn) : undefined;
    mapFor(m[1]).entries.push({ field: args[1], ...(fn ? (exported ? { fn: exported, imported: true as const } : { fn }) : {}), line: lineAt(starts, m.index!) });
  }
  return out;
}
