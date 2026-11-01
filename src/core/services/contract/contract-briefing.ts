/**
 * Contract elements in the briefings (change: add-contract-graph-projection).
 *
 * `certify_service_contract` answers when asked; an agent editing a route handler should see,
 * unasked, that the handler is declared in an OpenAPI specification and what that declaration
 * requires. This reads the indexed route inventory and the working tree's specifications (the
 * same readers the certification uses) and names, for files in scope, the operations their routes
 * serve: method + path, the specification file and line, `operationId`, required parameters and
 * required body properties, and deprecation. Matching is by method and normalized path, as in the
 * certification's parity; a route's handler name is often generic (an inline function), so a file
 * is the unit, never a guessed function. Read-only; bounded; fail-quiet.
 */

/** Operations named per briefing. */
const MAX_CONTRACTS = 5;
/** Required parameters or body properties listed per operation. */
const MAX_REQUIRED = 8;
/** Function names in scope looked for in route files, and route files read. */
const MAX_NAMES = 40;
const MAX_ROUTE_FILES_READ = 50;
const MAX_ROUTE_FILE_BYTES = 512 * 1024;

export interface ContractBrief {
  /** `GET /v1/orders/{id}`. */
  operation: string;
  operationId?: string;
  /** `openapi.yaml:42`. */
  spec: string;
  /** The indexed route that serves it. */
  route: { file: string; method: string; path: string };
  deprecated?: true;
  /** Matched on the path without the servers base path (the router may mount under it). */
  matchedWithoutBasePath?: true;
  /** The route file is outside the scope; it names this function in scope. */
  routeFileNames?: string;
  requiredParams: string[];
  requiredBody: string[];
}

export interface ContractBriefing {
  contracts: ContractBrief[];
  /** Operations matched beyond the cap. */
  omitted?: number;
  note: string;
}

/** A route path with no literal segment (`/`, `/:id`): too generic to match a specification without its base path. */
const onlyParams = (normalized: string) => normalized.split('/').filter(Boolean).every(seg => seg.startsWith(':'));

/**
 * The OpenAPI operations served by routes in `files` (root-relative), and the indexed route files
 * whose handler is named in `handlers`, or undefined when no such route is indexed or no
 * specification declares one. A route matches an operation by method and its full path (servers
 * base included); without the base only when the route path has a literal segment and exactly one
 * operation in all specifications has that method and path. Wildcard-method routes are left out.
 */
export async function contractsForFiles(root: string, files: readonly string[], functions: readonly string[] = []): Promise<ContractBriefing | undefined> {
  if (!files.length && !functions.length) return undefined;
  const { indexedRoutes, headSpecsCached } = await import('../mcp-handlers/service-contract.js');
  const routes = await indexedRoutes(root);
  if (!routes?.length) return undefined;
  const inScope = new Set(files);
  const { normalizeUrl } = await import('../../analyzer/http-route-parser.js');
  const { HTTP_METHODS } = await import('../../analyzer/contract/openapi.js');
  const concrete = new Set<string>(HTTP_METHODS.map(m => m.toUpperCase()));
  // A route file outside the scope joins it when it names a function in scope: inline handlers
  // (`router.post('/', (req, res) => svc.createTask(…))`) are not call-graph nodes, so the call
  // graph cannot link them. A bare name, so short names are not matched.
  const via = new Map<string, string>();
  const names = [...new Set(functions)].filter(n => /^[A-Za-z_$][\w$]{3,}$/.test(n)).slice(0, MAX_NAMES);
  if (names.length) {
    const pattern = new RegExp(`(?<![\\w$])(${names.map(n => n.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|')})(?![\\w$])`);
    const { readFileConfined } = await import('../../../utils/path-confinement.js');
    for (const f of [...new Set(routes.map(r => r.file))].filter(f => !inScope.has(f)).slice(0, MAX_ROUTE_FILES_READ)) {
      const text = await readFileConfined(root, f, MAX_ROUTE_FILE_BYTES).catch(() => null);
      const m = text ? pattern.exec(text) : null;
      if (m) via.set(f, m[1]);
    }
  }
  const local = routes.filter(r => (inScope.has(r.file) || via.has(r.file)) && concrete.has(r.method.toUpperCase()));
  // No route in scope: no specification is read at all (the common case for a non-handler task).
  if (!local.length) return undefined;
  const side = await headSpecsCached(root);
  if (!side.docs.length) {
    return side.capped || side.unread.length
      ? { contracts: [], note: 'Not assessed: the specification scan reached its file cap or could not read some candidates; certify_service_contract lists them.' }
      : undefined;
  }
  const { emittedText } = await import('../generated-file-guard.js');
  // Bare (base-less) paths across every specification: a match without the base must be unique.
  const bareCount = new Map<string, number>();
  for (const doc of side.docs) for (const op of doc.operations) {
    const k = `${op.method.toUpperCase()} ${normalizeUrl(op.declaredPath)}`;
    bareCount.set(k, (bareCount.get(k) ?? 0) + 1);
  }
  const byOp = new Map<string, ContractBrief & { exact: boolean }>();
  for (const doc of side.docs) {
    for (const op of doc.operations) {
      const full = normalizeUrl(op.path);
      const bare = normalizeUrl(op.declaredPath);
      for (const r of local) {
        if (r.method.toUpperCase() !== op.method.toUpperCase()) continue;
        const n = normalizeUrl(r.path);
        const exact = n === full;
        if (!exact && !(n === bare && !onlyParams(n) && bareCount.get(`${op.method.toUpperCase()} ${bare}`) === 1)) continue;
        const key = `${op.address}\0${r.file}`;
        const prior = byOp.get(key);
        // The same operation in several specifications (a bundle beside its source): one entry.
        if (prior) { if (exact && !prior.exact) prior.exact = true; continue; }
        // Specification text is repository content: screened before it is served.
        const required = (names: string[]) => names.slice(0, MAX_REQUIRED).map(emittedText);
        byOp.set(key, {
          exact,
          ...(via.has(r.file) ? { routeFileNames: emittedText(via.get(r.file)!) } : {}),
          operation: emittedText(op.address),
          ...(op.operationId ? { operationId: emittedText(op.operationId) } : {}),
          spec: emittedText(`${doc.file}:${op.line}`),
          route: { file: emittedText(r.file), method: emittedText(r.method), path: emittedText(r.path) },
          ...(op.deprecated ? { deprecated: true as const } : {}),
          requiredParams: required(op.params.filter(p => p.required).map(p => `${p.name} (${p.in}${p.type ? `, ${p.type}` : ''})`)),
          requiredBody: required((op.body?.properties ?? []).filter(p => p.required).map(p => `${p.name}${p.type ? ` (${p.type})` : ''}`)),
        });
      }
    }
  }
  const found = [...byOp.values()];
  if (!found.length) return undefined;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Full-path matches first; then by route file and operation.
  found.sort((a, b) => Number(b.exact) - Number(a.exact) || cmp(a.route.file, b.route.file) || cmp(a.operation, b.operation));
  return {
    contracts: found.slice(0, MAX_CONTRACTS).map(({ exact, ...c }) => (exact ? c : { ...c, matchedWithoutBasePath: true as const })),
    ...(found.length > MAX_CONTRACTS ? { omitted: found.length - MAX_CONTRACTS } : {}),
    note: 'OpenAPI operations served by routes in scope, matched by method and path (with the servers base path, or without it only when unique and not all-parameter). A change to a handler, its parameters, or its body must keep this contract or change the specification; certify_service_contract with a base ref grades the change.',
  };
}
