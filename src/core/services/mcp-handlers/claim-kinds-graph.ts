/**
 * `verify_claim` kinds over contracts and governance (change: add-graph-claim-kinds).
 *
 *  - `endpoint-implemented` (subject: `METHOD /path`) — is the operation an OpenAPI/Swagger
 *    specification declares served by an indexed route handler?
 *  - `endpoint-consumed` (subject: `METHOD /path`) — does a client call site in this repository call
 *    it? Refuted is scoped to this repository; other callers are a named boundary.
 *  - `decision-governed` (subject: a symbol) — is an authoritative decision or memory anchored to it?
 *    Recall's freshness rules apply: an orphaned memory is listed, never counted as governing.
 *
 * Same verdicts and receipt discipline as the structural kinds: a receipt only for a decided verdict,
 * `unverifiable` with the reason whenever the subject cannot be assessed. Deterministic and offline.
 */

import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import { readCachedContext, diagnoseIndexUnservable } from './utils.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import type { PendingDecision, StructuralAnchor } from '../../../types/index.js';
import type { ContractDocument, ContractOperation } from '../contract/openapi.js';

export type GraphClaimKind = 'endpoint-implemented' | 'endpoint-consumed' | 'decision-governed';
type Verdict = 'confirmed' | 'refuted' | 'unverifiable';

const EXTERNAL_CALLERS = 'Callers in other repositories, through generated clients, or with dynamic URLs are not visible here.';

/** `GET /v1/orders/:id` or `get /v1/orders/{orderId}` → `GET /v1/orders/{}` (parameter names erased). */
function addressKey(subject: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(subject);
  if (!m) return null;
  const path = m[2].replace(/\{[^}]*\}/g, '{}').replace(/:[A-Za-z_]\w*/g, '{}').replace(/(.)\/+$/, '$1');
  return `${m[1].toUpperCase()} ${path}`;
}
const keyOf = (method: string, path: string) => `${method} ${path.replace(/\{[^}]*\}/g, '{}')}`;

/** The operation a subject names, matched with or without the specification's base path. */
async function findOperation(root: string, subject: string): Promise<
  | { status: 'error'; error: string }
  | { status: 'missing'; reason: string }
  | { status: 'found'; op: ContractOperation; doc: ContractDocument }
> {
  const key = addressKey(subject);
  if (!key) return { status: 'error', error: `"${subject}" is not an operation address — expected "METHOD /path", e.g. "POST /v1/checkout".` };
  const { headSpecs } = await import('./service-contract.js');
  const side = await headSpecs(root);
  const notAssessed = side.unreadable.map(u => u.file);
  for (const doc of side.docs) {
    const op = doc.operations.find(o => o.key === key || keyOf(o.method, o.declaredPath) === key);
    if (op) return { status: 'found', op, doc };
  }
  return {
    status: 'missing',
    reason: side.docs.length || notAssessed.length
      ? `"${subject}" is not declared in any readable OpenAPI or Swagger specification in this repository${notAssessed.length ? ` (${notAssessed.length} specification(s) could not be read: ${notAssessed.slice(0, 3).join(', ')})` : ''}.`
      : 'No OpenAPI or Swagger specification was found in this repository, so the operation cannot be assessed.',
  };
}

