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

export interface ContractBrief {
  /** `GET /v1/orders/{id}`. */
  operation: string;
  operationId?: string;
  /** `openapi.yaml:42`. */
  spec: string;
  /** The indexed route that serves it. */
  route: { file: string; method: string; path: string };
  deprecated?: true;
  requiredParams: string[];
  requiredBody: string[];
}

export interface ContractBriefing {
  contracts: ContractBrief[];
  /** Operations matched beyond the cap. */
  omitted?: number;
  note: string;
}

/**
 * The OpenAPI operations served by routes in `files` (root-relative), or undefined when no route
 * in those files is indexed or no specification declares one.
 */
export async function contractsForFiles(root: string, files: readonly string[]): Promise<ContractBriefing | undefined> {
  if (!files.length) return undefined;
  const { indexedRoutes } = await import('../mcp-handlers/service-contract.js');
  const routes = await indexedRoutes(root);
  const inScope = new Set(files);
  const local = (routes ?? []).filter(r => inScope.has(r.file));
  // No route in scope: no specification is read at all (the common case for a non-handler task).
  if (!local.length) return undefined;
  const { headSpecs } = await import('../mcp-handlers/service-contract.js');
  const docs = (await headSpecs(root)).docs;
  if (!docs.length) return undefined;
  const { routesServing } = await import('./contract-diff.js');
  const { emittedText } = await import('../generated-file-guard.js');
  const found: ContractBrief[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const op of doc.operations) {
      for (const r of routesServing(op, local)) {
        const key = `${doc.file}\0${op.address}\0${r.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Specification text is repository content: screened before it is served.
        const required = (names: string[]) => names.slice(0, MAX_REQUIRED).map(emittedText);
        found.push({
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
  if (!found.length) return undefined;
  found.sort((a, b) => (a.route.file < b.route.file ? -1 : a.route.file > b.route.file ? 1 : a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
  return {
    contracts: found.slice(0, MAX_CONTRACTS),
    ...(found.length > MAX_CONTRACTS ? { omitted: found.length - MAX_CONTRACTS } : {}),
    note: 'OpenAPI operations served by routes in these files (matched by method and path). A change to a handler, its parameters, or its body must keep this contract or change the specification; certify_service_contract with a base ref grades the change.',
  };
}
