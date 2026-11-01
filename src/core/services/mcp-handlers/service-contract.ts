/**
 * certify_service_contract — API schemas checked against the code that serves and calls them
 * (change: add-service-contract-certification, OpenAPI phase).
 *
 * Without a base ref: the contract surface of every OpenAPI / Swagger document in the repository,
 * and two-way parity against the indexed route handlers (`contract-declared-unimplemented`,
 * `contract-implemented-undeclared`). With a base ref: a closed-table verdict for each changed
 * element against the merge-base, each `breaking` or `dangerous` one joined to the client call
 * sites in this repository that call it (`contract-breaking`).
 *
 * Deterministic and offline: schemas come from the working tree and from the base revision via git.
 * An unreadable schema is `notAssessed`, never "no changes"; parity is not claimed when no route
 * handler is indexed; consumers outside this repository are a disclosed boundary.
 *
 * Siblings: `certify_public_surface` certifies the shape of code exports; `change_impact_certificate`
 * the paths a change opens into declared surfaces.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateDirectory } from './utils.js';
import { execFileGit } from '../../../utils/git-exec.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { readBlobsAtRef, readBlobsPerFile } from '../../../utils/git-blobs.js';
import { readArtifactBounded, ANALYSIS_ARTIFACT_MAX_BYTES } from '../../../utils/bounded-artifact-read.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY } from '../../../constants.js';
import { readOpenApi, looksLikeOpenApi, MAX_SPEC_BYTES, type ContractDocument } from '../contract/openapi.js';
import { diffContracts, contractParity, contractBump, type ContractChange, type IndexedRoute } from '../contract/contract-diff.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { classifyFindings, effectivePolicy, type GovernanceFinding } from './enforcement-policy.js';
import { emittedText } from '../generated-file-guard.js';

export interface CertifyServiceContractInput {
  directory: string;
  baseRef?: string;
  /** Cap on each listed item kind (default 100, max 1,000); totals are always given. */
  maxResults?: number;
  allowBaseFallback?: boolean;
}

const SPEC_EXT = /\.(?:ya?ml|json)$/i;
const SKIP_DIR = /(?:^|\/)(?:node_modules|vendor|dist|build|\.git)\//;
const MAX_SPEC_FILES = 200;
const CLIENT_EXT = /\.(?:[cm]?[jt]sx?|py|pyw|go)$/i;
const MAX_CLIENT_FILES = 3000;
const MAX_CONSUMERS_PER_ELEMENT = 25;

const sortStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return String(stdout);
}

/** Files in the working tree (tracked and untracked, not ignored) matching `ext`. */
async function workingFiles(root: string, ext: RegExp): Promise<string[]> {
  const out = await git(root, gitPathArgs('ls-files', '-z', '--cached', '--others', '--exclude-standard'));
  return [...new Set(out.split('\0').filter(f => f && ext.test(f) && !SKIP_DIR.test(f)))].sort(sortStr);
}

/** Read and parse the specifications among `texts` (path → text). */
function parseSpecs(texts: Map<string, string>): { docs: ContractDocument[]; unreadable: Array<{ file: string; reason: string }> } {
  const docs: ContractDocument[] = [];
  const unreadable: Array<{ file: string; reason: string }> = [];
  for (const [file, text] of [...texts].sort((a, b) => sortStr(a[0], b[0]))) {
    if (!looksLikeOpenApi(text)) continue;
    const r = readOpenApi(file, text);
    if (!r) continue;
    if ('error' in r) unreadable.push({ file, reason: r.error });
    else docs.push(r);
  }
  return { docs, unreadable };
}

async function headSpecs(root: string): Promise<{ docs: ContractDocument[]; unreadable: Array<{ file: string; reason: string }>; capped: number }> {
  const candidates = await workingFiles(root, SPEC_EXT);
  const texts = new Map<string, string>();
  for (const f of candidates.slice(0, MAX_SPEC_FILES * 10)) {
    if (texts.size >= MAX_SPEC_FILES) break;
    try {
      const t = await readFileConfined(root, f, MAX_SPEC_BYTES);
      if (looksLikeOpenApi(t)) texts.set(f, t);
    } catch { /* unreadable or over the size cap: not a specification we can read */ }
  }
  return { ...parseSpecs(texts), capped: Math.max(0, candidates.length - MAX_SPEC_FILES * 10) };
}

