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
  /** The function is imported into the map's file: it is looked for only in the module named. */
  imported?: true;
  /** JS/TS: the import's module specifier (`./orders`). */
  from?: string;
  /** Python: the imported module (`.resolvers`, `app.resolvers`). */
  module?: string;
  /** Why a named function is not followed (a default import names no exported function). */
  notFollowed?: string;
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
/** Stories and mocks hold fake resolvers for a fake server. */
const NOT_A_SERVER = /(?:\.stories\.[cm]?[jt]sx?$|(?:^|\/)(?:__mocks__|mocks?)\/|(?:^|\/)mocks?\.[cm]?[jt]sx?$)/i;
/** Mocking libraries: a resolver object in a file that imports one resolves a fake schema. */
const MOCK_PACKAGES = /^(?:msw|@graphql-tools\/mock|graphql-tools\/mock|@mswjs\/)/;
/**
 * A file that writes its OWN schema inline (`typeDefs: \`type Query {…}\``, `buildSchema(…)`)
 * serves that schema, not one read from a `.graphql` file: its resolver maps belong to it, and
 * binding them to the repository's SDL by field name would link one app's code to another's API.
 */
const INLINE_SDL = /(?:\btypeDefs\b|\btype_defs\b|\bgql\s*`|\bgql\s*\(\s*(?:"""|'''|")|\bgraphql\s*`|\bbuildSchema\s*\(|\bcreateSchema\s*\(|\bmakeExecutableSchema\s*\(|\bmake_executable_schema\s*\()[\s\S]{0,4000}?\btype\s+(?:Query|Mutation|Subscription)\b/;

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

/** GraphQL client libraries: their `Query: {…}` objects are cache policies and local resolvers. */
const CLIENT_PACKAGES = /^(?:@apollo\/client|apollo-client|apollo-boost|apollo-cache-inmemory|apollo-link-state|urql|@urql\/|relay-runtime|react-relay)/;
/** GraphQL server libraries. */
const SERVER_PACKAGES = /^(?:@apollo\/server|apollo-server|@apollo\/subgraph|graphql-yoga|@graphql-yoga\/|@graphql-tools\/|graphql-tools|mercurius|express-graphql|graphql-http|@envelop\/|graphql-helix|@nestjs\/graphql)/;
/** Calls and keys whose `Query: {…}` is client configuration, not a server resolver map. */
const CLIENT_CALLS = new Set(['cacheExchange', 'offlineExchange', 'ApolloClient', 'InMemoryCache', 'withClientState', 'createClient', 'makeVar']);
const CLIENT_KEYS = new Set(['typePolicies', 'updates', 'optimistic', 'keys', 'fields', 'mocks', 'cacheConfig']);
/** How far back the enclosing context of a match is read. */
const CONTEXT_CHARS = 4_000;

/**
 * Whether the object a match sits in is client configuration or a type declaration: an enclosing
 * call to a client constructor, an enclosing key like `typePolicies`, or a TypeScript
 * `interface` / `type … =` (a resolver TYPE, not a resolver). Read backward over a bounded window,
 * stepping over balanced groups, so it stays linear per match.
 */
function clientContext(text: string, at: number): boolean {
  let depth = 0;
  const stop = Math.max(0, at - CONTEXT_CHARS);
  for (let i = at; i >= stop; i--) {
    const c = text[i];
    if (c === '}' || c === ')' || c === ']') { depth++; continue; }
    if (c !== '{' && c !== '(' && c !== '[') continue;
    if (depth > 0) { depth--; continue; }
    // An unmatched opener: what precedes it names the enclosing construct.
    const before = text.slice(Math.max(stop, i - 200), i);
    if (c === '(') {
      const call = /([A-Za-z_$][\w$]*)\s*(?:<[^<>]{0,100}>)?\s*$/.exec(before)?.[1];
      if (call && CLIENT_CALLS.has(call)) return true;
    } else if (c === '{') {
      const key = /([A-Za-z_$][\w$]*)\s*["']?\s*:\s*$/.exec(before)?.[1];
      if (key && CLIENT_KEYS.has(key)) return true;
      if (/\b(?:interface\s+[A-Za-z_$][\w$]*(?:\s*<[^{]{0,200}>)?(?:\s+extends\s+[^{]{1,200})?|type\s+[A-Za-z_$][\w$]*(?:\s*<[^=]{0,200}>)?\s*=)\s*$/.test(before)) return true;
    }
  }
  return false;
}

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
  if (!runtime || GENERATED.test(file) || NOT_A_SERVER.test(file) || !roots.length) return [];
  const rootSet = new Set(roots);
  // Cheap gate before masking: a root name must appear literally.
  if (!roots.some(r => content.includes(r)) && !(runtime === 'python' && /\b(?:QueryType|MutationType|SubscriptionType|ObjectType)\b/.test(content))) return [];
  if (INLINE_SDL.test(content) && /["'`]\s*(?:extend\s+)?type\s+(?:Query|Mutation|Subscription)\b|`[^`]{0,4000}?\btype\s+(?:Query|Mutation|Subscription)\b/.test(content)) return [];
  const masked = maskNonCode(content, runtime === 'python' ? 'python' : 'js');
  const text = runtime === 'node' ? restoreQuotedKeys(content, masked) : masked;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out: ResolverMap[] = [];
  const alt = roots.map(escapeRe).join('|');

  if (runtime === 'node') {
    const imports = importedNames(text);
    const specifiers = [...new Set([...imports.values()].map(i => i.from))];
    // A file that imports a GraphQL CLIENT and no server is client code: its `Query: {…}` objects
    // are cache policies and local resolvers (urql, Apollo Client), never the server's. A type-only
    // import is no client at run time, and a request library (`graphql-request`) a server uses to
    // call another service is not a client cache.
    const valueSpecifiers = [...text.matchAll(/\bimport\s+(?!type\b)[^;'"`]{0,500}?\bfrom\s*['"]([^'"\n]{1,500})['"]|\bimport\s*['"]([^'"\n]{1,500})['"]|\brequire\s*\(\s*['"]([^'"\n]{1,500})['"]/g)].map(m => m[1] ?? m[2] ?? m[3]);
    if (valueSpecifiers.some(f => CLIENT_PACKAGES.test(f)) && !specifiers.some(f => SERVER_PACKAGES.test(f))) return out;
    if (valueSpecifiers.some(f => MOCK_PACKAGES.test(f))) return out;
    // `const Query = {…}` is a resolver object only in a file that is about resolvers — by its text,
    // its imports, or its path (`resolvers/Query.ts`, `graphql/mutation.ts`): a SQL statement map
    // named `Query` is not one.
    const resolverFile = /\bresolvers\b/i.test(text) || specifiers.some(f => SERVER_PACKAGES.test(f)) || /resolver|graphql|schema/i.test(file);
    const entryOf = (key: string, fn: string | undefined, base: string | undefined, line: number): ResolverEntry => {
      if (!fn) return { field: key, line };
      const imp = base ? imports.get(base) : undefined;
      if (!imp) return { field: key, fn, line };
      if (base === fn) {
        // Looked up by the name it was exported under, in the module it was imported from.
        return imp.exported
          ? { field: key, fn: imp.exported, imported: true as const, from: imp.from, line }
          : { field: key, fn, notFollowed: `\`${fn}\` is a default or namespace import of '${imp.from}', which is not followed`, line };
      }
      return { field: key, fn, imported: true as const, from: imp.from, line };
    };
    let seen = 0;
    // `Query: {` as an object key, `const Query = {` as a variable, or `Query: someIdentifier`.
    const pattern = new RegExp(`(?:[{,]\\s*["']?(${alt})["']?\\s*:\\s*(\\{|[A-Za-z_$][\\w$.]*\\s*\\(?)|\\b(?:const|let|var)\\s+(${alt})\\s*(?::[^=;{}\\n]{0,200})?=\\s*\\{)`, 'g');
    for (const m of text.matchAll(pattern)) {
      if (++seen > MAX_MATCHES_PER_FILE) {
        out.push({ file, line: lineAt(starts, m.index!), runtime, root: m[1] ?? m[3], entries: [], notLiteral: `more than ${MAX_MATCHES_PER_FILE} resolver-shaped objects in one file; the rest were not read` });
        break;
      }
      const root = m[1] ?? m[3];
      if (!rootSet.has(root)) continue;
      if (m[3] && !resolverFile) continue;
      if (clientContext(text, m.index!)) continue;
      // The root key's own line: the `{` or `,` the match starts at may sit on the line before.
      const line = lineAt(starts, m.index! + m[0].indexOf(root, 1));
      // `Query: OperationTypeNode.QUERY`, `Query: true`: a value, not resolvers. A resolver map
      // built elsewhere is a lower-case variable or a call (`queryResolvers`, `mergeResolvers(…)`).
      if (m[2] && m[2] !== '{' && !/^[a-z_$][\w$]*\s*\(?$/.test(m[2]) ) continue;
      if (m[2] && /^(?:true|false|null|undefined)\b/.test(m[2])) continue;
      if (m[2] && m[2] !== '{') {
        // `Query: queryResolvers`, `Query: mergeResolvers(…)`: the map is built elsewhere.
        out.push({ file, line, runtime, root, entries: [], notLiteral: `the ${root} resolvers are \`${m[2].replace(/\s*\($/, '(…)').slice(0, 60)}\`, not an object written here` });
        continue;
      }
      const open = m.index! + m[0].length - 1;
      const obj = objectAt(text, open);
      const parsed = obj ? nodeImplMap(obj) : undefined;
      if (!parsed) { out.push({ file, line, runtime, root, entries: [], notLiteral: obj ? 'the resolver object has a spread or a computed key' : 'the resolver object could not be read' }); continue; }
      // Apollo subscriptions: `orderCreated: { subscribe: subscribeOrders }`.
      const subscribe = new Map<string, string>();
      for (const sm of (obj ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{[^{}]{0,500}?\bsubscribe\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*[,}]/g)) subscribe.set(sm[1], sm[2]);
      const entries: ResolverEntry[] = parsed.map(({ key, fn, base }) => {
        const sub = !fn ? subscribe.get(key) : undefined;
        if (sub) return entryOf(key, sub.slice(sub.lastIndexOf('.') + 1), sub.split('.')[0], line);
        return entryOf(key, fn, base, line);
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
  const pyImports = new Map<string, { exported: string; module: string }>();
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]{0,2000}\)|[^\n]{1,500})/gm)) {
    for (const part of m[2].replace(/[()]/g, '').split(',')) {
      const a = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
      if (a) pyImports.set(a[2] ?? a[1], { exported: a[1], module: m[1] });
    }
  }
  // `import app.resolvers as r` / `import resolvers`: a module bound to a name.
  const pyModules = new Map<string, string>();
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*$/gm)) pyModules.set(m[2] ?? m[1].split('.')[0], m[2] ? m[1] : m[1].split('.')[0]);
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
    const args = /^\s*["']([A-Za-z_]\w*)["']\s*,\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?/.exec(content.slice(after, after + 300));
    if (!args) continue;
    const value = args[2] && args[2] !== 'lambda' ? args[2] : undefined;
    const line = lineAt(starts, m.index!);
    if (!value) { mapFor(m[1]).entries.push({ field: args[1], line }); continue; }
    const parts = value.split('.');
    const fn = parts[parts.length - 1];
    let entry: ResolverEntry;
    if (parts.length === 1) {
      const imp = pyImports.get(fn);
      entry = imp ? { field: args[1], fn: imp.exported, imported: true, module: imp.module, line } : { field: args[1], fn, line };
    } else {
      // `orders_mod.resolve_search`: the function `resolve_search` of the module the name holds.
      const head = parts[0];
      const viaFrom = pyImports.get(head);
      const module = viaFrom ? `${viaFrom.module}${viaFrom.module.endsWith('.') ? '' : '.'}${viaFrom.exported}` : pyModules.get(head);
      const qualified = parts.slice(1, -1).join('.');
      entry = module
        ? { field: args[1], fn, imported: true, module: qualified ? `${module}.${qualified}` : module, line }
        : { field: args[1], fn, notFollowed: `\`${value}\` names an attribute of \`${head}\`, which is not an import this file states`, line };
    }
    mapFor(m[1]).entries.push(entry);
  }
  return out;
}
