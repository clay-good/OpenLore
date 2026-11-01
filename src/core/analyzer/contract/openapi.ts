/**
 * OpenAPI / Swagger reader (change: add-service-contract-certification, OpenAPI phase).
 *
 * Reads an OpenAPI 3.0/3.1 or Swagger 2.0 document (YAML or JSON) into a normalized element model:
 * one entry per operation, with its parameters, request body properties, and success-response
 * properties. Only local `$ref`s (`#/...`) are followed; anything the model does not read (external
 * or unresolved refs, callbacks, webhooks) is listed as unassessed, never dropped silently.
 *
 * Each element also carries a `hash` of everything about it the rule table does NOT compare
 * (constraints, nested schemas, composition, media types), so a difference there is seen and
 * reported as unassessed, never read as "no change". Hashes are Merkle hashes over the canonical
 * schema (keys sorted, documentation dropped, `required`/`enum`/`type` lists as sets): a reference to
 * an acyclic schema hashes the same as the schema written inline, and a schema in a reference cycle
 * hashes as the set of everything it reaches. No hash depends on the order operations are read.
 * Deterministic and offline: plain YAML/JSON parsing, no grammar, no network.
 */

import { createHash } from 'node:crypto';
import { LineCounter, parseDocument, isMap, isScalar, isSeq, isPair } from 'yaml';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Bytes of a specification read at most. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const MAX_REF_HOPS = 16;

export interface ContractParam { name: string; in: string; required: boolean; type?: string; hash: string }
export interface ContractProperty { name: string; required: boolean; type?: string; hash: string }

export interface ContractOperation {
  /** `GET /v1/orders/{id}`: the method and the full path template, servers base path included. */
  address: string;
  /** The address with path-parameter names erased (`GET /v1/orders/{}`): the matching key. */
  key: string;
  method: string;
  /** The path template with the base path, as written (`/v1/orders/{id}`). */
  path: string;
  /** The path as declared under `paths` (without the base path). */
  declaredPath: string;
  operationId?: string;
  line: number;
  deprecated: boolean;
  params: ContractParam[];
  /** `undefined` when the operation takes no body. */
  body?: { required: boolean; properties: ContractProperty[]; assessed: boolean; hash: string };
  /** Top-level properties of the 2xx JSON response, when it is an object schema. */
  response?: { properties: ContractProperty[]; assessed: boolean; hash: string };
}

export interface ContractDocument {
  file: string;
  format: 'openapi-3' | 'swagger-2';
  basePath: string;
  /**
   * Lower-cased hosts the document's `servers` (or Swagger `host`) name, without port or scheme.
   * Empty when the document declares none — then a host cannot be checked, and a consumer must
   * say so rather than assume a call to any host is a call to this service.
   */
  serverHosts: string[];
  operations: ContractOperation[];
  /** Element classes present in the file but outside the model (`callbacks`, `webhooks`, external `$ref`). */
  unassessed: string[];
  /** Path keys (method-agnostic, parameter names erased) whose operations are behind a ref the model does not read. */
  opaquePaths: string[];
}

/**
 * Whether a file's text may be an OpenAPI or Swagger document: an `openapi` or `swagger` key
 * anywhere (block, flow, or JSON style). A cheap pre-filter only; {@link readOpenApi} decides.
 */
