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
 * Whether a call's literal URL targets a host the specification declares.
 *
 * A host-less (relative) URL targets this service, so it counts. A URL whose host is not among
 * the declared `servers` hosts is another vendor on the same path shape and must not be read as
 * a consumer. With no declared host there is nothing to compare, so the caller discloses that
 * rather than excluding.
 *
 * Exported because the FEDERATED census needs exactly this rule: across repositories a host
 * mismatch is the normal case, not the edge case (change: add-contract-graph-projection).
 */
export function sameDeclaredHost(url: string, hosts: readonly string[]): boolean {
  if (!hosts.length) return true;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return true; // relative or non-absolute: this service
  }
  return hosts.some(h => h.toLowerCase() === host);
}

/** A path template made only of parameters (`/{a}/{b}`): too generic to attribute a call site. */
export function allParameterPath(normalized: string): boolean {
  return onlyParams(normalized);
}

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

// ════════════════════════════════════════════════════════════════════════════
// The inverse question: the diff changed a SPECIFICATION, so what does it bind to?
// ════════════════════════════════════════════════════════════════════════════

/** Elements named per briefing. */
const MAX_CHANGED_ELEMENTS = 10;
/** Consumer call sites listed per element. */
const MAX_CONSUMERS = 5;

export interface ChangedContractElement {
  /** `GET /v1/orders/{id}`. */
  operation: string;
  operationId?: string;
  /** `openapi.yaml:42`. */
  spec: string;
  deprecated?: true;
  /** The indexed route that serves it, when one does. */
  servedBy?: { file: string; method: string; path: string };
  /** Matched on the path without the servers base path (the router may mount under it). */
  matchedWithoutBasePath?: true;
  /** In-repo call sites that consume it. */
  consumedBy?: Array<{ file: string; line: number }>;
  /** Consumers beyond the cap. */
  consumersOmitted?: number;
  /** Nothing indexed in this repository serves or consumes it. */
  unbound?: true;
}

export interface ChangedContractBriefing {
  /** The changed specification files this briefing read. */
  specs: string[];
  elements: ChangedContractElement[];
  /** Elements beyond the cap. */
  omitted?: number;
  /** What could not be assessed, named rather than implied absent. */
  notAssessed?: string[];
  note: string;
}

/**
 * The contract elements a diff's SPECIFICATION files declare, and the code bound to each.
 *
 * The sibling briefing (`contractsForFiles`) answers "my diff touched a handler — what contract
 * does it owe?". This answers the inverse: "my diff touched a specification — who is affected?".
 * An agent editing `openapi.yaml` otherwise sees nothing at all, because a specification is not
 * a call-graph node and no handler of its own appears in the diff.
 *
 * Deliberately NOT a verdict: it does not grade the change or compare against a base revision.
 * `certify_service_contract` with a base ref owns that conclusion, and the note says so — two
 * tools must not return the same answer in different words.
 *
 * Read-only, bounded, fail-quiet. Returns undefined when the diff touches no specification.
 */
