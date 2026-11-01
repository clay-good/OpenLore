/**
 * `verify_claim` kinds over contracts and governance (change: add-graph-claim-kinds).
 *
 *  - `endpoint-implemented` (subject: `METHOD /path`) — is the operation an OpenAPI/Swagger
 *    specification declares served by an indexed route handler?
 *  - `endpoint-consumed` (subject: `METHOD /path`) — does a client call site in this repository call
 *    it? Refuted is scoped to this repository; other callers are a named boundary.
 *  - `decision-governed` (subject: a symbol) — is an authoritative decision or memory anchored to it?
 *    Recall's rules apply: an orphaned memory, or one whose stored evidence no longer holds, is listed
 *    and never counted as governing.
 *
 * This is the tool an agent calls just before asserting a fact to a human, so a verdict is decided
 * only when the evidence settles it: a scan cap, a wildcard route, a variable base path, a missing
 * anchor store, or an unreadable store makes the claim `unverifiable` with the reason, never a guess.
 * Every repository-derived string is screened before it is served. Deterministic and offline.
 */

import { assembleBoundary, computeStaleness, type KnownUnknowableCrossing } from './confidence-boundary.js';
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
const erase = (path: string) => path.replace(/\{[^}]*\}/g, '{}');

interface Match { op: ContractOperation; doc: ContractDocument }

/**
 * Every declared operation the subject names, with or without the specification's base path. A base
 * path holding a server variable (`/{version}`) matches any concrete segment there.
 */
async function findOperations(root: string, subject: string): Promise<
  | { status: 'error'; error: string }
  | { status: 'missing'; reason: string }
  | { status: 'found'; matches: Match[] }
> {
  const key = addressKey(subject);
  if (!key) return { status: 'error', error: `"${subject}" is not an operation address — expected "METHOD /path", e.g. "POST /v1/checkout".` };
  const { isGitRepository } = await import('../../drift/git-diff.js');
  if (!(await isGitRepository(root))) return { status: 'missing', reason: 'Not a git repository: specifications are listed through git, so the operation cannot be assessed.' };
  const { headSpecs } = await import('./service-contract.js');
  const side = await headSpecs(root);
  const [method, path] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
  const matches: Match[] = [];
  for (const doc of side.docs) {
    for (const op of doc.operations) {
      if (op.method !== method) continue;
      const declared = erase(op.declaredPath);
      const full = erase(op.path);
      // A variable base path segment (`{}` before the declared path) stands for any one segment.
      const base = full.slice(0, full.length - declared.length);
      const variableBase = base.includes('{}') && new RegExp(`^${base.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\}/g, '[^/]+')}${declared.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}$`).test(path);
      if (full === path || declared === path || variableBase) matches.push({ op, doc });
    }
  }
  if (matches.length) return { status: 'found', matches };
  const unread = side.unreadable.map(u => u.file);
  const { emittedText } = await import('../generated-file-guard.js');
  return {
    status: 'missing',
    reason: side.docs.length || unread.length
      ? `"${emittedText(subject)}" is not declared in any readable OpenAPI or Swagger specification in this repository${unread.length ? ` (${unread.length} specification(s) could not be read: ${unread.slice(0, 3).map(emittedText).join(', ')})` : ''}${side.capped ? '; some YAML/JSON files past the scan cap were not checked' : ''}.`
      : 'No OpenAPI or Swagger specification was found in this repository, so the operation cannot be assessed.',
  };
}