export function looksLikeOpenApi(text: string): boolean {
  return /(?:^|[\s{,])["']?(?:openapi|swagger)["']?[ \t]*:/m.test(text);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** Keys that document a schema without changing what is on the wire. */
const DOC_ONLY = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs']);
/** Schema keys the rule table compares itself (through the type string). */
const TYPE_KEYS = ['type', 'format', 'enum', 'nullable'];
/** Keys whose array value is a set: order and duplicates do not matter. */
const SET_KEYS = new Set(['required', 'enum', 'type']);
const omit = (o: Json, keys: readonly string[]): Json => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * The hosts a server list names (`https://api.example.com/v1` → `api.example.com`), lower-cased
 * and without the port. A templated host (`https://{region}.example.com`) is left out: it matches
 * no literal host, and guessing one is the error this list exists to prevent.
 */
function serverHosts(servers: unknown, swaggerHost: unknown): string[] {
  const hosts = new Set<string>();
  if (typeof swaggerHost === 'string' && swaggerHost && !swaggerHost.includes('{')) {
    hosts.add(swaggerHost.split('/')[0].split(':')[0].toLowerCase());
  }
  if (Array.isArray(servers)) {
    for (const s of servers.filter(isObj)) {
      if (typeof s.url !== 'string') continue;
      const m = /^(?:[^:/?#]+:)?\/\/([^/?#]+)/.exec(s.url);
      if (!m || m[1].includes('{')) continue;
      hosts.add(m[1].split('@').pop()!.split(':')[0].toLowerCase());
    }
  }
  return [...hosts].sort();
}

/** The base path of a server list, independent of the servers' order (`https://{host}/v1/` → `/v1`). */
function serverPath(servers: unknown): string | undefined {
  if (!Array.isArray(servers) || !servers.length) return undefined;
  const paths = servers.filter(isObj).map(s => (typeof s.url === 'string' ? s.url : ''))
    .map(u => u.replace(/^(?:[^:/?#]+:)?\/\/[^/]*/, '')).map(u => (u.startsWith('/') ? u.replace(/\/+$/, '') : ''));
  return [...new Set(paths.filter(Boolean))].sort()[0] ?? '';
}

/** The first duplicated key of any YAML mapping in the document (checked once, linearly). */
function duplicateKey(root: unknown): string | undefined {
  const stack: unknown[] = [root];
  while (stack.length) {
    const n = stack.pop();
    if (isMap(n)) {
      const keys = new Set<unknown>();
      for (const pair of n.items) {
        const k = isScalar(pair.key) ? pair.key.value : pair.key;
        if (keys.has(k) && k !== '<<') return String(k);
        keys.add(k);
        stack.push(pair.value);
      }
    } else if (isSeq(n)) for (const i of n.items) stack.push(i);
    else if (isPair(n)) stack.push(n.value);
  }
  return undefined;
}

/**
 * Parse one document. Returns `undefined` when the text is not an OpenAPI or Swagger document; an
 * `error` when it declares itself one (a top-level `openapi`/`swagger` key) but cannot be read.
 */
export function readOpenApi(file: string, text: string): ContractDocument | { file: string; error: string } | undefined {
  if (text.length > MAX_SPEC_BYTES) return { file, error: `larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB` };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lc = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  let js: unknown;
  try {
    // uniqueKeys: the library's duplicate-key check is quadratic in a map's size; `duplicateKey` is linear.
    doc = parseDocument(text, { lineCounter: lc, merge: true, uniqueKeys: false });
    if (doc.errors.length) return looksLikeOpenApi(text) ? { file, error: doc.errors[0].message.split('\n')[0] } : undefined;
    js = doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    return looksLikeOpenApi(text) ? { file, error: e instanceof Error ? e.message.split('\n')[0] : String(e) } : undefined;
  }
  if (!isObj(js) || (js.swagger === undefined && js.openapi === undefined)) return undefined;
  // An unquoted `swagger: 2.0` / `openapi: 3.0` is a YAML number.
  const swagger = String(js.swagger ?? '').startsWith('2');
  const openapi = /^3(?:\.|$)/.test(String(js.openapi ?? ''));
  if (!swagger && !openapi) return { file, error: `unsupported version: ${String(js.openapi ?? js.swagger)}` };
  if (!isObj(js.paths)) return { file, error: 'no `paths` object' };
  const dup = duplicateKey(doc.contents);
  if (dup !== undefined) return { file, error: `duplicate key: ${dup}` };

  const unassessed = new Set<string>();
  if (isObj(js.webhooks)) unassessed.add('webhooks');
  const root = js;

  // The line of each `paths` key and of each method key under it, indexed once.
  type YPair = { key?: { value?: unknown; range?: [number, number, number] }; value?: { items?: YPair[] } };
  const lineAt = (node: { range?: [number, number, number] } | undefined) => (node?.range ? lc.linePos(node.range[0]).line : 1);
  const pathLines = new Map<string, { line: number; methods: Map<string, number> }>();
  for (const pair of (doc.get('paths', true) as { items?: YPair[] } | undefined)?.items ?? []) {
    if (typeof pair.key?.value !== 'string') continue;
    const methods = new Map<string, number>();
    for (const m of pair.value?.items ?? []) if (typeof m.key?.value === 'string') methods.set(m.key.value, lineAt(m.key));
    pathLines.set(pair.key.value, { line: lineAt(pair.key), methods });
  }

  const resolveRef = (ref: string): unknown => ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);
  const isLocal = (ref: string) => ref.startsWith('#/');

  /** Keyword siblings of a `$ref` merged over its target (OpenAPI 3.1; documentation-only in 3.0). */
  const mergeSiblings = (target: Json, sib: Json): Json => {
    const out: Json = { ...target };
    for (const [k, v] of Object.entries(sib)) {
      if (k === 'required' && Array.isArray(v)) out.required = [...new Set([...(Array.isArray(target.required) ? target.required : []), ...v])];
      else if (k === 'properties' && isObj(v)) out.properties = { ...(isObj(target.properties) ? target.properties : {}), ...v };
      else out[k] = v;
    }
    return out;
  };
  /** Follow local `$ref`s (siblings merged); an external or unresolved one is unassessed. */
  const deref = (v: unknown): Json | undefined => {
    let cur = v;
    let sib: Json = {};
    for (let hop = 0; hop < MAX_REF_HOPS && isObj(cur) && typeof cur.$ref === 'string'; hop++) {
      const ref = cur.$ref;
      sib = { ...omit(cur, ['$ref', ...DOC_ONLY]), ...sib };
      if (!isLocal(ref)) { unassessed.add('external $ref'); return undefined; }
      cur = resolveRef(ref);
      if (cur === undefined) { unassessed.add('unresolved $ref'); return undefined; }
    }
    // A ref chain longer than the hop bound (a cycle of refs to refs) is unresolved.
    if (isObj(cur) && typeof cur.$ref === 'string') unassessed.add('unresolved $ref');
    if (!isObj(cur) || typeof cur.$ref === 'string') return undefined;
    return Object.keys(sib).length ? mergeSiblings(cur, sib) : cur;
  };

  // ── Merkle hashing ──
  const refsIn = (v: unknown): string[] => {
    const out: string[] = [];
    const stack = [v];
    while (stack.length) {
      const n = stack.pop();
      if (Array.isArray(n)) for (const x of n) stack.push(x);
      else if (isObj(n)) {
        if (typeof n.$ref === 'string' && isLocal(n.$ref)) out.push(n.$ref);
        for (const x of Object.values(n)) stack.push(x);
      }
    }
    return out;
  };
  const reachMemo = new Map<string, Set<string>>();
  /** The local refs reachable from `ref`'s target (not `ref` itself unless it is in a cycle). */
  const reach = (ref: string): Set<string> => {
    const memo = reachMemo.get(ref);
    if (memo) return memo;
    const seen = new Set<string>();
    const queue = refsIn(resolveRef(ref));
    while (queue.length) {
      const r = queue.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      for (const x of refsIn(resolveRef(r))) queue.push(x);
    }
    reachMemo.set(ref, seen);
    return seen;
  };
  /** Canonical JSON of a ref's target with nested refs kept as names (for cycles). */
  const shallow = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(shallow);
    if (!isObj(v)) return v ?? null;
    const out: Json = {};
    for (const k of Object.keys(v).sort()) {
      if (DOC_ONLY.has(k) || k.startsWith('x-')) continue;
      const c = v[k];
      out[k] = SET_KEYS.has(k) && Array.isArray(c) ? [...new Set(c.map(x => JSON.stringify(x)))].sort() : shallow(c);
    }
    return out;
  };
  const refHashMemo = new Map<string, string>();
  const nodeMemo = new WeakMap<object, string>();
  const refHash = (ref: string): string => {
    if (!isLocal(ref)) { unassessed.add('external $ref'); return `ext:${ref}`; }
    const memo = refHashMemo.get(ref);
    if (memo) return memo;
    const target = resolveRef(ref);
    let h: string;
    if (target === undefined) { unassessed.add('unresolved $ref'); h = `unresolved:${ref}`; }
    else if (reach(ref).has(ref)) {
      // In a cycle: the set of every schema it reaches, each with nested refs as names.
      const all = [...new Set([ref, ...reach(ref)])].sort();
      h = sha(`cycle:${JSON.stringify(all.map(r => [r, shallow(resolveRef(r))]))}`);
    } else h = node(target);
    refHashMemo.set(ref, h);
    return h;
  };
  /** The Merkle hash of a schema node. */
  const node = (v: unknown): string => {
    if (Array.isArray(v)) return sha(`[${v.map(node).join(',')}]`);
    if (!isObj(v)) return `p:${JSON.stringify(v ?? null)}`;
    const memo = nodeMemo.get(v);
    if (memo) return memo;
    let h: string;
    if (typeof v.$ref === 'string') {
      const sib = omit(v, ['$ref', ...DOC_ONLY]);
      const r = refHash(v.$ref);
      h = Object.keys(sib).some(k => !k.startsWith('x-')) ? sha(`sib:${r}:${node(sib)}`) : r;
    } else {
      const parts: string[] = [];
      for (const k of Object.keys(v).sort()) {
        if (DOC_ONLY.has(k) || k.startsWith('x-')) continue;
        const c = v[k];
        parts.push(`${JSON.stringify(k)}:${SET_KEYS.has(k) && Array.isArray(c) ? [...new Set(c.map(node))].sort().join('|') : node(c)}`);
      }
      h = sha(`{${parts.join(',')}}`);
    }
    nodeMemo.set(v, h);
    return h;
  };
  /** What the rule table does not compare about a leaf schema: everything but its type string. */
  const leafHash = (schema: unknown): string => {
    const s = deref(schema);
    return s ? node(omit(s, TYPE_KEYS)) : node(schema);
  };

  const typeOf = (schema: unknown): string | undefined => {
    const s = deref(schema);
    if (!s) return undefined;
    let t = Array.isArray(s.type) ? [...new Set(s.type.map(String))].sort().join('|') : typeof s.type === 'string' ? s.type : undefined;
    if (t && s.nullable === true && !t.split('|').includes('null')) t = `${t}|null`;
    const fmt = typeof s.format === 'string' ? `:${s.format}` : '';
    const en = Array.isArray(s.enum) ? `{${JSON.stringify([...new Set(s.enum.map(x => JSON.stringify(x)))].sort())}}` : '';
    return t ? `${t}${fmt}${en}` : undefined;
  };
  /** Top-level properties of an object schema (its own and its `allOf` members'); `assessed: false` otherwise. */
  const propertiesOf = (schema: unknown): { properties: ContractProperty[]; assessed: boolean; hash: string } => {
    const s = deref(schema);
    if (!s) return { properties: [], assessed: false, hash: node(schema) };
    const parts = [s, ...(Array.isArray(s.allOf) ? s.allOf.map(deref) : [])];
    if (parts.some(p => !p) || s.oneOf || s.anyOf || !(parts as Json[]).some(p => isObj(p.properties))) {
      return { properties: [], assessed: false, hash: node(schema) };
    }
    const req = new Set((parts as Json[]).flatMap(p => (Array.isArray(p.required) ? p.required.filter((x): x is string => typeof x === 'string') : [])));
    const props = new Map<string, ContractProperty>();
    for (const p of parts as Json[]) {
      if (!isObj(p.properties)) continue;
      for (const [name, ps] of Object.entries(p.properties)) props.set(name, { name, required: req.has(name), type: typeOf(ps), hash: leafHash(ps) });
    }
    // The object's shape apart from its properties and required list, which the rules compare.
    // A member with nothing else (only properties or a required list) adds nothing to the shape.
    const hash = sha((parts as Json[]).map(p => omit(p, [...TYPE_KEYS, 'properties', 'required', 'allOf']))
      .filter(p => Object.keys(p).some(k => !DOC_ONLY.has(k) && !k.startsWith('x-'))).map(node).join('+'));
    return { properties: [...props.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), assessed: true, hash };
  };
  const jsonMediaEntry = (content: unknown): [string, Json] | undefined => {
    const c = isObj(content) ? content : {};
    const e = Object.entries(c).find(([k]) => k === 'application/json') ?? Object.entries(c).find(([k]) => /json/.test(k));
    return e && isObj(e[1]) ? [e[0], e[1]] : undefined;
  };
  const otherMedia = (content: unknown, chosen?: string) => (isObj(content) ? node(omit(content, chosen ? [chosen] : [])) : '');

  try {
    return readOperations();
  } catch (e) {
    // A schema nested deeper than the stack allows: unreadable, never empty.
    return { file, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }

  function readOperations(): ContractDocument {
  const docBase = (swagger ? (typeof root.basePath === 'string' ? root.basePath.replace(/\/+$/, '') : '') : serverPath(root.servers)) ?? '';
  const operations: ContractOperation[] = [];
  const opaquePaths = new Set<string>();
  for (const [p, item] of Object.entries(root.paths as Json)) {
    if (!p.startsWith('/')) continue;
    const pathItem = deref(item);
    if (!pathItem) {
      if (isObj(item) && typeof item.$ref === 'string') opaquePaths.add(`${docBase}${p}`.replace(/\{[^}]*\}/g, '{}'));
      continue;
    }
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const m of HTTP_METHODS) {
      const op = pathItem[m];
      if (!isObj(op)) continue;
      if (isObj(op.callbacks)) unassessed.add('callbacks');
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      // Parameters: path-level ones, overridden by operation-level ones with the same (name, in).
      const params = new Map<string, ContractParam>();
      for (const raw of [...shared, ...own]) {
        const prm = deref(raw);
        if (!prm || typeof prm.name !== 'string' || typeof prm.in !== 'string') continue;
        if (swagger && prm.in === 'body') continue; // Swagger 2 body: handled below
        const media = jsonMediaEntry(prm.content);
        const schema = prm.schema ?? media?.[1].schema;
        const inline = schema === undefined && swagger; // Swagger 2: the type sits on the parameter itself
        const rest = omit(prm, ['name', 'required', 'schema', 'content', ...(inline ? TYPE_KEYS : [])]);
        const hash = sha(`${node(rest)}|${schema !== undefined ? leafHash(schema) : ''}|${otherMedia(prm.content, media?.[0])}`);
        params.set(`${prm.in}:${prm.name}`, { name: prm.name, in: prm.in, required: prm.required === true || prm.in === 'path', type: typeOf(inline ? prm : schema), hash });
      }
      let body: ContractOperation['body'];
      if (swagger) {
        // The operation's own body parameter wins over a path-level one.
        const bodyParam = [...own, ...shared].map(deref).find(x => x?.in === 'body');
        if (bodyParam) body = { required: bodyParam.required === true, ...propertiesOf(bodyParam.schema) };
      } else if (op.requestBody !== undefined) {
        const rb = deref(op.requestBody);
        const media = jsonMediaEntry(rb?.content);
        const shape = media ? propertiesOf(media[1].schema) : { properties: [], assessed: false, hash: node(op.requestBody) };
        body = { required: rb?.required === true, ...shape, hash: sha(`${shape.hash}|${media?.[0] ?? ''}|${otherMedia(rb?.content, media?.[0])}`) };
      }
      let response: ContractOperation['response'];
      const responses = isObj(op.responses) ? op.responses : {};
      const okKeys = Object.keys(responses).filter(k => /^2(?:\d\d|XX)$/i.test(k)).sort();
      if (okKeys.length) {
        // The first 2xx response with a JSON schema is modeled; every 2xx response is in the hash.
        const pick = okKeys.map(k => ({ k, r: deref(responses[k]) })).map(x => ({ ...x, entry: swagger ? undefined : jsonMediaEntry(x.r?.content) }))
          .find(x => (swagger ? x.r?.schema !== undefined : x.entry?.[1].schema !== undefined));
        const schema = pick ? (swagger ? pick.r?.schema : pick.entry?.[1].schema) : undefined;
        // A 2xx response that does not resolve: its shape is unknown, never "no body".
        const unresolved = okKeys.some(k => deref(responses[k]) === undefined);
        const shape = schema !== undefined ? propertiesOf(schema)
          : { properties: [], assessed: !unresolved, hash: unresolved ? node(okKeys.map(k => responses[k])) : '' };
        const rest = okKeys.filter(k => k !== pick?.k).map(k => `${k}:${node(responses[k])}`).join(',');
        response = { ...shape, hash: sha(`${okKeys.join(',')}|${pick?.k ?? ''}|${shape.hash}|${otherMedia(pick?.r?.content, pick?.entry?.[0])}|${rest}`) };
      }
      const base = serverPath(op.servers) ?? serverPath(pathItem.servers) ?? docBase;
      const full = `${base}${p}`;
      operations.push({
        address: `${m.toUpperCase()} ${full}`,
        key: `${m.toUpperCase()} ${full.replace(/\{[^}]*\}/g, '{}')}`,
        method: m.toUpperCase(),
        path: full,
        declaredPath: p,
        ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
        line: pathLines.get(p)?.methods.get(m) ?? pathLines.get(p)?.line ?? 1,
        deprecated: op.deprecated === true,
        params: [...params.values()].sort((a, b) => (`${a.in}:${a.name}` < `${b.in}:${b.name}` ? -1 : 1)),
        ...(body ? { body } : {}),
        ...(response ? { response } : {}),
      });
    }
  }
  operations.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return {
    file, format: swagger ? 'swagger-2' : 'openapi-3', basePath: docBase,
    serverHosts: serverHosts(root.servers, root.host), operations,
    unassessed: [...unassessed].sort(), opaquePaths: [...opaquePaths].sort(),
  };
  }
}