export async function changedContractsForSpecFiles(
  root: string,
  changedFiles: readonly string[],
): Promise<ChangedContractBriefing | undefined> {
  if (!changedFiles.length) return undefined;
  const changed = new Set(changedFiles);
  const { indexedRoutes, headSpecsCached, callSitesFor } = await import('../mcp-handlers/service-contract.js');
  const side = await headSpecsCached(root);

  // Only the specifications the diff actually touched.
  const docs = side.docs.filter(d => changed.has(d.file));
  const unreadableChanged = side.unreadable.filter(u => changed.has(u.file));
  // A changed candidate that could not be READ at all (over the size cap, a link out of the
  // repository, an I/O error) lands in `unread`, not `unreadable`. Consulting only the latter
  // returned no briefing for it — the silent omission the spec forbids.
  const unreadChanged = side.unread.filter(u => changed.has(u.file));
  // Past the scan cap a changed specification may never have been examined, so the cap is a
  // reason to brief, not a footnote on a briefing that does not happen.
  const cappedMayHide = side.capped && changedFiles.some(f => side.candidates.has(f) && !side.examined.has(f));
  // A changed `.proto` file is a specification change too. Its RPCs are not briefed here — the
  // served-by and consumer joins below are HTTP — so it is named, never silently passed over
  // (change: add-contract-graph-projection).
  const protoChanged = changedFiles.filter(f => side.proto.candidates.has(f)).sort();
  const protoNote = protoChanged.length
    ? `${protoChanged.length} changed .proto file(s) (${protoChanged.slice(0, 3).join(', ')}${protoChanged.length > 3 ? ', …' : ''}): their RPCs are not briefed here; the graph binds each RPC to the method its server registration names, and certify_service_contract with a base ref grades the change.`
    : undefined;
  if (!docs.length && !unreadableChanged.length && !unreadChanged.length && !cappedMayHide) {
    if (!protoNote) return undefined;
    const { emittedText } = await import('../generated-file-guard.js');
    return {
      specs: protoChanged.map(emittedText), elements: [], notAssessed: [emittedText(protoNote)],
      note: 'Contract elements declared by the specification files this diff changed. This is a blast radius, NOT a verdict. Run certify_service_contract with a base ref for the breaking/dangerous verdict per changed element.',
    };
  }

  const notAssessed: string[] = [];
  if (protoNote) notAssessed.push(protoNote); // screened with the rest at emission
  for (const u of unreadableChanged) {
    notAssessed.push(`${u.file} could not be parsed (${u.reason}), so its operations were not assessed.`);
  }
  for (const u of unreadChanged) {
    notAssessed.push(`${u.file} could not be read (${u.reason}), so its operations were not assessed.`);
  }
  if (side.capped) {
    notAssessed.push('The specification scan reached its cap, so a changed specification may not have been examined here; certify_service_contract lists the candidates.');
  }

  const { emittedText } = await import('../generated-file-guard.js');
  const { normalizeUrl } = await import('../../analyzer/http-route-parser.js');
  const { HTTP_METHODS } = await import('../../analyzer/contract/openapi.js');
  const concrete = new Set<string>(HTTP_METHODS.map(m => m.toUpperCase()));

  const routes = (await indexedRoutes(root)) ?? [];
  // Only a CONCRETE-method route can be matched to an operation. Django and friends are
  // extracted with `method: 'UNKNOWN'`, so a repository whose routes are all wildcard-method
  // has nothing to match — and gating the honesty notes on `routes` rather than on these left
  // every operation in such a repository reported `unbound` with no disclosure at all.
  const local = routes.filter(r => concrete.has(r.method.toUpperCase()));
  if (!local.length) {
    notAssessed.push(routes.length === 0
      ? 'No route handler is indexed, so "served by" is not assessed — it is not a claim that nothing serves these operations.'
      : `Every one of the ${routes.length} indexed route(s) carries a wildcard method, which cannot be matched to an operation, so "served by" is not assessed.`);
  } else if (routes.length > local.length) {
    notAssessed.push(`${routes.length - local.length} indexed route(s) carry a wildcard method and were not matched, so one of them may serve an operation reported here as unserved.`);
  }
  // `servedBy` is read from the route inventory as of the last `analyze`; consumers are read
  // from the working tree. A handler added before this diff and not yet re-analyzed is
  // therefore invisible, which is a reason to hedge, not to claim absence.
  if (local.length) {
    notAssessed.push('"served by" is read from the route inventory as of the last analyze, so a handler added since then is not reflected.');
  }

  // A base-less match must be unique across every specification, as in the sibling briefing.
  const bareCount = new Map<string, number>();
  for (const doc of side.docs) for (const op of doc.operations) {
    const k = `${op.method.toUpperCase()} ${normalizeUrl(op.declaredPath)}`;
    bareCount.set(k, (bareCount.get(k) ?? 0) + 1);
  }

  // A specification that parsed but yielded nothing is NOT the same as one with no elements to
  // report: the reader skips a path item it does not recognize (a malformed operation, a `$ref`
  // it does not follow). Saying so beats an empty list that reads as "this change affects
  // nothing".
  for (const doc of docs) {
    if (!doc.operations.length) {
      notAssessed.push(`${doc.file} parsed but declares no operation this reader recognizes, so its elements are not assessed.`);
    }
  }

  const ops = docs.flatMap(doc => doc.operations.map(op => ({ file: doc.file, op })));
  // The declared hosts of the specification each operation belongs to, for the host filter below.
  const hostsByAddress = new Map<string, string[]>();
  for (const doc of docs) for (const op of doc.operations) hostsByAddress.set(op.address, doc.serverHosts);
  const consumerBoundaries: string[] = [];
  const stats = { capped: false, totals: new Map<string, number>() };
  // Consumers are read from the whole repository, not the diff: a specification change affects
  // callers the diff never touched, which is the point of asking. `withCall` carries each
  // call's literal URL so the host can be checked.
  let consumerScanFailed = false;
  const consumers = ops.length
    ? await callSitesFor(root, ops, consumerBoundaries, stats, true).catch(() => { consumerScanFailed = true; return new Map(); })
    : new Map();
  notAssessed.push(...consumerBoundaries);
  if (consumerScanFailed) {
    notAssessed.push('The consumer scan failed, so no call site was assessed — this is not a claim that nothing consumes these operations.');
  }
  // `callSitesFor` matches on the normalized PATH only, so a call to another vendor on the same
  // path shape was attributed to this specification's operation. The document's own `servers`
  // hosts are the filter; a host-less (relative) URL stays, since it targets this service.
  const sameHost = sameDeclaredHost;
  const anyHostless = docs.some(d => !d.serverHosts.length);
  if (anyHostless && ops.length) {
    notAssessed.push('A changed specification declares no `servers` host, so a call site matched only by path may belong to another service.');
  }
  // The client scan reads a fixed set of extensions. A consumer written in any other language is
  // never seen, which must not read as "nothing consumes this".
  notAssessed.push('Consumers are read from TypeScript, JavaScript, Python and Go sources only; a client in another language is not assessed (see get_language_support).');

  const elements: ChangedContractElement[] = [];
  for (const { file, op } of ops) {
    const full = normalizeUrl(op.path);
    const bare = normalizeUrl(op.declaredPath);
    // EVERY matching route, not the last one to win the loop. Overwriting `served` on each
    // match named one handler of several and discarded the rest silently — and the one it
    // named was simply the last in inventory order.
    const matches: Array<{ file: string; method: string; path: string; exact: boolean }> = [];
    for (const r of local) {
      if (r.method.toUpperCase() !== op.method.toUpperCase()) continue;
      const n = normalizeUrl(r.path);
      const exact = n === full;
      if (!exact && !(n === bare && !onlyParams(n) && bareCount.get(`${op.method.toUpperCase()} ${bare}`) === 1)) continue;
      matches.push({ file: r.file, method: r.method, path: r.path, exact });
    }
    // A full-path match beats a base-less one; among equals there is no winner to pick.
    const exactMatches = matches.filter(m => m.exact);
    const best = exactMatches.length ? exactMatches : matches;
    const ambiguous = best.length > 1;
    const served = best.length === 1
      ? { file: emittedText(best[0].file), method: emittedText(best[0].method), path: emittedText(best[0].path) }
      : undefined;
    const withoutBase = best.length === 1 && !best[0].exact;
    if (ambiguous) {
      notAssessed.push(`${op.address} is matched by ${best.length} indexed routes (${best.slice(0, 4).map(m => m.file).join(', ')}${best.length > 4 ? ', …' : ''}), so no single handler is named.`);
    }

    const hosts = hostsByAddress.get(op.address) ?? [];
    const allSites = (consumers.get(op.address) ?? []) as Array<{ file: string; line: number; url?: string }>;
    // Host filter, plus the same all-parameter guard the handler side already has: an operation
    // path made only of parameters matches almost any URL of that segment count.
    const pathTooGeneric = onlyParams(full) || onlyParams(bare);
    const sites = pathTooGeneric
      ? []
      : allSites.filter(site => sameHost(site.url ?? '', hosts));
    if (pathTooGeneric && allSites.length) {
      notAssessed.push(`${op.address} is an all-parameter path, which matches too broadly to attribute a call site, so its consumers are not assessed.`);
    }
    const dropped = allSites.length - sites.length;
    if (!pathTooGeneric && dropped > 0) {
      notAssessed.push(`${dropped} call site(s) matching ${op.address} by path target another host and were not counted as consumers.`);
    }
    const total = (stats.totals.get(op.address) ?? allSites.length) - (allSites.length - sites.length);
    const shown = sites.slice(0, MAX_CONSUMERS).map(s => ({ file: emittedText(s.file), line: s.line }));
    elements.push({
      operation: emittedText(op.address),
      ...(op.operationId ? { operationId: emittedText(op.operationId) } : {}),
      spec: emittedText(`${file}:${op.line}`),
      ...(op.deprecated ? { deprecated: true as const } : {}),
      ...(served ? { servedBy: served } : {}),
      ...(served && withoutBase ? { matchedWithoutBasePath: true as const } : {}),
      ...(shown.length ? { consumedBy: shown } : {}),
      ...(total > shown.length ? { consumersOmitted: total - shown.length } : {}),
      // Claimable only when nothing stood in the way of seeing a binding: a concrete-method
      // route index exists, no route matched ambiguously, the consumer scan ran, was not
      // capped, and the path is specific enough to attribute. Every one of those was a false
      // `unbound` before.
      ...(!served && !matches.length && !sites.length && local.length > 0 && !stats.capped
        && !consumerScanFailed && !pathTooGeneric
        ? { unbound: true as const }
        : {}),
    });
  }

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  // Bound elements first (they have affected code), then by operation address.
  elements.sort((a, b) =>
    Number(!!b.servedBy || !!b.consumedBy) - Number(!!a.servedBy || !!a.consumedBy)
    || cmp(a.operation, b.operation));

  return {
    specs: [...new Set([...docs.map(d => d.file), ...unreadableChanged.map(u => u.file)])].sort(cmp).map(emittedText),
    elements: elements.slice(0, MAX_CHANGED_ELEMENTS),
    ...(elements.length > MAX_CHANGED_ELEMENTS ? { omitted: elements.length - MAX_CHANGED_ELEMENTS } : {}),
    ...(notAssessed.length ? { notAssessed: [...new Set(notAssessed)].map(emittedText) } : {}),
    note: 'Contract elements declared by the specification files this diff changed, with the indexed handler that serves each and the in-repo call sites that consume it — who a specification change affects. This is a blast radius, NOT a verdict: it does not compare against a base revision or grade the change. Run certify_service_contract with a base ref for the breaking/dangerous verdict per changed element.',
  };
}