async function endpointClaim(root: string, kind: 'endpoint-implemented' | 'endpoint-consumed', subject: string): Promise<unknown> {
  const { emittedText } = await import('../generated-file-guard.js');
  const claim = { kind, subject: emittedText(subject) };
  const staleness = await computeStaleness(root);
  const unverifiable = (reason: string, extraCrossings?: KnownUnknowableCrossing[]) =>
    ({ claim, verdict: 'unverifiable' as Verdict, reason, confidenceBoundary: assembleBoundary({ staleness, ...(extraCrossings ? { extraCrossings } : {}) }) });
  const found = await findOperations(root, subject);
  if (found.status === 'error') return { error: found.error };
  if (found.status === 'missing') return unverifiable(found.reason);
  const { readIndexCommit } = await import('./claim-verification.js');
  const operations = found.matches.map(({ op, doc }) => ({ address: emittedText(op.address), file: emittedText(doc.file), line: op.line }));
  const where = operations.map(o => `${o.address} (${o.file}:${o.line})`).join(', ');
  const indexCommit = await readIndexCommit(root);

  if (kind === 'endpoint-implemented') {
    const { indexedRoutes } = await import('./service-contract.js');
    const { routesServing } = await import('../contract/contract-diff.js');
    const { normalizeUrl } = await import('../../analyzer/http-route-parser.js');
    const routes = await indexedRoutes(root);
    if (!routes) return unverifiable('No route inventory: run `openlore analyze` first.');
    if (!routes.length) return unverifiable('No server route handler is indexed in this repository; the specification may describe another service.');
    // A server-variable base segment (`/{version}`) matches any one concrete segment in a route.
    const variableMatch = (op: ContractOperation) => {
      const full = normalizeUrl(op.path);
      if (!/\/:param/.test(full.slice(0, full.length - normalizeUrl(op.declaredPath).length))) return [];
      const re = new RegExp(`^${full.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/:param/g, '[^/]+')}$`);
      return routes.filter(r => re.test(normalizeUrl(r.path)) && (r.method.toUpperCase() === op.method || ['ALL', 'UNKNOWN'].includes(r.method.toUpperCase())));
    };
    const serving = found.matches.flatMap(({ op }) => [...routesServing(op, routes), ...variableMatch(op)]);
    if (serving.length) {
      const handlers = [...new Map(serving.map(r => [`${r.method} ${r.path} ${r.file}`, r])).values()].slice(0, 10)
        .map(r => ({ method: r.method, path: emittedText(r.path), file: emittedText(r.file) }));
      const evidence = `${where} ${found.matches.length > 1 ? 'are' : 'is'} served by ${handlers.map(h => `${h.method} ${h.path} in ${h.file}`).join(', ')}`;
      return { claim, verdict: 'confirmed' as Verdict, reason: `${evidence}.`, receipt: { indexCommit, operations, handlers, evidence }, confidenceBoundary: assembleBoundary({ staleness }) };
    }
    // A wildcard route under the operation's path, or a variable base path, may serve it unseen.
    const wildcard = routes.filter(r => {
      const n = normalizeUrl(r.path);
      if (!n.includes('*')) return false;
      const prefix = n.slice(0, n.indexOf('*')).replace(/\/$/, '');
      return found.matches.some(({ op }) => [op.path, op.declaredPath].some(p => normalizeUrl(p).startsWith(prefix)));
    });
    if (wildcard.length) {
      return unverifiable(`No route handler matches ${where} literally, but ${wildcard.length} wildcard route(s) (e.g. ${emittedText(wildcard[0].method)} ${emittedText(wildcard[0].path)} in ${emittedText(wildcard[0].file)}) may serve it; the route index cannot tell.`);
    }
    if (found.matches.some(({ op }) => erase(op.path).slice(0, erase(op.path).length - erase(op.declaredPath).length).includes('{}'))) {
      return unverifiable(`${where} sits under a base path with a server variable, which the route index cannot resolve.`);
    }
    const evidence = `${where} ${found.matches.length > 1 ? 'are' : 'is'} declared, and no indexed route handler has ${found.matches.length > 1 ? 'their' : 'its'} method and path`;
    return {
      claim, verdict: 'refuted' as Verdict, reason: `${evidence}. A handler whose path is built dynamically is not visible to the route index.`,
      receipt: { indexCommit, operations, evidence }, confidenceBoundary: assembleBoundary({ staleness }),
    };
  }

  // endpoint-consumed
  const { callSitesFor } = await import('./service-contract.js');
  const boundaries: string[] = [];
  const stats = { capped: false, totals: new Map<string, number>() };
  const bySite = await callSitesFor(root, found.matches.map(({ op, doc }) => ({ file: doc.file, op })), boundaries, stats);
  const sites = [...new Map(found.matches.flatMap(({ op }) => bySite.get(op.address) ?? []).map(s => [`${s.file}:${s.line}`, s])).values()];
  const total = found.matches.reduce((n, { op }) => n + (stats.totals.get(op.address) ?? 0), 0);
  const crossings = (extra: string[]): KnownUnknowableCrossing[] => [...boundaries, ...extra].map(detail => ({ kind: 'unindexed-repo', count: 0, detail }));
  if (sites.length) {
    const evidence = `${where} is called from ${sites.slice(0, 5).map(s => `${s.file}:${s.line}`).join(', ')}${total > 5 ? ` and ${total - 5} more` : ''}`;
    return {
      claim, verdict: 'confirmed' as Verdict, reason: `${evidence}.`, receipt: { indexCommit, operations, consumers: sites, consumerCount: total, evidence },
      confidenceBoundary: assembleBoundary({ staleness, ...(boundaries.length ? { extraCrossings: crossings([]) } : {}) }),
    };
  }
  if (stats.capped) {
    return unverifiable(`No client call site was found for ${where} in the files read, but the scan stopped at its file cap, so an unread file may call it.`, crossings([]));
  }
  const evidence = `no client call site in this repository calls ${where}`;
  return {
    claim, verdict: 'refuted' as Verdict,
    reason: `${evidence} (no consumer in the indexed repository). This is not "no caller": ${EXTERNAL_CALLERS}`,
    receipt: { indexCommit, operations, consumers: [], evidence, scope: 'this repository' },
    confidenceBoundary: assembleBoundary({ staleness, extraCrossings: crossings([EXTERNAL_CALLERS]) }),
  };
}