async function endpointClaim(root: string, kind: 'endpoint-implemented' | 'endpoint-consumed', subject: string): Promise<unknown> {
  const claim = { kind, subject };
  const staleness = await computeStaleness(root);
  const found = await findOperation(root, subject);
  if (found.status === 'error') return { error: found.error };
  if (found.status === 'missing') {
    return { claim, verdict: 'unverifiable' as Verdict, reason: found.reason, confidenceBoundary: assembleBoundary({ staleness }) };
  }
  const { op, doc } = found;
  const { readIndexCommit } = await import('./claim-verification.js');
  const { emittedText } = await import('../generated-file-guard.js');
  const operation = { address: emittedText(op.address), file: emittedText(doc.file), line: op.line };
  const indexCommit = await readIndexCommit(root);

  if (kind === 'endpoint-implemented') {
    const { indexedRoutes } = await import('./service-contract.js');
    const { routesServing } = await import('../contract/contract-diff.js');
    const routes = await indexedRoutes(root);
    if (!routes) {
      return { claim, verdict: 'unverifiable' as Verdict, reason: 'No route inventory: run `openlore analyze` first.', confidenceBoundary: assembleBoundary({ staleness }) };
    }
    if (!routes.length) {
      return { claim, verdict: 'unverifiable' as Verdict, reason: 'No server route handler is indexed in this repository; the specification may describe another service.', confidenceBoundary: assembleBoundary({ staleness }) };
    }
    const serving = routesServing(op, routes);
    if (serving.length) {
      const handlers = serving.slice(0, 10).map(r => ({ method: r.method, path: emittedText(r.path), file: emittedText(r.file) }));
      const evidence = `${operation.address} (declared at ${operation.file}:${op.line}) is served by ${handlers.map(h => `${h.method} ${h.path} in ${h.file}`).join(', ')}`;
      return { claim, verdict: 'confirmed' as Verdict, reason: `${evidence}.`, receipt: { indexCommit, operation, handlers, evidence }, confidenceBoundary: assembleBoundary({ staleness }) };
    }
    const evidence = `${operation.address} is declared at ${operation.file}:${op.line}, and no indexed route handler has its method and path`;
    return {
      claim, verdict: 'refuted' as Verdict, reason: `${evidence}. A handler whose path is built dynamically is not visible to the route index.`,
      receipt: { indexCommit, operation, evidence }, confidenceBoundary: assembleBoundary({ staleness }),
    };
  }

  // endpoint-consumed
  const { callSitesFor } = await import('./service-contract.js');
  const boundaries: string[] = [];
  const sites = (await callSitesFor(root, [{ file: doc.file, op }], boundaries)).get(op.address) ?? [];
  if (sites.length) {
    const evidence = `${operation.address} is called from ${sites.slice(0, 5).map(s => `${s.file}:${s.line}`).join(', ')}${sites.length > 5 ? ` and ${sites.length - 5} more` : ''}`;
    return { claim, verdict: 'confirmed' as Verdict, reason: `${evidence}.`, receipt: { indexCommit, operation, consumers: sites, evidence }, confidenceBoundary: assembleBoundary({ staleness }) };
  }
  const evidence = `no client call site in this repository calls ${operation.address}`;
  return {
    claim, verdict: 'refuted' as Verdict,
    reason: `${evidence} (no consumer in the indexed repository). This is not "no caller": ${EXTERNAL_CALLERS}`,
    receipt: { indexCommit, operation, consumers: [], evidence, scope: 'this repository' },
    confidenceBoundary: assembleBoundary({ staleness, extraCrossings: [{ kind: 'unindexed-repo', count: 0, detail: EXTERNAL_CALLERS }] }),
  };
}

/** Whether an anchor names this node (by id, stable identity, or name and file). */
const anchors = (a: StructuralAnchor, n: FunctionNode) =>
  a.nodeId === n.id || (!!a.stableId && a.stableId === n.stableId) || (a.symbolName === n.name && a.filePath === n.filePath);

