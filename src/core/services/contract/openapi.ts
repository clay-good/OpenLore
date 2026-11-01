/**
 * OpenAPI / Swagger reader (change: add-service-contract-certification, OpenAPI phase).
 *
 * Reads an OpenAPI 3.0/3.1 or Swagger 2.0 document (YAML or JSON) into a normalized element model:
 * one entry per operation, with its parameters, request body properties, and success-response
 * properties. Only local `$ref`s (`#/...`) are followed, a bounded number of hops; anything the
 * model does not read (external refs, callbacks, webhooks) is listed as unassessed, never dropped
 * silently. Deterministic and offline: plain YAML/JSON parsing, no grammar, no network.
 */

import { LineCounter, parseDocument } from 'yaml';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Bytes of a specification read at most. */
export const MAX_SPEC_BYTES = 4 * 1024 * 1024;
const MAX_REF_HOPS = 16;

export interface ContractParam { name: string; in: string; required: boolean; type?: string }
export interface ContractProperty { name: string; required: boolean; type?: string }

export interface ContractOperation {
  /** `GET /v1/orders/{id}`: the method and the full path template, servers base path included. */
  address: string;
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
  body?: { required: boolean; properties: ContractProperty[]; assessed: boolean };
  /** Top-level properties of the 2xx JSON response, when it is an object schema. */
  response?: { properties: ContractProperty[]; assessed: boolean };
}

export interface ContractDocument {
  file: string;
  format: 'openapi-3' | 'swagger-2';
  basePath: string;
  operations: ContractOperation[];
  /** Element classes present in the file but outside the model (`callbacks`, `webhooks`, external `$ref`). */
  unassessed: string[];
}