/** Whether an anchor names this node (by id, stable identity, or name and file). */
const anchors = (a: StructuralAnchor, n: FunctionNode) =>
  a.nodeId === n.id || (!!a.stableId && a.stableId === n.stableId) || (a.symbolName === n.name && a.filePath === n.filePath);

async function decisionGoverned(root: string, subject: string): Promise<unknown> {
  const { emittedText } = await import('../generated-file-guard.js');
  const claim = { kind: 'decision-governed' as const, subject: emittedText(subject) };
  const ctx = await readCachedContext(root);
  if (!ctx) return await diagnoseIndexUnservable(root);
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;
  const staleness = await computeStaleness(root);
  const unverifiable = (reason: string) => ({ claim, verdict: 'unverifiable' as Verdict, reason, confidenceBoundary: assembleBoundary({ staleness }) });
  const { resolveClaimSymbol, readIndexCommit, isAuthoritativeForCitation } = await import('./claim-verification.js');
  const res = resolveClaimSymbol(cg, subject);
  if (!res.node) {
    return unverifiable(res.how === 'ambiguous'
      ? `Subject "${claim.subject}" is ambiguous — it matches ${res.matched} symbols. Disambiguate before verifying.`
      : `Subject "${claim.subject}" was not found in the call graph.`);
  }
  const node = res.node;
  const { loadDecisionStore } = await import('../../decisions/store.js');
  const { loadMemoryStore } = await import('../../decisions/memory-store.js');
  const { AnchorContext } = await import('../../decisions/anchor-adapter.js');
  const { memoryFreshness } = await import('../../decisions/anchor.js');
  const { buildRetirementGraph } = await import('./stale-decision-reference.js');
  const { isWellFormedMemory } = await import('./memory-triggers.js');
  const { parseClaims, checkClaims } = await import('./memory-claims.js');
  let decisions: PendingDecision[];
  let memories: unknown[];
  try {
    // Read-only: a corrupt store is an error here, never moved aside or read as empty.
    decisions = (await loadDecisionStore(root, { readOnly: true })).decisions ?? [];
    memories = (await loadMemoryStore(root, { readOnly: true })).memories ?? [];
  } catch (e) {
    return unverifiable(`The decision or memory store could not be read: ${emittedText(e instanceof Error ? e.message : String(e))}`);
  }
  // Without the graph store, every anchor would read as orphaned: that is "not checked", not "none".
  const anchorCtx = AnchorContext.open(root);
  if (!anchorCtx) return unverifiable('No graph store to check anchors against: run `openlore analyze`.');
  try {
    const view = anchorCtx.freshnessView();
    const retired = buildRetirementGraph(decisions).retiredDecisionIds;
    const governing: Array<{ kind: 'decision' | 'memory'; id: string; freshness: string; status?: string; title?: string; approvedBy?: string }> = [];
    const notGoverning: Array<{ kind: 'decision' | 'memory'; id: string; why: string }> = [];
    for (const d of decisions) {
      if (!(d.anchors ?? []).some(x => anchors(x, node))) continue;
      const id = emittedText(String(d.id));
      const f = memoryFreshness(d.anchors ?? [], view).freshness;
      if (!isAuthoritativeForCitation(d.status) || retired.has(d.id)) notGoverning.push({ kind: 'decision', id, why: retired.has(d.id) ? 'superseded' : `status ${emittedText(String(d.status))}` });
      else if (f === 'orphaned') notGoverning.push({ kind: 'decision', id, why: 'anchor orphaned' });
      else {
        const auto = d.approvedBy === 'autopilot' && !d.humanReviewedAt;
        governing.push({ kind: 'decision', id, freshness: f, status: d.status, title: emittedText(String(d.title ?? '')).slice(0, 120), ...(auto ? { approvedBy: 'autopilot' } : {}) });
      }
    }
    const claimMemo = new Map();
    for (const raw of memories) {
      if (!isWellFormedMemory(raw)) continue;
      const m = raw as { id: string; anchors: StructuralAnchor[]; invalidatedAt?: string; claims?: unknown };
      if (m.invalidatedAt || !m.anchors.some(x => anchors(x, node))) continue;
      const id = emittedText(String(m.id));
      const f = memoryFreshness(m.anchors, view).freshness;
      if (f === 'orphaned') { notGoverning.push({ kind: 'memory', id, why: 'anchor orphaned' }); continue; }
      // A note resting on claims governs only while its evidence holds (recall's lanes).
      if (m.claims !== undefined) {
        const parsed = parseClaims(m.claims);
        if ('error' in parsed) { notGoverning.push({ kind: 'memory', id, why: 'stored evidence unreadable' }); continue; }
        const checks = await checkClaims(root, parsed.claims, claimMemo);
        if (checks.some(c => c.verdict === 'evidence-refuted')) { notGoverning.push({ kind: 'memory', id, why: 'stored evidence refuted' }); continue; }
        if (checks.some(c => c.verdict !== 'evidence-holds')) { notGoverning.push({ kind: 'memory', id, why: 'stored evidence unverifiable' }); continue; }
      }
      governing.push({ kind: 'memory', id, freshness: f });
    }
    const indexCommit = await readIndexCommit(root);
    const subjectRef = { symbol: emittedText(node.name), file: emittedText(node.filePath) };
    if (governing.length) {
      const auto = governing.some(g => g.approvedBy === 'autopilot');
      const evidence = `${governing.length} authoritative record(s) are anchored to "${subjectRef.symbol}" (${governing.map(g => `${g.kind} ${g.id}, ${g.freshness}`).join('; ')})`;
      return {
        claim, verdict: 'confirmed' as Verdict,
        reason: `${evidence}${auto ? ' (a decision was auto-accepted by decision autopilot and not yet human-reviewed — disclose this provenance when citing it)' : ''}. Changing or removing it touches recorded intent: read them first.`,
        receipt: { indexCommit, subject: subjectRef, governing, ...(notGoverning.length ? { notGoverning } : {}), evidence },
        confidenceBoundary: assembleBoundary({ staleness }),
      };
    }
    const evidence = `no authoritative decision or memory is anchored to "${subjectRef.symbol}"${notGoverning.length ? ` (${notGoverning.length} record(s) are anchored but not in force: ${notGoverning.map(n => `${n.kind} ${n.id}, ${n.why}`).join('; ')})` : ''}`;
    return {
      claim, verdict: 'refuted' as Verdict, reason: `${evidence}. Unanchored or file-level records are not counted.`,
      receipt: { indexCommit, subject: subjectRef, governing: [], ...(notGoverning.length ? { notGoverning } : {}), evidence },
      confidenceBoundary: assembleBoundary({ staleness }),
    };
  } finally {
    anchorCtx.close();
  }
}

export async function verifyGraphClaim(root: string, kind: GraphClaimKind, subject: string): Promise<unknown> {
  return kind === 'decision-governed' ? decisionGoverned(root, subject) : endpointClaim(root, kind, subject);
}
