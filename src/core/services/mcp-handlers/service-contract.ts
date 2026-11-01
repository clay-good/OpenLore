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

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateDirectory } from './utils.js';
import { execFileGit } from '../../../utils/git-exec.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { readBlobsAtRef, readBlobsPerFile } from '../../../utils/git-blobs.js';
import { readArtifactBounded, ANALYSIS_ARTIFACT_MAX_BYTES } from '../../../utils/bounded-artifact-read.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY } from '../../../constants.js';
import { readOpenApi, looksLikeOpenApi, MAX_SPEC_BYTES, type ContractDocument, type ContractOperation } from '../contract/openapi.js';
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

const MAX_CANDIDATES = MAX_SPEC_FILES * 10;

/** One revision's specifications, with what was and was not examined. */
export interface SpecSide {
  docs: ContractDocument[];
  /** Specifications that could not be parsed. */
  unreadable: Array<{ file: string; reason: string }>;
  /** Every YAML/JSON candidate at this revision (examined or not). */
  candidates: Set<string>;
  /** Candidates whose text was examined. */
  examined: Set<string>;
  /** Candidates that could not be read at all (size, a link outside the repository, I/O). */
  unread: Array<{ file: string; reason: string }>;
  /** Whether a cap left candidates unexamined. */
  capped: boolean;
}

/** Sniff and parse candidate texts, in path order, up to the specification cap. */
function parseSide(candidates: string[], texts: Map<string, string>, unread: SpecSide['unread']): SpecSide {
  const side: SpecSide = { docs: [], unreadable: [], candidates: new Set(candidates), examined: new Set(), unread, capped: candidates.length > MAX_CANDIDATES };
  let specs = 0;
  for (const file of candidates.slice(0, MAX_CANDIDATES)) {
    if (specs >= MAX_SPEC_FILES) { side.capped = true; break; }
    const text = texts.get(file);
    if (text === undefined) continue;
    side.examined.add(file);
    if (!looksLikeOpenApi(text)) continue;
    specs++;
    const r = readOpenApi(file, text); // a text over the size cap is an error here, never dropped
    if (!r) continue;
    if ('error' in r) side.unreadable.push({ file, reason: r.error });
    else side.docs.push(r);
  }
  return side;
}

let headCache: { root: string; stamps: string; side: SpecSide } | undefined;

/**
 * {@link headSpecs} for the briefings' hot path: the candidates are listed (one git call) and
 * stat-stamped, and their texts are read and parsed again only when a stamp changed.
 */