/** Whether a file's text looks like an OpenAPI or Swagger document (cheap sniff of its head). */
export function looksLikeOpenApi(text: string): boolean {
  const head = text.slice(0, 4096);
  return /^[ \t]*["']?(?:openapi|swagger)["']?[ \t]*:/m.test(head) && /["']?paths["']?[ \t]*:/m.test(text.slice(0, 256 * 1024));
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** The base path a document's operations sit under: `servers[0].url`'s path (3.x) or `basePath` (2.0). */
function basePathOf(doc: Json, swagger: boolean): string {
  let base = '';
  if (swagger) base = typeof doc.basePath === 'string' ? doc.basePath : '';
  else if (Array.isArray(doc.servers) && isObj(doc.servers[0]) && typeof doc.servers[0].url === 'string') {
    const url = doc.servers[0].url;
    // A server URL with a variable host or none at all: keep only its path part.
    base = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^[^/].*$/, '');
  }
  base = base.replace(/\/+$/, '');
  return base === '/' ? '' : base;
}

/**
 * Parse one document. Returns `undefined` when the text is not an OpenAPI or Swagger document; an
 * `error` when it is one but cannot be read.
 */
export function readOpenApi(file: string, text: string): ContractDocument | { file: string; error: string } | undefined {
  if (text.length > MAX_SPEC_BYTES) return { file, error: `larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB` };
  const lc = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  let js: unknown;
  try {
    doc = parseDocument(text, { lineCounter: lc, merge: false });
    if (doc.errors.length) return looksLikeOpenApi(text) ? { file, error: doc.errors[0].message.split('\n')[0] } : undefined;
    js = doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    return looksLikeOpenApi(text) ? { file, error: e instanceof Error ? e.message.split('\n')[0] : String(e) } : undefined;
  }
  if (!isObj(js)) return undefined;
  const swagger = typeof js.swagger === 'string' && js.swagger.startsWith('2');
  const openapi = typeof js.openapi === 'string' && /^3\./.test(js.openapi);
  if ((!swagger && !openapi) || !isObj(js.paths)) return undefined;

  const unassessed = new Set<string>();
  if (isObj(js.webhooks)) unassessed.add('webhooks');
  const root = js;
  /** The line of the key `key` in the mapping at `parent` (the line a reader looks for). */
  const lineOf = (parent: string[], key: string): number => {
    const map = doc.getIn(parent, true) as { items?: Array<{ key?: { value?: unknown; range?: [number, number, number] } }> } | undefined;
    const pair = map?.items?.find(i => i.key?.value === key);
    return pair?.key?.range ? lc.linePos(pair.key.range[0]).line : 1;
  };

  /** Follow local `$ref`s; an external one is unassessed. */
  const deref = (v: unknown): Json | undefined => {
    let cur = v;
    for (let hop = 0; hop < MAX_REF_HOPS && isObj(cur) && typeof cur.$ref === 'string'; hop++) {
      const ref = cur.$ref;
      if (!ref.startsWith('#/')) { unassessed.add('external $ref'); return undefined; }
      cur = ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);
    }
    return isObj(cur) && typeof cur.$ref !== 'string' ? cur : undefined;
  };
  const typeOf = (schema: unknown): string | undefined => {
    const s = deref(schema);
    if (!s) return undefined;
    const t = Array.isArray(s.type) ? s.type.filter(x => x !== 'null').join('|') : typeof s.type === 'string' ? s.type : undefined;
    const fmt = typeof s.format === 'string' ? `:${s.format}` : '';
    const en = Array.isArray(s.enum) ? `{${s.enum.map(String).sort().join(',')}}` : '';
    return t ? `${t}${fmt}${en}` : undefined;
  };
  /** Top-level properties of an object schema (`allOf` members merged); `assessed: false` otherwise. */
  const propertiesOf = (schema: unknown): { properties: ContractProperty[]; assessed: boolean } => {
    const s = deref(schema);
    if (!s) return { properties: [], assessed: false };
    const parts = Array.isArray(s.allOf) ? s.allOf.map(deref) : [s];
    if (parts.some(p => !p) || s.oneOf || s.anyOf) return { properties: [], assessed: false };
    const props = new Map<string, ContractProperty>();
    let assessed = false;
    for (const p of parts as Json[]) {
      if (!isObj(p.properties)) continue;
      assessed = true;
      const req = new Set(Array.isArray(p.required) ? p.required.filter((x): x is string => typeof x === 'string') : []);
      for (const [name, ps] of Object.entries(p.properties)) {
        props.set(name, { name, required: req.has(name) || !!props.get(name)?.required, type: typeOf(ps) });
      }
    }
    return { properties: [...props.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), assessed };
  };

  const basePath = basePathOf(js, swagger);
  const operations: ContractOperation[] = [];
  for (const [p, item] of Object.entries(js.paths)) {
    const pathItem = deref(item) ?? (isObj(item) ? item : undefined);
    if (!pathItem || !p.startsWith('/')) continue;
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const m of HTTP_METHODS) {
      const op = pathItem[m];
      if (!isObj(op)) continue;
      if (isObj(op.callbacks)) unassessed.add('callbacks');
      // Parameters: path-level ones, overridden by operation-level ones with the same (name, in).
      const params = new Map<string, ContractParam>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const prm = deref(raw);
        if (!prm || typeof prm.name !== 'string' || typeof prm.in !== 'string') continue;
        if (swagger && prm.in === 'body') continue; // Swagger 2 body: handled below
        params.set(`${prm.in}:${prm.name}`, { name: prm.name, in: prm.in, required: prm.required === true || prm.in === 'path', type: typeOf(prm.schema ?? prm) });
      }
      let body: ContractOperation['body'];
      if (swagger) {
        const bodyParam = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(deref).find(x => x?.in === 'body');
        if (bodyParam) body = { required: bodyParam.required === true, ...propertiesOf(bodyParam.schema) };
      } else if (op.requestBody !== undefined) {
        const rb = deref(op.requestBody);
        const content = isObj(rb?.content) ? rb.content : {};
        const media = (content['application/json'] ?? Object.entries(content).find(([k]) => /json/.test(k))?.[1]) as Json | undefined;
        body = { required: rb?.required === true, ...(media ? propertiesOf(media.schema) : { properties: [], assessed: false }) };
      }
      let response: ContractOperation['response'];
      const responses = isObj(op.responses) ? op.responses : {};
      const okKey = Object.keys(responses).filter(k => /^2\d\d$/.test(k)).sort()[0];
      if (okKey) {
        const r = deref(responses[okKey]);
        const schema = swagger ? r?.schema : (() => {
          const c = isObj(r?.content) ? r.content : {};
          const media = (c['application/json'] ?? Object.entries(c).find(([k]) => /json/.test(k))?.[1]) as Json | undefined;
          return media?.schema;
        })();
        if (schema !== undefined) response = propertiesOf(schema);
      }
      const full = `${basePath}${p}`;
      operations.push({
        address: `${m.toUpperCase()} ${full}`,
        method: m.toUpperCase(),
        path: full,
        declaredPath: p,
        ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
        line: lineOf(['paths', p], m),
        deprecated: op.deprecated === true,
        params: [...params.values()].sort((a, b) => (`${a.in}:${a.name}` < `${b.in}:${b.name}` ? -1 : 1)),
        ...(body ? { body } : {}),
        ...(response ? { response } : {}),
      });
    }
  }
  operations.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return { file, format: swagger ? 'swagger-2' : 'openapi-3', basePath, operations, unassessed: [...unassessed].sort() };
}