async function baseSpecs(root: string, commit: string): Promise<ReturnType<typeof parseSpecs>> {
  const listing = await git(root, gitPathArgs('ls-tree', '-r', '-z', '--name-only', commit));
  const { getRepoPrefix } = await import('../../drift/git-diff.js');
  const prefix = (await getRepoPrefix(root)) ?? '';
  const paths = listing.split('\0').filter(f => f.startsWith(prefix) && SPEC_EXT.test(f) && !SKIP_DIR.test(f)).slice(0, MAX_SPEC_FILES * 10);
  const blobs = await readBlobsAtRef(root, commit, paths).catch(() => readBlobsPerFile(root, commit, paths));
  const texts = new Map<string, string>();
  for (const [p, t] of blobs) if (t.length <= MAX_SPEC_BYTES && looksLikeOpenApi(t) && texts.size < MAX_SPEC_FILES) texts.set(p.slice(prefix.length), t);
  return parseSpecs(texts);
}

/** The route inventory written by `analyze` (undefined when absent). */
async function indexedRoutes(root: string): Promise<IndexedRoute[] | undefined> {
  const read = await readArtifactBounded(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY), ANALYSIS_ARTIFACT_MAX_BYTES).catch(() => null);
  if (!read) return undefined;
  try {
    const inv = JSON.parse(read.text) as { routes?: Array<Record<string, unknown>> };
    return (inv.routes ?? []).filter(r => typeof r.path === 'string' && typeof r.method === 'string')
      .map(r => ({ method: String(r.method), path: String(r.path), file: String(r.file ?? ''), handler: String(r.handler ?? '') }));
  } catch {
    return undefined;
  }
}

/** Client call sites in this repository that call each changed operation. */
async function consumersOf(root: string, changes: readonly ContractChange[], docs: readonly ContractDocument[], boundaries: string[]): Promise<Map<string, Array<{ file: string; line: number; method: string; url: string }>>> {
  const out = new Map<string, Array<{ file: string; line: number; method: string; url: string }>>();
  const addresses = new Set(changes.filter(c => c.class === 'breaking' || c.class === 'dangerous').map(c => c.address));
  if (!addresses.size) return out;
  const { extractHttpCalls, buildHttpEdges, normalizeUrl } = await import('../../analyzer/http-route-parser.js');
  const { mapFilesBounded } = await import('../../analyzer/bounded-file-scan.js');
  // The operations as routes: with and without their base path (a client may hold the base URL).
  const ops = docs.flatMap(d => d.operations.map(op => ({ d, op }))).filter(x => addresses.has(x.op.address));
  // Removed operations are only in the base revision: route them by their address.
  for (const addr of addresses) {
    if (ops.some(o => o.op.address === addr)) continue;
    const [method, path] = [addr.slice(0, addr.indexOf(' ')), addr.slice(addr.indexOf(' ') + 1)];
    ops.push({ d: { file: '', format: 'openapi-3', basePath: '', operations: [], unassessed: [] }, op: { address: addr, method, path, declaredPath: path, line: 0, deprecated: false, params: [] } });
  }
  const routes = ops.flatMap(({ d, op }) => [...new Set([op.path, op.declaredPath])].map(p => ({
    file: d.file, method: op.method, path: p, normalizedPath: normalizeUrl(p), handlerName: op.address,
    framework: 'openapi', line: op.line, contractSource: 'none' as const,
  })));
  const files = await workingFiles(root, CLIENT_EXT);
  if (files.length > MAX_CLIENT_FILES) boundaries.push(`Client call sites were read from the first ${MAX_CLIENT_FILES} of ${files.length} source files.`);
  const calls = (await mapFilesBounded(files.slice(0, MAX_CLIENT_FILES), f => extractHttpCalls(join(root, f)).catch(() => []), 8)).flat();
  for (const e of buildHttpEdges(calls, routes)) {
    const list = out.get(e.route.handlerName) ?? [];
    const file = e.call.file.startsWith(root) ? e.call.file.slice(root.length + 1).split('\\').join('/') : e.call.file;
    if (!list.some(c => c.file === file && c.line === e.call.line)) list.push({ file, line: e.call.line, method: e.call.method, url: emittedText(e.call.url) });
    out.set(e.route.handlerName, list);
  }
  for (const [k, v] of out) out.set(k, v.sort((a, b) => sortStr(`${a.file}:${String(a.line).padStart(8, '0')}`, `${b.file}:${String(b.line).padStart(8, '0')}`)).slice(0, MAX_CONSUMERS_PER_ELEMENT));
  boundaries.push('Consumers are client call sites in this repository whose method and literal path match; callers in other repositories, and calls through generated clients or dynamic URLs, are not known here.');
  return out;
}

