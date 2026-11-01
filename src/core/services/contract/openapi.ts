/**
 * OpenAPI / Swagger reader (change: add-service-contract-certification, OpenAPI phase).
 *
 * Reads an OpenAPI 3.0/3.1 or Swagger 2.0 document (YAML or JSON) into a normalized element model:
 * one entry per operation, with its parameters, request body properties, and success-response
 * properties. Only local `$ref`s (`#/...`) are followed, a bounded number of hops; anything the
 * model does not read (external refs, callbacks, webhooks) is listed as unassessed, never dropped
 * silently. Every schema the model reads also carries a hash of its full canonical form, so a change
 * the model cannot classify is still seen (and reported as unassessed), never read as "no change".
 * Deterministic and offline: plain YAML/JSON parsing, no grammar, no network.
 */

import { createHash } from 'node:crypto';
import { LineCounter, parseDocument } from 'yaml';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Bytes of a specification read at most. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const MAX_REF_HOPS = 16;
/** Nodes one canonical schema form visits at most (deterministic marker past it). */
const MAX_CANON_NODES = 5000;

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
  operations: ContractOperation[];
  /** Element classes present in the file but outside the model (`callbacks`, `webhooks`, external `$ref`). */
  unassessed: string[];
}

/**
 * Whether a file's text may be an OpenAPI or Swagger document: a top-level `openapi`/`swagger` key
 * in YAML (column 0), or that key anywhere in JSON. A pre-filter only; {@link readOpenApi} decides.
 */