async function decisionGoverned(root: string, subject: string): Promise<unknown> {
  const claim = { kind: 'decision-governed' as const, subject };
  const ctx = await readCachedContext(root);
  if (!ctx) return await diagnoseIndexUnservable(root);
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;
  const staleness = await computeStaleness(root);
  const { resolveClaimSymbol, readIndexCommit, isAuthoritativeForCitation } = await import('./claim-verification.js');
  const res = resolveClaimSymbol(cg, subject);
  if (!res.node) {
    return {
      claim, verdict: 'unverifiable' as Verdict,
      reason: res.how === 'ambiguous'
        ? `Subject "${subject}" is ambiguous — it matches ${res.matched} symbols. Disambiguate before verifying.`
        : `Subject "${subject}" was not found in the call graph.`,
      confidenceBoundary: assembleBoundary({ staleness }),
    };
  }
  const node = res.node;
  const { loadDecisionStore } = await import('../../decisions/store.js');
  const { loadMemoryStore } = await import('../../decisions/memory-store.js');
  const { AnchorContext } = await import('../../decisions/anchor-adapter.js');
  const { memoryFreshness } = await import('../../decisions/anchor.js');
  const { buildRetirementGraph } = await import('./stale-decision-reference.js');
  const { emittedText } = await import('../generated-file-guard.js');
  let decisions: PendingDecision[];
  let memories: Array<{ id: string; anchors: StructuralAnchor[]; content: string; invalidatedAt?: string }>;
  try {
    decisions = (await loadDecisionStore(root)).decisions ?? [];
    memories = (await loadMemoryStore(root)).memories ?? [];
  } catch (e) {
    return { claim, verdict: 'unverifiable' as Verdict, reason: `The decision or memory store could not be read: ${e instanceof Error ? e.message : String(e)}`, confidenceBoundary: assembleBoundary({ staleness }) };
  }
  const anchorCtx = AnchorContext.open(root);
  const view = anchorCtx ? anchorCtx.freshnessView() : { nodeHash: () => undefined, fileExists: () => false, fileHash: () => undefined };
  try {
    const retired = buildRetirementGraph(decisions).retiredDecisionIds;
    const governing: Array<{ kind: 'decision' | 'memory'; id: string; freshness: string; status?: string; title?: string }> = [];
    const notGoverning: Array<{ kind: 'decision' | 'memory'; id: string; why: string }> = [];
    for (const d of decisions) {
      const a = (d.anchors ?? []).filter(x => anchors(x, node));
      if (!a.length) continue;
      const f = memoryFreshness(d.anchors ?? [], view).freshness;
      if (!isAuthoritativeForCitation(d.status) || retired.has(d.id)) notGoverning.push({ kind: 'decision', id: d.id, why: retired.has(d.id) ? 'superseded' : `status ${emittedText(String(d.status))}` });
      else if (f === 'orphaned') notGoverning.push({ kind: 'decision', id: d.id, why: 'anchor orphaned' });
      else governing.push({ kind: 'decision', id: d.id, freshness: f, status: d.status, title: emittedText(d.title).slice(0, 120) });
    }
    for (const m of memories) {
      if (m.invalidatedAt || !m.anchors.some(x => anchors(x, node))) continue;
      const f = memoryFreshness(m.anchors, view).freshness;
      if (f === 'orphaned') notGoverning.push({ kind: 'memory', id: m.id, why: 'anchor orphaned' });
      else governing.push({ kind: 'memory', id: m.id, freshness: f });
    }
    const indexCommit = await readIndexCommit(root);
    const subjectRef = { symbol: node.name, file: node.filePath };
    if (governing.length) {
      const evidence = `${governing.length} authoritative record(s) are anchored to "${node.name}" (${governing.map(g => `${g.kind} ${g.id}, ${g.freshness}`).join('; ')})`;
      return {
        claim, verdict: 'confirmed' as Verdict, reason: `${evidence}. Changing or removing it touches recorded intent: read them first.`,
        receipt: { indexCommit, subject: subjectRef, governing, ...(notGoverning.length ? { notGoverning } : {}), evidence },
        confidenceBoundary: assembleBoundary({ staleness }),
      };
    }
    const evidence = `no authoritative decision or memory is anchored to "${node.name}"${notGoverning.length ? ` (${notGoverning.length} record(s) are anchored but not in force: ${notGoverning.map(n => `${n.kind} ${n.id}, ${n.why}`).join('; ')})` : ''}`;
    return {
      claim, verdict: 'refuted' as Verdict, reason: `${evidence}. Unanchored or file-level records are not counted.`,
      receipt: { indexCommit, subject: subjectRef, governing: [], ...(notGoverning.length ? { notGoverning } : {}), evidence },
      confidenceBoundary: assembleBoundary({ staleness }),
    };
  } finally {
    anchorCtx?.close();
  }
}

export async function verifyGraphClaim(root: string, kind: GraphClaimKind, subject: string): Promise<unknown> {
  return kind === 'decision-governed' ? decisionGoverned(root, subject) : endpointClaim(root, kind, subject);
}