export async function handleCertifyServiceContract(input: CertifyServiceContractInput): Promise<Record<string, unknown>> {
  const root = await validateDirectory(input.directory);
  const limit = Math.max(1, Math.min(input.maxResults ?? 100, 1000));
  const { isGitRepository } = await import('../../drift/git-diff.js');
  if (!(await isGitRepository(root))) return { error: 'Not a git repository: specifications are listed through git.' };

  const boundaries: string[] = [];
  const head = await headSpecs(root);
  if (head.capped) boundaries.push(`${head.capped} candidate YAML/JSON file(s) past the scan cap were not checked for a specification.`);
  const notAssessed = head.unreadable.map(u => ({ file: u.file, reason: emittedText(u.reason) }));
  for (const d of head.docs) if (d.unassessed.length) notAssessed.push({ file: d.file, reason: `outside the model: ${d.unassessed.join(', ')}` });

  const findings: GovernanceFinding[] = [];
  const specs = head.docs.map(d => ({ file: d.file, format: d.format, basePath: d.basePath || '/', operations: d.operations.length }));

  // ── Parity against the indexed route handlers ──
  const routes = await indexedRoutes(root);
  let parity: Record<string, unknown>;
  if (!head.docs.length) parity = { assessed: false, reason: 'no OpenAPI or Swagger document was found' };
  else if (!routes) parity = { assessed: false, reason: 'no route inventory: run `openlore analyze` first' };
  else if (!routes.length) parity = { assessed: false, reason: 'no server route handler is indexed in this repository (the specification may describe another service)' };
  else {
    const p = contractParity(head.docs, routes);
    for (const u of p.declaredUnimplemented) {
      findings.push({ code: 'contract-declared-unimplemented', severity: 'warning', source: 'service-contract', subject: emittedText(u.address),
        message: emittedText(`${u.address} is declared in ${u.file}:${u.line} but no indexed route handler serves it.`),
        location: { path: u.file, line: u.line } });
    }
    for (const u of p.implementedUndeclared) {
      const subject = `${u.file}::${u.method} ${u.path}`;
      findings.push({ code: 'contract-implemented-undeclared', severity: 'warning', source: 'service-contract', subject: emittedText(subject),
        message: emittedText(`${u.method} ${u.path} (in ${u.file}) is under a path the specification covers, but the specification does not declare it.`),
        location: { path: u.file } });
    }
    if (p.dynamic) boundaries.push(`${p.dynamic} route handler(s) with a dynamic path were not compared with the specifications.`);
    parity = { assessed: true, matched: p.matched, declaredUnimplemented: p.declaredUnimplemented.length, implementedUndeclared: p.implementedUndeclared.length };
  }

  // ── Breaking-change verdicts against the merge-base ──
  let changesOut: Record<string, unknown> | undefined;
  if (input.baseRef) {
    const { validateGitRef, resolveBaseRefDisclosed } = await import('../../drift/git-diff.js');
    try { validateGitRef(input.baseRef); } catch (e) { return { error: `Invalid base ref: ${e instanceof Error ? e.message : String(e)}` }; }
    const res = await resolveBaseRefDisclosed(root, input.baseRef);
    if (res.fellBack && !input.allowBaseFallback) {
      return { error: `Base ref '${input.baseRef}' does not resolve; pass an existing ref, or allowBaseFallback to compare with '${res.resolved}'.` };
    }
    let commit = res.resolved;
    try { commit = (await git(root, ['merge-base', res.resolved, 'HEAD'])).trim() || res.resolved; } catch { /* unrelated histories: the base tip */ }
    const base = await baseSpecs(root, commit);
    for (const u of base.unreadable) notAssessed.push({ file: u.file, reason: `at the base revision: ${emittedText(u.reason)}` });
    // A specification unreadable on either side: its operations cannot be compared.
    const unreadable = new Set([...head.unreadable, ...base.unreadable].map(u => u.file));
    const changes = diffContracts(base.docs.filter(d => !unreadable.has(d.file)), head.docs.filter(d => !unreadable.has(d.file)));
    const consumers = await consumersOf(root, changes, [...head.docs, ...base.docs], boundaries);
    for (const c of changes.filter(x => x.class === 'breaking' || x.class === 'dangerous')) {
      const who = consumers.get(c.address) ?? [];
      const subject = `${c.address}${c.element ? ` ${c.element}` : ''}`;
      findings.push({
        code: 'contract-breaking', severity: c.class === 'breaking' ? 'error' : 'warning', source: 'service-contract', subject: emittedText(subject),
        discriminator: c.rule, message: emittedText(`${c.detail} (${c.rule}, ${c.class})${who.length ? `; called from ${who.slice(0, 3).map(w => `${w.file}:${w.line}`).join(', ')}${who.length > 3 ? ` and ${who.length - 3} more` : ''}` : '; no caller in this repository'}.`),
        location: { path: c.file, line: c.line },
      });
    }
    changesOut = {
      baseRef: input.baseRef, resolvedBaseRef: res.resolved, ...(res.fellBack ? { baseRefFallback: { requested: res.requested, resolved: res.resolved } } : {}),
      total: changes.length,
      items: changes.slice(0, limit).map(c => ({ ...c, address: emittedText(c.address), detail: emittedText(c.detail), consumers: consumers.get(c.address) ?? [] })),
      ...(changes.length > limit ? { omitted: changes.length - limit } : {}),
      suggestedBump: contractBump(changes),
      ...(contractBump(changes) === null ? { suggestedBumpWithheld: 'a change is outside the model, so compatibility is not proven' } : {}),
    };
  }

  let policy;
  try {
    const config = await readOpenLoreConfig(root);
    if (!config && existsSync(join(root, OPENLORE_DIR, 'config.json'))) throw new Error('.openlore/config.json is not valid JSON');
    policy = effectivePolicy(config);
  } catch (e) {
    boundaries.push(emittedText(`The configuration could not be read, so enforcement.policy was not applied (every finding is advisory): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`));
  }
  const gate = classifyFindings(findings, policy);
  const kept = gate.classified.filter(f => f.enforcementClass !== 'off');
  return {
    tool: 'certify_service_contract',
    posture: 'advisory',
    specs,
    surface: head.docs.flatMap(d => d.operations.map(o => ({ file: d.file, address: emittedText(o.address), line: o.line, ...(o.operationId ? { operationId: emittedText(o.operationId) } : {}), ...(o.deprecated ? { deprecated: true } : {}) }))).slice(0, limit),
    parity,
    ...(changesOut ? { changes: changesOut } : {}),
    findings: kept.slice(0, Math.max(limit, gate.blocking.length)),
    ...(kept.length > limit ? { findingsOmitted: kept.length - limit } : {}),
    gated: gate.gated,
    ...(notAssessed.length ? { notAssessed: notAssessed.sort((a, b) => sortStr(a.file, b.file)) } : {}),
    ...(boundaries.length ? { boundaries } : {}),
    note: 'OpenAPI 3.x and Swagger 2.0 only (protobuf and GraphQL are not read yet). Advisory: nothing blocks unless enforcement.policy says so.',
  };
}