export async function headSpecsCached(root: string): Promise<SpecSide> {
  const candidates = await workingFiles(root, SPEC_EXT);
  const stamps = candidates.slice(0, MAX_CANDIDATES).map(f => {
    try { const s = statSync(join(root, f)); return `${f}:${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return `${f}:-`; }
  }).join('\0');
  if (headCache && headCache.root === root && headCache.stamps === stamps) return headCache.side;
  const side = await headSpecs(root, candidates);
  headCache = { root, stamps, side };
  return side;
}

export async function headSpecs(root: string, listed?: string[]): Promise<SpecSide> {
  const candidates = listed ?? await workingFiles(root, SPEC_EXT);
  const texts = new Map<string, string>();
  const unread: SpecSide['unread'] = [];
  for (const f of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      // An oversized file, or a link out of the repository, throws: it is listed as unread.
      texts.set(f, await readFileConfined(root, f, MAX_SPEC_BYTES));
    } catch (e) {
      unread.push({ file: f, reason: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }
  return parseSide(candidates, texts, unread);
}

async function baseSpecs(root: string, commit: string): Promise<SpecSide> {
  // --full-tree: from a subdirectory, ls-tree otherwise lists only that directory, relative to it.
  const listing = await git(root, gitPathArgs('ls-tree', '-r', '-z', '--full-tree', '--name-only', commit));
  const { getRepoPrefix } = await import('../../drift/git-diff.js');
  const prefix = (await getRepoPrefix(root)) ?? '';
  const full = listing.split('\0').filter(f => f && f.startsWith(prefix) && SPEC_EXT.test(f.slice(prefix.length)) && !SKIP_DIR.test(f.slice(prefix.length)))
    .sort((x, y) => sortStr(x.slice(prefix.length), y.slice(prefix.length)));
  const window = full.slice(0, MAX_CANDIDATES);
  const blobs = await readBlobsAtRef(root, commit, window).catch(() => readBlobsPerFile(root, commit, window));
  const texts = new Map<string, string>();
  const unread: SpecSide['unread'] = [];
  for (const p of window) {
    const t = blobs.get(p);
    if (t === undefined) unread.push({ file: p.slice(prefix.length), reason: 'could not be read at the base revision' });
    else texts.set(p.slice(prefix.length), t);
  }
  return parseSide(full.map(p => p.slice(prefix.length)), texts, unread);
}

/** The route inventory written by `analyze` (undefined when absent). */
export async function indexedRoutes(root: string): Promise<IndexedRoute[] | undefined> {
  const read = await readArtifactBounded(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY), ANALYSIS_ARTIFACT_MAX_BYTES).catch(() => null);
  if (!read) return undefined;
  try {
    const inv = JSON.parse(read.text) as { routes?: Array<Record<string, unknown>> };
    return (inv.routes ?? []).filter(r => typeof r.path === 'string' && typeof r.method === 'string')
      // Forward slashes: the inventory is written with the platform's separator.
      .map(r => ({ method: String(r.method), path: String(r.path), file: String(r.file ?? '').split('\\').join('/'), handler: String(r.handler ?? '') }));
  } catch {
    return undefined;
  }
}

/** Client call sites in this repository that call each changed operation. */
async function consumersOf(root: string, changes: readonly ContractChange[], docs: readonly ContractDocument[], boundaries: string[]): Promise<Map<string, Array<{ file: string; line: number; method: string; url: string }>>> {
  const out = new Map<string, Array<{ file: string; line: number; method: string; url: string }>>();
  const addresses = new Set(changes.filter(c => c.class === 'breaking' || c.class === 'dangerous').map(c => c.address));
  if (!addresses.size) return out;
  // The operations as routes: with and without their base path (a client may hold the base URL).
  const ops = docs.flatMap(d => d.operations.map(op => ({ d, op }))).filter(x => addresses.has(x.op.address));
  // Removed operations are only in the base revision: route them by their address.
  for (const addr of addresses) {
    if (ops.some(o => o.op.address === addr)) continue;
    const [method, path] = [addr.slice(0, addr.indexOf(' ')), addr.slice(addr.indexOf(' ') + 1)];
    ops.push({ d: { file: '', format: 'openapi-3', basePath: '', operations: [], unassessed: [], opaquePaths: [] }, op: { address: addr, key: addr, method, path, declaredPath: path, line: 0, deprecated: false, params: [] } });
  }
  return callSitesFor(root, ops.map(({ d, op }) => ({ file: d.file, op })), boundaries);
}

/**
 * Client call sites in this repository whose HTTP method and literal path match each operation
 * (with or without its base path), keyed by operation address.
 */
export async function callSitesFor(
  root: string,
  ops: ReadonlyArray<{ file: string; op: Pick<ContractOperation, 'address' | 'method' | 'path' | 'declaredPath' | 'line'> }>,
  boundaries: string[],
  /** Filled with the per-operation totals (before the per-operation cap) and whether a file cap was hit. */
  stats?: { capped: boolean; totals: Map<string, number> },
  /** Also carry each call's offset and client (for reading its body); not served. */
  withCall = false,
): Promise<Map<string, Array<{ file: string; line: number; method: string; url: string; offset?: number; client?: string }>>> {
  const out = new Map<string, Array<{ file: string; line: number; method: string; url: string; offset?: number; client?: string }>>();
  const { extractHttpCalls, buildHttpEdges, normalizeUrl } = await import('../../analyzer/http-route-parser.js');
  const { mapFilesBounded } = await import('../../analyzer/bounded-file-scan.js');
  const routes = ops.flatMap(({ file, op }) => [...new Set([op.path, op.declaredPath])].map(p => ({
    file, method: op.method, path: p, normalizedPath: normalizeUrl(p), handlerName: op.address,
    framework: 'openapi', line: op.line, contractSource: 'none' as const,
  })));
  const files = await workingFiles(root, CLIENT_EXT);
  if (files.length > MAX_CLIENT_FILES) boundaries.push(`Client call sites were read from the first ${MAX_CLIENT_FILES} of ${files.length} source files.`);
  if (stats) stats.capped = files.length > MAX_CLIENT_FILES;
  const calls = (await mapFilesBounded(files.slice(0, MAX_CLIENT_FILES), f => extractHttpCalls(join(root, f)).catch(() => []), 8)).flat();
  for (const e of buildHttpEdges(calls, routes)) {
    const list = out.get(e.route.handlerName) ?? [];
    const file = emittedText(e.call.file.startsWith(root) ? e.call.file.slice(root.length + 1).split('\\').join('/') : e.call.file);
    // With call offsets, two calls on one line are two sites.
    if (!list.some(c => c.file === file && (withCall && e.call.offset !== undefined ? c.offset === e.call.offset : c.line === e.call.line))) {
      list.push({ file, line: e.call.line, method: e.call.method, url: emittedText(e.call.url), ...(withCall ? { ...(e.call.offset !== undefined ? { offset: e.call.offset } : {}), client: e.call.client } : {}) });
    }
    out.set(e.route.handlerName, list);
  }
  if (stats) for (const [k, v] of out) stats.totals.set(k, v.length);
  for (const [k, v] of out) out.set(k, v.sort((a, b) => sortStr(`${a.file}:${String(a.line).padStart(8, '0')}`, `${b.file}:${String(b.line).padStart(8, '0')}`)).slice(0, MAX_CONSUMERS_PER_ELEMENT));
  boundaries.push('Consumers are client call sites in this repository whose method and literal path match; callers in other repositories, and calls through generated clients or dynamic URLs, are not known here.');
  return out;
}

/** Call sites whose body is read per run, and not-assessed sites listed. */
const MAX_PAYLOAD_SITES = 200;
const MAX_PAYLOAD_LISTED = 20;

/**
 * Each in-repo call site of an operation whose request body requires properties: a literal body
 * (an object, or `JSON.stringify` of one) missing a required property is a
 * `contract-payload-missing-required` finding; any other body is listed as not assessed.
 */
async function checkPayloads(root: string, docs: readonly ContractDocument[], findings: GovernanceFinding[], boundaries: string[]): Promise<Record<string, unknown>> {
  const ops = docs.flatMap(d => d.operations.filter(op => op.body?.assessed && op.body.properties.some(p => p.required)).map(op => ({ file: d.file, op })));
  if (!ops.length) return { assessed: false, reason: 'no operation requires request-body properties' };
  const stats = { capped: false, totals: new Map<string, number>() };
  const sites = await callSitesFor(root, ops, [], stats, true);
  const { readCallBody, insideLiteral } = await import('../contract/payload-literal.js');
  const kept = [...sites.values()].reduce((n, l) => n + l.length, 0);
  const total = [...stats.totals.values()].reduce((n, v) => n + v, 0);
  if (total > kept) boundaries.push(`Request bodies were read at ${kept} of ${total} matched call sites (at most ${MAX_CONSUMERS_PER_ELEMENT} per operation).`);
  if (stats.capped) boundaries.push(`Request bodies were read in the first ${MAX_CLIENT_FILES} source files only.`);
  const byAddress = new Map(ops.map(o => [o.op.address, o]));
  const notAssessed: Array<{ file: string; line: number; operation: string; reason: string }> = [];
  const texts = new Map<string, string | null>();
  let checked = 0;
  let conforming = 0;
  let capped = false;
  for (const [address, list] of sites) {
    const o = byAddress.get(address);
    if (!o) continue;
    const required = o.op.body!.properties.filter(p => p.required).map(p => p.name);
    for (const site of list) {
      if (checked >= MAX_PAYLOAD_SITES) { capped = true; break; }
      checked++;
      if (!texts.has(site.file)) texts.set(site.file, await readFileConfined(root, site.file, MAX_SPEC_BYTES).catch(() => null));
      const text = texts.get(site.file);
      const body = text == null || site.offset === undefined || !site.client
        ? { kind: 'not-literal' as const, reason: 'the call could not be read' }
        // A call written inside a string (an example, generated text) is not a call.
        : insideLiteral(text, site.offset) ? { kind: 'not-literal' as const, reason: 'the call is inside a string' }
          : readCallBody(text, site.offset, site.client);
      // The specification makes the body optional: a call without one conforms.
      if (body.kind === 'absent' && !o.op.body!.required) { conforming++; continue; }
      if (body.kind === 'absent') {
        findings.push({ code: 'contract-payload-missing-required', severity: 'warning', source: 'service-contract', subject: emittedText(`${site.file}:${site.line}`),
          discriminator: address, message: emittedText(`${site.file}:${site.line} calls ${address} with no request body; the specification (${o.file}:${o.op.line}) requires ${required.join(', ')}.`),
          location: { path: site.file, line: site.line } });
        continue;
      }
      if (body.kind === 'not-literal') { notAssessed.push({ file: site.file, line: site.line, operation: emittedText(address), reason: body.reason }); continue; }
      const missing = required.filter(k => !body.keys.includes(k));
      if (!missing.length) { conforming++; continue; }
      findings.push({ code: 'contract-payload-missing-required', severity: 'warning', source: 'service-contract', subject: emittedText(`${site.file}:${site.line}`),
        discriminator: address, message: emittedText(`${site.file}:${site.line} calls ${address} without required body propert${missing.length === 1 ? 'y' : 'ies'} ${missing.join(', ')} (${o.file}:${o.op.line}).`),
        location: { path: site.file, line: site.line } });
    }
  }
  if (capped) boundaries.push(`Request bodies were read at the first ${MAX_PAYLOAD_SITES} call sites only.`);
  return {
    assessed: true, callSites: checked, conforming,
    notAssessed: notAssessed.length,
    ...(notAssessed.length ? { notAssessedSites: notAssessed.slice(0, MAX_PAYLOAD_LISTED).map(n => ({ ...n, file: emittedText(n.file) })) } : {}),
    note: 'Only literal bodies (an object, or JSON.stringify of one, in the platform fetch or axios post/put/patch) are checked; a required body not sent is a finding; any other body, and calls in other languages, are not assessed, never called conforming.',
  };
}

export async function handleCertifyServiceContract(input: CertifyServiceContractInput): Promise<Record<string, unknown>> {
  const root = await validateDirectory(input.directory);
  const requested = Number(input.maxResults);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), 1000)) : 100;
  const { isGitRepository } = await import('../../drift/git-diff.js');
  if (!(await isGitRepository(root))) return { error: 'Not a git repository: specifications are listed through git.' };

  const boundaries: string[] = [];
  const head = await headSpecs(root);
  if (head.capped) boundaries.push(`Past the scan cap (${MAX_CANDIDATES} YAML/JSON files or ${MAX_SPEC_FILES} specifications), ${head.candidates.size - head.examined.size} file(s) were not checked for a specification.`);
  if (head.unread.length) boundaries.push(`${head.unread.length} YAML/JSON file(s) could not be read (over ${MAX_SPEC_BYTES / 1024 / 1024} MB, a link out of the repository, or an I/O error); a specification among them is not assessed.`);
  const notAssessed = head.unreadable.map(u => ({ file: emittedText(u.file), reason: emittedText(u.reason) }));
  for (const d of head.docs) if (d.unassessed.length) notAssessed.push({ file: emittedText(d.file), reason: `outside the model: ${d.unassessed.join(', ')}` });

  const findings: GovernanceFinding[] = [];
  const specs = head.docs.map(d => ({ file: emittedText(d.file), format: d.format, basePath: d.basePath || '/', operations: d.operations.length }));

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

  // ── Literal request bodies against the required properties (add-contract-graph-projection) ──
  const payload = await checkPayloads(root, head.docs, findings, boundaries).catch(e => ({ assessed: false, reason: e instanceof Error ? e.message.split('\n')[0] : String(e) }));

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
    for (const u of base.unreadable) notAssessed.push({ file: emittedText(u.file), reason: `at the base revision: ${emittedText(u.reason)}` });
    if (base.capped && !head.capped) boundaries.push(`At the base revision, files past the scan cap were not checked for a specification.`);
    // A file is compared only when each side either examined it or does not have it at all: a
    // specification unparseable, unread, or past a cap on one side would otherwise read as
    // operations removed or added.
    const unparsed = new Set([...head.unreadable, ...base.unreadable, ...head.unread, ...base.unread].map(u => u.file));
    // A file that is a specification on one side and read but not a specification on the other
    // (reformatted past the sniff, a version key removed) cannot be compared either.
    const specFiles = (side: SpecSide) => new Set([...side.docs.map(d => d.file), ...side.unreadable.map(u => u.file)]);
    const headSpec = specFiles(head);
    const baseSpec = specFiles(base);
    const lostSpec = (f: string) => (headSpec.has(f) && base.examined.has(f) && !baseSpec.has(f)) || (baseSpec.has(f) && head.examined.has(f) && !headSpec.has(f));
    const comparable = (file: string) => !unparsed.has(file) && !lostSpec(file)
      && (head.examined.has(file) || !head.candidates.has(file)) && (base.examined.has(file) || !base.candidates.has(file));
    const docFiles = new Set([...head.docs, ...base.docs].map(d => d.file));
    for (const u of [...head.unread, ...base.unread]) if (docFiles.has(u.file)) notAssessed.push({ file: emittedText(u.file), reason: emittedText(`unread on one side: ${u.reason}`) });
    for (const f of docFiles) {
      if (unparsed.has(f) || comparable(f)) continue;
      notAssessed.push({ file: emittedText(f), reason: lostSpec(f) ? 'reads as a specification on one side only, so it is not compared' : 'past the scan cap on one side, so it is not compared' });
    }
    // With a cap reached, an operation missing on the capped side may only have moved past the cap.
    const changes = diffContracts(base.docs.filter(d => comparable(d.file)), head.docs.filter(d => comparable(d.file))).map(c =>
      (c.rule === 'operation-removed' && head.capped) || (c.rule === 'operation-added' && base.capped)
        ? { ...c, rule: 'schema-unassessed' as const, class: 'potentially-breaking' as const, detail: `${c.detail} (a scan cap was reached, so it may only have moved)` }
        : c);
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
      items: changes.slice(0, limit).map(c => ({ ...c, file: emittedText(c.file), address: emittedText(c.address), detail: emittedText(c.detail), ...(c.element ? { element: emittedText(c.element) } : {}), consumers: consumers.get(c.address) ?? [] })),
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
  // Blocking findings are always listed, whatever the cap.
  const shown = [...gate.blocking, ...kept.filter(f => f.enforcementClass !== 'blocking').slice(0, Math.max(0, limit - gate.blocking.length))];
  return {
    tool: 'certify_service_contract',
    posture: 'advisory',
    specs,
    surface: head.docs.flatMap(d => d.operations.map(o => ({ file: emittedText(d.file), address: emittedText(o.address), line: o.line, ...(o.operationId ? { operationId: emittedText(o.operationId) } : {}), ...(o.deprecated ? { deprecated: true } : {}) }))).slice(0, limit),
    parity,
    payload,
    ...(changesOut ? { changes: changesOut } : {}),
    findings: shown,
    ...(kept.length > shown.length ? { findingsOmitted: kept.length - shown.length } : {}),
    gated: gate.gated,
    ...(notAssessed.length ? { notAssessed: notAssessed.sort((a, b) => sortStr(a.file, b.file)) } : {}),
    ...(boundaries.length ? { boundaries } : {}),
    note: 'OpenAPI 3.x and Swagger 2.0 only (protobuf and GraphQL are not read yet). Advisory: nothing blocks unless enforcement.policy says so.',
  };
}