export function looksLikeOpenApi(text: string): boolean {
  return /^\uFEFF?["']?(?:openapi|swagger)["']?[ \t]*:|"(?:openapi|swagger)"\s*:/m.test(text);
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** Keys that document a schema without changing what is on the wire. */
const DOC_ONLY = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs']);

/** The path part of a server URL (`https://{host}/v1/` → `/v1`; a relative `/v1` stays). */
function serverPath(servers: unknown): string | undefined {
  if (!Array.isArray(servers) || !isObj(servers[0]) || typeof servers[0].url !== 'string') return undefined;
  let base = servers[0].url.replace(/^(?:[^:/?#]+:)?\/\/[^/]*/, '');
  if (!base.startsWith('/')) base = '';
  return base.replace(/\/+$/, '');
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
    // uniqueKeys: the library's duplicate-key check is quadratic in a map's size; `paths` is checked below.
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

  const unassessed = new Set<string>();
  if (isObj(js.webhooks)) unassessed.add('webhooks');
  const root = js;

  // The line of each `paths` key and of each method key under it, indexed once.
  type YPair = { key?: { value?: unknown; range?: [number, number, number] }; value?: { items?: YPair[] } };
  const lineAt = (node: { range?: [number, number, number] } | undefined) => (node?.range ? lc.linePos(node.range[0]).line : 1);
  const pathLines = new Map<string, { line: number; methods: Map<string, number> }>();
  for (const pair of (doc.get('paths', true) as { items?: YPair[] } | undefined)?.items ?? []) {
    if (typeof pair.key?.value !== 'string') continue;
    if (pathLines.has(pair.key.value)) return { file, error: `duplicate path key: ${pair.key.value}` };
    const methods = new Map<string, number>();
    for (const m of pair.value?.items ?? []) if (typeof m.key?.value === 'string') methods.set(m.key.value, lineAt(m.key));
    pathLines.set(pair.key.value, { line: lineAt(pair.key), methods });
  }

  const resolveRef = (ref: string): unknown => ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);
  /** Follow local `$ref`s; an external one is unassessed. */
  const deref = (v: unknown): Json | undefined => {
    let cur = v;
    for (let hop = 0; hop < MAX_REF_HOPS && isObj(cur) && typeof cur.$ref === 'string'; hop++) {
      const ref = cur.$ref;
      if (!ref.startsWith('#/')) { unassessed.add('external $ref'); return undefined; }
      cur = resolveRef(ref);
    }
    return isObj(cur) && typeof cur.$ref !== 'string' ? cur : undefined;
  };

  /** The canonical form of a schema: local refs expanded (each once), keys sorted, documentation dropped. */
  const refCanon = new Map<string, unknown>();
  const canon = (v: unknown, seen: Set<string>, budget: { n: number }): unknown => {
    if (--budget.n < 0) return '…';
    if (Array.isArray(v)) return v.map(x => canon(x, seen, budget));
    if (!isObj(v)) return v;
    if (typeof v.$ref === 'string') {
      const ref = v.$ref;
      if (!ref.startsWith('#/') || seen.has(ref) || seen.size >= MAX_REF_HOPS) return { $ref: ref };
      if (!refCanon.has(ref)) refCanon.set(ref, canon(resolveRef(ref), new Set([...seen, ref]), budget));
      return refCanon.get(ref);
    }
    const out: Json = {};
    for (const k of Object.keys(v).sort()) if (!DOC_ONLY.has(k) && !k.startsWith('x-')) out[k] = canon(v[k], seen, budget);
    return out;
  };
  const hashOf = (v: unknown): string =>
    createHash('sha1').update(JSON.stringify(canon(v, new Set(), { n: MAX_CANON_NODES }) ?? null)).digest('hex').slice(0, 16);

  const typeOf = (schema: unknown): string | undefined => {
    const s = deref(schema);
    if (!s) return undefined;
    let t = Array.isArray(s.type) ? s.type.map(String).sort().join('|') : typeof s.type === 'string' ? s.type : undefined;
    if (t && s.nullable === true && !t.split('|').includes('null')) t = `${t}|null`;
    const fmt = typeof s.format === 'string' ? `:${s.format}` : '';
    const en = Array.isArray(s.enum) ? `{${JSON.stringify(s.enum.map(x => JSON.stringify(x)).sort())}}` : '';
    return t ? `${t}${fmt}${en}` : undefined;
  };
  /** Top-level properties of an object schema (its own and its `allOf` members'); `assessed: false` otherwise. */
  const propertiesOf = (schema: unknown): { properties: ContractProperty[]; assessed: boolean; hash: string } => {
    const hash = hashOf(schema);
    const s = deref(schema);
    if (!s) return { properties: [], assessed: false, hash };
    const parts = [s, ...(Array.isArray(s.allOf) ? s.allOf.map(deref) : [])];
    if (parts.some(p => !p) || s.oneOf || s.anyOf) return { properties: [], assessed: false, hash };
    const req = new Set((parts as Json[]).flatMap(p => (Array.isArray(p.required) ? p.required.filter((x): x is string => typeof x === 'string') : [])));
    const props = new Map<string, ContractProperty>();
    let assessed = false;
    for (const p of parts as Json[]) {
      if (!isObj(p.properties)) continue;
      assessed = true;
      for (const [name, ps] of Object.entries(p.properties)) props.set(name, { name, required: req.has(name), type: typeOf(ps), hash: hashOf(ps) });
    }
    return { properties: [...props.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), assessed, hash };
  };
  const jsonMedia = (content: unknown): Json | undefined => {
    const c = isObj(content) ? content : {};
    return (c['application/json'] ?? Object.entries(c).find(([k]) => /json/.test(k))?.[1]) as Json | undefined;
  };

  const docBase = (swagger ? (typeof js.basePath === 'string' ? js.basePath.replace(/\/+$/, '') : '') : serverPath(js.servers)) ?? '';
  const operations: ContractOperation[] = [];
  for (const [p, item] of Object.entries(js.paths)) {
    const pathItem = deref(item) ?? (isObj(item) ? item : undefined);
    if (!pathItem || !p.startsWith('/')) continue;
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
        const schema = prm.schema ?? jsonMedia(prm.content)?.schema ?? (swagger ? prm : undefined);
        params.set(`${prm.in}:${prm.name}`, { name: prm.name, in: prm.in, required: prm.required === true || prm.in === 'path', type: typeOf(schema), hash: hashOf({ ...prm, name: null }) });
      }
      let body: ContractOperation['body'];
      if (swagger) {
        // The operation's own body parameter wins over a path-level one.
        const bodyParam = [...own, ...shared].map(deref).find(x => x?.in === 'body');
        if (bodyParam) body = { required: bodyParam.required === true, ...propertiesOf(bodyParam.schema) };
      } else if (op.requestBody !== undefined) {
        const rb = deref(op.requestBody);
        const media = jsonMedia(rb?.content);
        body = media
          ? { required: rb?.required === true, ...propertiesOf(media.schema) }
          : { required: rb?.required === true, properties: [], assessed: false, hash: hashOf(op.requestBody) };
      }
      let response: ContractOperation['response'];
      const responses = isObj(op.responses) ? op.responses : {};
      const okKey = Object.keys(responses).filter(k => /^2\d\d$/.test(k)).sort()[0];
      if (okKey) {
        const r = deref(responses[okKey]);
        const schema = swagger ? r?.schema : jsonMedia(r?.content)?.schema;
        if (schema !== undefined) response = propertiesOf(schema);
        else if (!swagger && isObj(r?.content) && Object.keys(r.content).length) response = { properties: [], assessed: false, hash: hashOf(responses[okKey]) };
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
  return { file, format: swagger ? 'swagger-2' : 'openapi-3', basePath: docBase, operations, unassessed: [...unassessed].sort() };
}
