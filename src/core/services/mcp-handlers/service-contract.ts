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
import { readOpenApi, looksLikeOpenApi, MAX_SPEC_BYTES, type ContractDocument, type ContractOperation } from '../../analyzer/contract/openapi.js';
import { diffContracts, contractParity, contractBump, type ContractChange, type IndexedRoute } from '../contract/contract-diff.js';
import { readProtobuf, resolveProtoTypes, isProtobufPath, type ProtoDocument } from '../../analyzer/contract/protobuf.js';
import { diffProtobuf } from '../contract/protobuf-diff.js';
import { MAX_PROTO_FILES } from '../../analyzer/contract/project-protobuf.js';
import { readGraphql, mergeGraphqlSchema, isGraphqlPath, relaySchemaPaths, type GqlDocument } from '../../analyzer/contract/graphql.js';
import { diffGraphql } from '../contract/graphql-diff.js';
import { isFixtureSchemaPath } from '../../analyzer/contract/types.js';
import { MAX_GRAPHQL_FILES } from '../../analyzer/contract/project-graphql.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { classifyFindings, effectivePolicy, type GovernanceFinding } from './enforcement-policy.js';
import { emittedText } from '../generated-file-guard.js';

export interface CertifyServiceContractInput {
  directory: string;
  baseRef?: string;
  /** Cap on each listed item kind (default 100, max 1,000); totals are always given. */
  maxResults?: number;
  allowBaseFallback?: boolean;
  /**
   * Opt-in: also count client call sites in indexed sibling repositories
   * (`.openlore/federation.json`), as `certify_public_surface` does for an exported symbol.
   *
   * A service's consumers are usually NOT in its own repository, so a breaking verdict computed
   * from this repository alone reads as "nothing calls it" for exactly the change most worth
   * stopping (change: add-contract-graph-projection).
   */
  federation?: boolean;
  /** Limit the federation census to these registry repo names (default: all). */
  federationRepos?: string[];
}

/** Consumers of one operation found in a sibling repository. */
export interface FederatedConsumer {
  /** The registry name of the sibling repository — its stable id, not its path. */
  repo: string;
  file: string;
  line: number;
}

/** What the federation census covered, and what it did not. */
export interface FederationCensus {
  /** Siblings scanned in full. */
  repos: string[];
  /** Siblings whose scan hit a file cap: scanned, but not exhaustively. */
  partial: string[];
  /** Siblings not scanned at all, each with why. */
  skipped: Array<{ repo: string; reason: string }>;
  /** Skipped entries past the cap. */
  skippedOmitted?: number;
}

/** Federated consumers listed per call (one flat list), and skipped siblings listed per call. */
const MAX_FEDERATED_CONSUMERS = 100;
const MAX_FEDERATION_SKIPPED = 50;

const SPEC_EXT = /\.(?:ya?ml|json|proto|graphqls?|gql)$/i;
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
type ScanScopeLike = { capped: boolean; unreadable: unknown[]; unread: unknown[] };
/** Total `.proto` text held per revision, the same bound the analyzer's walk applies. */
const MAX_PROTO_TOTAL_BYTES = 64 * 1024 * 1024;

/** What one revision's scan of one format examined, read, and could not read. */
interface ScanScope {
  /** Specifications that could not be parsed. */
  unreadable: Array<{ file: string; reason: string }>;
  /** Every candidate of this format at this revision (examined or not). */
  candidates: Set<string>;
  /** Candidates whose text was examined. */
  examined: Set<string>;
  /** Candidates that could not be read at all (size, a link outside the repository, I/O). */
  unread: Array<{ file: string; reason: string }>;
  /** Whether a cap left candidates unexamined. */
  capped: boolean;
}

/**
 * One revision's specifications, with what was and was not examined.
 *
 * The top-level fields are the OpenAPI / Swagger scan of YAML and JSON files, exactly as they
 * were before protobuf was read. `proto` is a separate scan of `.proto` files with its own window
 * and cap (change: add-contract-graph-projection): sharing one window let a repository's protobuf
 * files push its OpenAPI document out of the scan, and sharing one cap flag downgraded every
 * OpenAPI removal to "may only have moved".
 */
export interface SpecSide extends ScanScope {
  docs: ContractDocument[];
  /** GraphQL SDL files, a scope of their own too; client documents are not schemas. */
  graphql: ScanScope & { docs: GqlDocument[]; clientDocuments: string[] };
  proto: ScanScope & {
    /** Types resolved across every `.proto` file of this revision. */
    docs: ProtoDocument[];
  };
}

/** Sniff and parse the YAML/JSON candidates, in path order, up to the specification cap. */
function parseSide(candidates: string[], texts: Map<string, string>, unread: SpecSide['unread'], proto: SpecSide['proto'], graphql: SpecSide['graphql']): SpecSide {
  const side: SpecSide = { docs: [], unreadable: [], candidates: new Set(candidates), examined: new Set(), unread, capped: candidates.length > MAX_CANDIDATES, proto, graphql };
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

/** Parse the `.proto` candidates (every one is a schema), up to the protobuf cap. */
function parseProtoSide(candidates: string[], texts: Map<string, string>, unread: SpecSide['unread']): SpecSide['proto'] {
  const scope: SpecSide['proto'] = { docs: [], unreadable: [], candidates: new Set(candidates), examined: new Set(), unread, capped: candidates.length > MAX_PROTO_FILES };
  const read: ProtoDocument[] = [];
  for (const file of candidates.slice(0, MAX_PROTO_FILES)) {
    const text = texts.get(file);
    if (text === undefined) continue;
    scope.examined.add(file);
    const r = readProtobuf(file, text);
    if ('error' in r) scope.unreadable.push({ file, reason: r.error });
    else read.push(r);
  }
  scope.docs = resolveProtoTypes(read).docs;
  return scope;
}

/** Parse the GraphQL candidates, up to the GraphQL cap. A client document is set aside, not unread. */
function parseGraphqlSide(candidates: string[], texts: Map<string, string>, unread: SpecSide['unread']): SpecSide['graphql'] {
  const scope: SpecSide['graphql'] = { docs: [], clientDocuments: [], unreadable: [], candidates: new Set(candidates), examined: new Set(), unread, capped: candidates.length > MAX_CANDIDATES };
  // The cap counts SCHEMAS: a frontend's hundreds of query documents must not push its schema out.
  let schemas = 0;
  for (const file of candidates.slice(0, MAX_CANDIDATES)) {
    const text = texts.get(file);
    if (text === undefined) continue;
    const r = readGraphql(file, text);
    // Client documents are read past the cap too (they cost no schema slot); a schema past it is not.
    if (!('clientDocument' in r)) { if (schemas >= MAX_GRAPHQL_FILES) { scope.capped = true; continue; } schemas++; }
    scope.examined.add(file);
    if ('error' in r) scope.unreadable.push({ file, reason: r.error });
    else if ('clientDocument' in r) scope.clientDocuments.push(file);
    else scope.docs.push(r);
  }
  return scope;
}

/** The candidates each scan reads: YAML/JSON, `.proto` and GraphQL in separate windows. */
const windows = (listed: readonly string[]) => {
  const yaml = listed.filter(f => !isProtobufPath(f) && !isGraphqlPath(f));
  // The same fixture rule as `analyze`: a test schema is a fake service, not this repository's contract.
  const proto = listed.filter(f => isProtobufPath(f) && !isFixtureSchemaPath(f));
  const graphql = listed.filter(f => isGraphqlPath(f) && !isFixtureSchemaPath(f));
  return { yaml, proto, graphql, read: [...yaml.slice(0, MAX_CANDIDATES), ...proto.slice(0, MAX_PROTO_FILES), ...graphql.slice(0, MAX_CANDIDATES)] };
};

let headCache: { root: string; stamps: string; side: SpecSide } | undefined;

/**
 * {@link headSpecs} for the briefings' hot path: the candidates are listed (one git call) and
 * stat-stamped, and their texts are read and parsed again only when a stamp changed.
 */
export async function headSpecsCached(root: string): Promise<SpecSide> {
  const candidates = await workingFiles(root, SPEC_EXT);
  const stamps = windows(candidates).read.map(f => {
    try { const s = statSync(join(root, f)); return `${f}:${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return `${f}:-`; }
  }).join('\0');
  if (headCache && headCache.root === root && headCache.stamps === stamps) return headCache.side;
  const side = await headSpecs(root, candidates);
  headCache = { root, stamps, side };
  return side;
}

/** The schema a Relay compiler config names: a vendor schema copy, not this repository's contract. */
async function clientSchemas(root: string): Promise<Set<string>> {
  const configs: Array<{ path: string; content: string }> = [];
  for (const path of ['package.json', 'relay.config.json', 'relay.config.js', 'relay.config.cjs', 'relay.config.mjs', 'relay.config.ts']) {
    try { configs.push({ path, content: await readFileConfined(root, path, 1024 * 1024) }); } catch { /* absent */ }
  }
  return relaySchemaPaths(configs);
}

export async function headSpecs(root: string, listed?: string[]): Promise<SpecSide> {
  const w = windows(listed ?? await workingFiles(root, SPEC_EXT));
  const texts = new Map<string, string>();
  const unread: SpecSide['unread'] = [];
  const protoUnread: SpecSide['unread'] = [];
  const graphqlUnread: SpecSide['unread'] = [];
  const unreadFor = (f: string) => (isProtobufPath(f) ? protoUnread : isGraphqlPath(f) ? graphqlUnread : unread);
  let schemaBytes = 0;
  for (const f of w.read) {
    const schema = isProtobufPath(f) || isGraphqlPath(f);
    // The `.proto` and GraphQL texts held at once are bounded in total too: 500 files of 4 MB is 2 GB.
    if (schema && schemaBytes > MAX_PROTO_TOTAL_BYTES) { unreadFor(f).push({ file: f, reason: 'past the total schema byte budget' }); continue; }
    try {
      // An oversized file, or a link out of the repository, throws: it is listed as unread.
      const text = await readFileConfined(root, f, MAX_SPEC_BYTES);
      if (schema) schemaBytes += text.length;
      texts.set(f, text);
    } catch (e) {
      unreadFor(f).push({ file: f, reason: e instanceof Error ? e.message.split('\n')[0] : String(e) });
    }
  }
  return parseSide(w.yaml, texts, unread, parseProtoSide(w.proto, texts, protoUnread), parseGraphqlSide(w.graphql, texts, graphqlUnread));
}

async function baseSpecs(root: string, commit: string): Promise<SpecSide> {
  // --full-tree: from a subdirectory, ls-tree otherwise lists only that directory, relative to it.
  const listing = await git(root, gitPathArgs('ls-tree', '-r', '-z', '--full-tree', '--name-only', commit));
  const { getRepoPrefix } = await import('../../drift/git-diff.js');
  const prefix = (await getRepoPrefix(root)) ?? '';
  const full = listing.split('\0').filter(f => f && f.startsWith(prefix) && SPEC_EXT.test(f.slice(prefix.length)) && !SKIP_DIR.test(f.slice(prefix.length)))
    .map(f => f.slice(prefix.length)).sort(sortStr);
  const w = windows(full);
  const paths = w.read.map(f => prefix + f);
  const blobs = await readBlobsAtRef(root, commit, paths).catch(() => readBlobsPerFile(root, commit, paths));
  const texts = new Map<string, string>();
  const unread: SpecSide['unread'] = [];
  const protoUnread: SpecSide['unread'] = [];
  const graphqlUnread: SpecSide['unread'] = [];
  const unreadFor = (f: string) => (isProtobufPath(f) ? protoUnread : isGraphqlPath(f) ? graphqlUnread : unread);
  let schemaBytes = 0;
  for (const f of w.read) {
    const t = blobs.get(prefix + f);
    // Checked before counting, as on the working-tree side, so both sides read the same files.
    if (t !== undefined && (isProtobufPath(f) || isGraphqlPath(f))) {
      if (schemaBytes > MAX_PROTO_TOTAL_BYTES) { unreadFor(f).push({ file: f, reason: 'past the total schema byte budget' }); continue; }
      schemaBytes += t.length;
    }
    if (t === undefined) unreadFor(f).push({ file: f, reason: 'could not be read at the base revision' });
    else texts.set(f, t);
  }
  return parseSide(w.yaml, texts, unread, parseProtoSide(w.proto, texts, protoUnread), parseGraphqlSide(w.graphql, texts, graphqlUnread));
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

/** Distinct consumer functions whose reaching tests are computed per run, and tests listed per consumer. */
const MAX_CONSUMER_FUNCTIONS = 20;
const MAX_TESTS_PER_CONSUMER = 5;

/**
 * Each consumer call site's enclosing indexed function and the tests that reach it (`select_tests`),
 * so a breaking change names what to run. A call outside any indexed function, or past the cap, says
 * why its tests are not computed (never "no tests").
 */
async function attachReachingTests(
  root: string,
  consumers: Map<string, Array<{ file: string; line: number; tests?: string[]; testsTotal?: number; testsNotComputed?: string }>>,
  boundaries: string[],
): Promise<void> {
  const all = [...consumers.values()].flat();
  if (!all.length) return;
  const { readCachedContext } = await import('./utils.js');
  const ctx = await readCachedContext(root).catch(() => null);
  const nodes = ((ctx?.callGraph as { nodes?: Array<{ name: string; filePath: string; startLine?: number; endLine?: number; isExternal?: boolean; isTest?: boolean }> } | undefined)?.nodes ?? [])
    .filter(n => !n.isExternal && !n.isTest && typeof n.startLine === 'number' && typeof n.endLine === 'number');
  if (!nodes.length) {
    for (const c of all) c.testsNotComputed = 'no index: run `openlore analyze`';
    return;
  }
  const enclosing = (file: string, line: number) => nodes
    .filter(n => n.filePath === file && n.startLine! <= line && n.endLine! >= line)
    .sort((a, b) => (a.endLine! - a.startLine!) - (b.endLine! - b.startLine!))[0];
  const { handleSelectTests } = await import('./test-impact.js');
  const testsByName = new Map<string, { tests: string[]; total: number } | string>();
  for (const c of all) {
    const fn = enclosing(c.file, c.line);
    if (!fn) { c.testsNotComputed = 'the call is outside any indexed function'; continue; }
    if (!testsByName.has(fn.name)) {
      if (testsByName.size >= MAX_CONSUMER_FUNCTIONS) { c.testsNotComputed = `past the first ${MAX_CONSUMER_FUNCTIONS} consumer functions`; continue; }
      const sel = await handleSelectTests({ directory: root, changedSymbols: [fn.name] }).catch(e => ({ error: e instanceof Error ? e.message : String(e) })) as { selectedTests?: Array<{ test: string; file: string }>; error?: string };
      testsByName.set(fn.name, sel.error || !sel.selectedTests ? (sel.error ?? 'no result') : (() => {
        const t = [...new Set(sel.selectedTests!.map(x => emittedText(`${x.file} › ${x.test}`)))];
        return { tests: t.slice(0, MAX_TESTS_PER_CONSUMER), total: t.length };
      })());
    }
    const r = testsByName.get(fn.name)!;
    if (typeof r === 'string') c.testsNotComputed = emittedText(r);
    else { c.tests = r.tests; c.testsTotal = r.total; }
  }
  boundaries.push('Tests per consumer are the tests select_tests reaches from the function that holds the call, matched by its name (a same-named function elsewhere widens the set).');
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
    ops.push({ d: { file: '', format: 'openapi-3', basePath: '', serverHosts: [], operations: [], schemas: [], schemasDeclared: 0, unassessed: [], opaquePaths: [] }, op: { address: addr, key: addr, method, path, declaredPath: path, line: 0, deprecated: false, params: [], refs: [] } });
  }
  return callSitesFor(root, ops.map(({ d, op }) => ({ file: d.file, op })), boundaries);
}

/**
 * Client call sites in INDEXED SIBLING repositories, keyed by operation address.
 *
 * A service's consumers are usually not in its own repository, so a breaking verdict computed
 * from this repository alone reads as "nothing calls it" for exactly the change most worth
 * stopping. This runs the same literal method-and-path match over each registered sibling, and
 * reports each hit against the sibling's REGISTRY NAME — its stable id — never its path on this
 * machine (change: add-contract-graph-projection).
 *
 * Honesty is the whole difficulty here, so every repository that was not censused is named:
 * a sibling that is missing, unindexed, stale or unbaselined is NOT evidence of no consumer, and
 * a registry name the caller asked for that does not exist is reported rather than ignored.
 */
async function federatedConsumersOf(
  ops: ReadonlyArray<{ file: string; op: Pick<ContractOperation, 'address' | 'method' | 'path' | 'declaredPath' | 'line'> }>,
  /** The declared `servers` hosts of each operation's document, keyed by address. */
  hostsByAddress: ReadonlyMap<string, readonly string[]>,
  input: CertifyServiceContractInput,
  selfPath: string,
  boundaries: string[],
): Promise<{ byAddress: Map<string, FederatedConsumer[]>; census: FederationCensus } | undefined> {
  if (input.federation !== true && !(input.federationRepos?.length)) return undefined;
  const byAddress = new Map<string, FederatedConsumer[]>();
  const census: FederationCensus = { repos: [], partial: [], skipped: [] };
  if (!ops.length) return { byAddress, census };
  const { resolveFederationScope } = await import('../../federation/resolver.js');
  const { evaluateRepoState, canonicalize } = await import('../../federation/registry.js');
  const { sameDeclaredHost, allParameterPath } = await import('../contract/contract-briefing.js');
  const { normalizeUrl } = await import('../../analyzer/http-route-parser.js');
  // The repository directory, not the user's home: `.openlore/federation.json` is repo-relative,
  // and this is what `certify_public_surface`, `find_dead_code`, `find_path` and `select_tests`
  // all pass. Using the home directory would have read a manifest none of them reads.
  const scope = resolveFederationScope(selfPath, { ...(input.federation !== undefined ? { federation: input.federation } : {}), ...(input.federationRepos ? { federationRepos: input.federationRepos } : {}) });
  const skip = (repo: string, reason: string): void => {
    if (census.skipped.length < MAX_FEDERATION_SKIPPED) census.skipped.push({ repo: emittedText(repo), reason: emittedText(reason) });
    else census.skippedOmitted = (census.skippedOmitted ?? 0) + 1;
  };
  for (const name of scope.unknownNames) skip(name, 'not in the federation registry');

  // An all-parameter operation path matches almost any URL of that segment count, so it can
  // attribute neither a handler nor a caller. Excluded from the census and disclosed, exactly as
  // `blast_radius` does for the same shape.
  const generic = ops.filter(({ op }) => allParameterPath(normalizeUrl(op.path)) || allParameterPath(normalizeUrl(op.declaredPath)));
  const censusable = ops.filter(o => !generic.includes(o));
  for (const { op } of generic) {
    boundaries.push(`${op.address} is an all-parameter path, which matches too broadly to attribute a call site, so consumers outside this repository are not assessed for it.`);
  }
  if (!censusable.length) return { byAddress, census };

  // `canonicalize` (realpath), not `resolve`: the registry stores realpath'd paths while a
  // caller-supplied `directory` is only resolved, so on macOS `/tmp` vs `/private/tmp` the
  // repository under certification was censused as its own sibling and its own call sites were
  // re-reported as a sibling's.
  const selfReal = canonicalize(selfPath);
  const seenDirs = new Set<string>();
  for (const entry of scope.repos) {
    const dir = canonicalize(entry.path);
    if (dir === selfReal) continue;
    // Two names for one directory would report every call site twice.
    if (seenDirs.has(dir)) { skip(entry.name, 'another registry entry already names this directory'); continue; }
    seenDirs.add(dir);
    const state = evaluateRepoState(entry);
    if (state !== 'indexed') {
      // A sibling whose index cannot be trusted is DISCLOSED, never counted as consumer-free.
      skip(entry.name, `index ${state}`);
      continue;
    }
    const siblingBoundaries: string[] = [];
    const stats = { capped: false, totals: new Map<string, number>() };
    let sites: Awaited<ReturnType<typeof callSitesFor>>;
    try {
      // `dir`, not `entry.path`: `callSitesFor` relativizes with `startsWith(root)`, so an
      // unnormalized registry path (a `..` segment, a trailing slash) made it serve an absolute
      // local path — or a corrupted one — as the consumer's file.
      sites = await callSitesFor(dir, censusable, siblingBoundaries, stats, true);
    } catch (error) {
      skip(entry.name, `scan failed: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
      continue;
    }
    census.repos.push(emittedText(entry.name));
    // A file cap means this sibling was only PARTLY scanned: "censused and clean" would be a
    // conclusion the scan did not reach.
    if (stats.capped) census.partial.push(emittedText(entry.name));
    for (const b of siblingBoundaries) boundaries.push(`${emittedText(entry.name)}: ${b}`);
    for (const [address, found] of sites) {
      const hosts = hostsByAddress.get(address) ?? [];
      const at = byAddress.get(address) ?? [];
      for (const f of found) {
        // Another vendor on the same path shape is not a consumer. Across repositories this is
        // the normal case, and reporting it put a false accusation in an error finding.
        if (!sameDeclaredHost(f.url ?? '', hosts)) continue;
        // A URL written inside a string literal is documentation or a fixture, not a call.
        if (f.offset !== undefined && f.client === undefined) continue;
        at.push({ repo: emittedText(entry.name), file: emittedText(f.file), line: f.line });
      }
      if (at.length) byAddress.set(address, at);
    }
  }
  return { byAddress, census };
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
  /** Read only these root-relative source files (a diff's), not the whole repository. */
  onlyFiles?: ReadonlySet<string>,
): Promise<Map<string, Array<{ file: string; line: number; method: string; url: string; offset?: number; client?: string }>>> {
  const out = new Map<string, Array<{ file: string; line: number; method: string; url: string; offset?: number; client?: string }>>();
  const { extractHttpCalls, buildHttpEdges, normalizeUrl } = await import('../../analyzer/http-route-parser.js');
  const { mapFilesBounded } = await import('../../analyzer/bounded-file-scan.js');
  const routes = ops.flatMap(({ file, op }) => [...new Set([op.path, op.declaredPath])].map(p => ({
    file, method: op.method, path: p, normalizedPath: normalizeUrl(p), handlerName: op.address,
    framework: 'openapi', line: op.line, contractSource: 'none' as const,
  })));
  const files = onlyFiles ? [...onlyFiles].filter(f => CLIENT_EXT.test(f)).sort(sortStr) : await workingFiles(root, CLIENT_EXT);
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
async function checkPayloads(root: string, docs: readonly ContractDocument[], findings: GovernanceFinding[], boundaries: string[], onlyFiles?: ReadonlySet<string>, onLine?: (file: string, line: number) => boolean): Promise<Record<string, unknown>> {
  const ops = docs.flatMap(d => d.operations.filter(op => op.body?.assessed && op.body.properties.some(p => p.required)).map(op => ({ file: d.file, op })));
  if (!ops.length) return { assessed: false, reason: 'no operation requires request-body properties' };
  const stats = { capped: false, totals: new Map<string, number>() };
  const sites = await callSitesFor(root, ops, [], stats, true, onlyFiles);
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
      if (onlyFiles && !onlyFiles.has(site.file)) continue;
      if (onLine && !onLine(site.file, site.line)) continue; // not a line the diff added or changed
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
          location: { path: emittedText(site.file), line: site.line } });
        continue;
      }
      if (body.kind === 'not-literal') { notAssessed.push({ file: site.file, line: site.line, operation: emittedText(address), reason: body.reason }); continue; }
      const missing = required.filter(k => !body.keys.includes(k));
      if (!missing.length) { conforming++; continue; }
      findings.push({ code: 'contract-payload-missing-required', severity: 'warning', source: 'service-contract', subject: emittedText(`${site.file}:${site.line}`),
        discriminator: address, message: emittedText(`${site.file}:${site.line} calls ${address} without required body propert${missing.length === 1 ? 'y' : 'ies'} ${missing.join(', ')} (${o.file}:${o.op.line}).`),
        location: { path: emittedText(site.file), line: site.line } });
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

/**
 * The payload check for call sites in `files` (root-relative), for `verify_change`: the same rule as
 * `certify_service_contract`'s `payload`, reading only those files, and, with `onLine`, only call
 * sites on the lines a diff added or changed.
 */
export async function payloadFindingsForFiles(root: string, files: readonly string[], onLine?: (file: string, line: number) => boolean): Promise<{ findings: GovernanceFinding[]; boundaries: string[]; notAssessed: number }> {
  const findings: GovernanceFinding[] = [];
  const boundaries: string[] = [];
  if (!files.length) return { findings, boundaries, notAssessed: 0 };
  const side = await headSpecsCached(root);
  if (side.capped) boundaries.push('The specification scan reached its cap; request bodies were checked against the specifications found.');
  if (!side.docs.length) return { findings, boundaries, notAssessed: 0 };
  const r = await checkPayloads(root, side.docs, findings, boundaries, new Set(files), onLine);
  return { findings, boundaries, notAssessed: typeof r.notAssessed === 'number' ? r.notAssessed : 0 };
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
  if (head.proto.capped) boundaries.push(`Past the protobuf cap (${MAX_PROTO_FILES} files), ${head.proto.candidates.size - head.proto.examined.size} .proto file(s) were not read.`);
  if (head.proto.unread.length) boundaries.push(`${head.proto.unread.length} .proto file(s) could not be read (over ${MAX_SPEC_BYTES / 1024 / 1024} MB, a link out of the repository, or an I/O error), so their schemas are not assessed.`);
  if (head.graphql.capped) boundaries.push(`Past the GraphQL cap (${MAX_GRAPHQL_FILES} schema files, ${MAX_CANDIDATES} files read), ${head.graphql.candidates.size - head.graphql.examined.size} GraphQL file(s) were not read.`);
  {
    // Graded all the same — never dropped on a config's say-so — but named, so a frontend reading
    // these as its own breaking changes knows they may be a vendor's schema.
    const relay = [...await clientSchemas(root)].filter(f => head.graphql.candidates.has(f));
    if (relay.length) boundaries.push(emittedText(`${relay.join(', ')} ${relay.length === 1 ? 'is' : 'are'} named by a Relay compiler config: possibly a copy of another service's schema, graded here as this repository's.`));
  }
  if (head.graphql.unread.length) boundaries.push(`${head.graphql.unread.length} GraphQL file(s) could not be read, so their schemas are not assessed.`);
  const notAssessed = [...head.unreadable, ...head.proto.unreadable, ...head.graphql.unreadable].map(u => ({ file: emittedText(u.file), reason: emittedText(u.reason) }));
  // Bounded and screened: a file can name thousands of distinct directives.
  for (const d of [...head.docs, ...head.proto.docs, ...head.graphql.docs]) {
    if (d.unassessed.length) notAssessed.push({ file: emittedText(d.file), reason: emittedText(`outside the model: ${d.unassessed.slice(0, 12).join(', ')}${d.unassessed.length > 12 ? ` and ${d.unassessed.length - 12} more` : ''}`) });
  }

  const findings: GovernanceFinding[] = [];
  const specs: Array<Record<string, unknown>> = [
    ...head.docs.map(d => ({ file: emittedText(d.file), format: d.format, basePath: d.basePath || '/', operations: d.operations.length })),
    ...head.proto.docs.map(d => ({
      file: emittedText(d.file), format: d.format, ...(d.package ? { package: emittedText(d.package) } : {}),
      operations: d.services.reduce((n, s) => n + s.rpcs.length, 0), types: d.messages.length + d.enums.length,
    })),
    ...(() => {
      const roots = new Set(Object.values(mergeGraphqlSchema(head.graphql.docs).roots));
      return head.graphql.docs.map(d => ({
        file: emittedText(d.file), format: d.format,
        // The root fields this file declares or adds by `extend`: its operations.
        operations: d.types.filter(t => roots.has(t.name)).reduce((n, t) => n + t.fields.length, 0),
        types: d.types.filter(t => !t.extension && !roots.has(t.name)).length,
      }));
    })(),
  ];
  {
    // What the merged GraphQL schema could not settle is named, not left to the analyze notes.
    const merged = mergeGraphqlSchema(head.graphql.docs);
    for (const a of merged.ambiguous.slice(0, limit)) notAssessed.push({ file: emittedText(a.files[0]), reason: emittedText(`GraphQL type ${a.name} is defined in more than one file (${a.files.slice(0, 3).join(', ')}), so nothing binds to it`) });
    for (const c of merged.conflicts.slice(0, limit)) notAssessed.push({ file: '(graphql schema)', reason: emittedText(c) });
  }
  if (head.graphql.clientDocuments.length) {
    // One entry, not one per file: a frontend holds hundreds of query documents.
    const docs = head.graphql.clientDocuments;
    notAssessed.push({ file: emittedText(docs[0]), reason: emittedText(`${docs.length} GraphQL client document(s) (operations and fragments) are not schemas${docs.length > 1 ? `: ${docs.slice(0, 3).join(', ')}${docs.length > 3 ? ', …' : ''}` : ''}`) });
  }

  // ── Parity against the indexed route handlers ──
  const routes = await indexedRoutes(root);
  let parity: Record<string, unknown>;
  if (!head.docs.length) {
    parity = { assessed: false, reason: head.proto.docs.length || head.graphql.docs.length
      ? 'no OpenAPI or Swagger document was found; protobuf RPCs and GraphQL operations are bound to their implementation in the graph (server registrations, resolver maps), not compared with routes'
      : 'no OpenAPI or Swagger document was found' };
  }
  else if (!routes) parity = { assessed: false, reason: 'no route inventory: run `openlore analyze` first' };
  else if (!routes.length) parity = { assessed: false, reason: 'no server route handler is indexed in this repository (the specification may describe another service)' };
  else {
    const p = contractParity(head.docs, routes);
    for (const u of p.declaredUnimplemented) {
      findings.push({ code: 'contract-declared-unimplemented', severity: 'warning', source: 'service-contract', subject: emittedText(u.address),
        message: emittedText(`${u.address} is declared in ${u.file}:${u.line} but no indexed route handler serves it.`),
        location: { path: emittedText(u.file), line: u.line } });
    }
    for (const u of p.implementedUndeclared) {
      const subject = `${u.file}::${u.method} ${u.path}`;
      findings.push({ code: 'contract-implemented-undeclared', severity: 'warning', source: 'service-contract', subject: emittedText(subject),
        message: emittedText(`${u.method} ${u.path} (in ${u.file}) is under a path the specification covers, but the specification does not declare it.`),
        location: { path: emittedText(u.file) } });
    }
    if (p.dynamic) boundaries.push(`${p.dynamic} route handler(s) with a dynamic path were not compared with the specifications.`);
    parity = { assessed: true, matched: p.matched, declaredUnimplemented: p.declaredUnimplemented.length, implementedUndeclared: p.implementedUndeclared.length };
  }

  // ── Literal request bodies against the required properties (add-contract-graph-projection) ──
  const payload = await checkPayloads(root, head.docs, findings, boundaries).catch(e => ({ assessed: false, reason: e instanceof Error ? e.message.split('\n')[0] : String(e) }));

  // ── Breaking-change verdicts against the merge-base ──
  let changesOut: Record<string, unknown> | undefined;
  /** Which sibling repositories were censused for consumers, and which were not. Run-level. */
  let federationCensus: FederationCensus | undefined;
  /** Every federated consumer, flat and address-tagged: one trimmable top-level list. */
  const federatedConsumers: Array<FederatedConsumer & { address: string }> = [];
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
    for (const u of [...base.unreadable, ...base.proto.unreadable, ...base.graphql.unreadable]) notAssessed.push({ file: emittedText(u.file), reason: `at the base revision: ${emittedText(u.reason)}` });
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
    /** Specification files present on a side but not compared, for the bump below. */
    const notCompared = new Set<string>([...head.unreadable, ...base.unreadable].map(u => u.file));
    for (const u of [...head.unread, ...base.unread]) {
      if (!docFiles.has(u.file)) continue;
      notCompared.add(u.file);
      notAssessed.push({ file: emittedText(u.file), reason: emittedText(`unread on one side: ${u.reason}`) });
    }
    for (const f of docFiles) {
      if (unparsed.has(f) || comparable(f)) continue;
      notCompared.add(f);
      notAssessed.push({ file: emittedText(f), reason: lostSpec(f) ? 'reads as a specification on one side only, so it is not compared' : 'past the scan cap on one side, so it is not compared' });
    }
    // Protobuf has its own scan scope, so its comparability is its own: every `.proto` file is a
    // schema, so there is no "a specification on one side only" case.
    const protoUnparsed = new Set([...head.proto.unreadable, ...base.proto.unreadable, ...head.proto.unread, ...base.proto.unread].map(u => u.file));
    const protoComparable = (file: string) => !protoUnparsed.has(file)
      && (head.proto.examined.has(file) || !head.proto.candidates.has(file)) && (base.proto.examined.has(file) || !base.proto.candidates.has(file));
    for (const u of [...head.proto.unread, ...base.proto.unread]) notAssessed.push({ file: emittedText(u.file), reason: emittedText(`unread on one side: ${u.reason}`) });
    for (const f of protoUnparsed) notCompared.add(f);
    // Every `.proto` file is a schema, so one past the cap on either side is one no rule saw.
    for (const side of [head.proto, base.proto]) for (const f of side.candidates) if (!side.examined.has(f)) notCompared.add(f);
    for (const f of new Set([...head.proto.docs, ...base.proto.docs].map(d => d.file))) {
      if (protoUnparsed.has(f) || protoComparable(f)) continue;
      notCompared.add(f);
      notAssessed.push({ file: emittedText(f), reason: 'past the protobuf cap on one side, so it is not compared' });
    }
    if (base.proto.capped && !head.proto.capped) boundaries.push('At the base revision, .proto files past the protobuf cap were not read.');
    // GraphQL: its own scope. One schema per revision, merged from every COMPARABLE file; a schema
    // file that is unread, unparseable, or past the cap on either side is one no rule saw.
    const gqlUnparsed = new Set([...head.graphql.unreadable, ...base.graphql.unreadable, ...head.graphql.unread, ...base.graphql.unread].map(u => u.file));
    const gqlComparable = (file: string) => !gqlUnparsed.has(file)
      && (head.graphql.examined.has(file) || !head.graphql.candidates.has(file)) && (base.graphql.examined.has(file) || !base.graphql.candidates.has(file));
    for (const u of [...head.graphql.unread, ...base.graphql.unread]) notAssessed.push({ file: emittedText(u.file), reason: emittedText(`unread on one side: ${u.reason}`) });
    for (const f of gqlUnparsed) notCompared.add(f);
    for (const side of [head.graphql, base.graphql]) for (const f of side.candidates) if (!side.examined.has(f)) notCompared.add(f);
    if (base.graphql.capped && !head.graphql.capped) boundaries.push('At the base revision, GraphQL files past the GraphQL cap were not read.');
    // With a cap reached, an operation missing on the capped side may only have moved past the cap.
    const removedRule = new Set(['operation-removed', 'rpc-removed', 'type-removed']);
    const addedRule = new Set(['operation-added', 'rpc-added', 'type-added']);
    // Each format's own cap: a protobuf cap says nothing about where an OpenAPI operation went.
    const cappedBy = (headCapped: boolean, baseCapped: boolean) => (c: ContractChange): ContractChange =>
      (removedRule.has(c.rule) && headCapped) || (addedRule.has(c.rule) && baseCapped)
        ? { ...c, rule: 'schema-unassessed' as const, class: 'potentially-breaking' as const, detail: `${c.detail} (a scan cap was reached, so it may only have moved)` }
        : c;
    const httpChanges = diffContracts(base.docs.filter(d => comparable(d.file)), head.docs.filter(d => comparable(d.file))).map(cappedBy(head.capped, base.capped));
    // Protobuf (change: add-contract-graph-projection): its own rules, and no consumer join —
    // a gRPC client call names no method and path, so the HTTP call-site census cannot find it.
    // GraphQL is one schema merged from every file, so a side with a schema file it could not read
    // may hold what moved there: a removal at an incomplete head (or an addition over an incomplete
    // base) is not known to be one. Protobuf resolves through imports and keeps the cap-only rule —
    // a vendored proto2 file beside it is common and hides nothing.
    const incomplete = (scope: ScanScopeLike) => scope.capped || scope.unreadable.length > 0 || scope.unread.length > 0;
    const protoChanges = diffProtobuf(base.proto.docs.filter(d => protoComparable(d.file)), head.proto.docs.filter(d => protoComparable(d.file))).map(cappedBy(head.proto.capped, base.proto.capped));
    if (protoChanges.some(c => c.class === 'breaking' || c.class === 'dangerous')) {
      boundaries.push('gRPC client call sites are not read, so a breaking protobuf change names no consumer, in this repository or another.');
    }
    const gqlDocsOf = (side: SpecSide) => side.graphql.docs.filter(d => gqlComparable(d.file));
    const graphqlChanges = (head.graphql.docs.length || base.graphql.docs.length)
      ? diffGraphql(mergeGraphqlSchema(gqlDocsOf(base)), mergeGraphqlSchema(gqlDocsOf(head))).map(cappedBy(incomplete(head.graphql), incomplete(base.graphql)))
      : [];
    if (graphqlChanges.some(c => c.class === 'breaking' || c.class === 'dangerous')) {
      boundaries.push('GraphQL client operations are not read, so a breaking GraphQL change names no consumer, in this repository or another.');
    }
    /** Which non-HTTP format each change is, by identity — two formats may share an address. */
    const formatOf = new Map<ContractChange, 'gRPC' | 'GraphQL'>([
      ...protoChanges.map(c => [c, 'gRPC'] as const), ...graphqlChanges.map(c => [c, 'GraphQL'] as const),
    ]);
    const changes = [...httpChanges, ...protoChanges, ...graphqlChanges];
    // A specification that changed but could not be compared (proto2, a parse error, a cap) holds
    // changes no rule saw, so no bump is proven. One that did not change hides nothing.
    let uncomparedChanged = 0;
    if (notCompared.size) {
      const onBothSides = (f: string) => (base.candidates.has(f) || base.proto.candidates.has(f) || base.graphql.candidates.has(f))
        && (head.candidates.has(f) || head.proto.candidates.has(f) || head.graphql.candidates.has(f));
      // One listing of every change since the base, intersected here: no pathspec to batch, quote,
      // or misread (`:x.yaml` is magic to git).
      let diffed: Set<string> | undefined;
      try {
        diffed = new Set((await git(root, gitPathArgs('diff', '--relative', '--name-only', '-z', commit))).split('\0').filter(Boolean));
      } catch { /* unknown: every one counts as changed */ }
      uncomparedChanged = [...notCompared].filter(f => !diffed || !onBothSides(f) || diffed.has(f)).length;
    }
    const consumers = await consumersOf(root, httpChanges, [...head.docs, ...base.docs], boundaries);
    await attachReachingTests(root, consumers, boundaries);
    // A service's consumers are usually in OTHER repositories, so "no caller in this repository"
    // is the least informative thing to say about the change most worth stopping.
    // Scoped to the addresses the in-repo join already covers — breaking and dangerous only.
    // Censusing every changed address reported federated consumers for added and non-breaking
    // operations too, which no finding asks about.
    const censusAddresses = new Set(changes.filter(c => c.class === 'breaking' || c.class === 'dangerous').map(c => c.address));
    const hostsByAddress = new Map<string, readonly string[]>();
    const opsForFederation: Array<{ file: string; op: ContractOperation }> = [];
    for (const d of [...head.docs, ...base.docs]) {
      for (const op of d.operations) {
        if (!censusAddresses.has(op.address) || hostsByAddress.has(op.address)) continue;
        hostsByAddress.set(op.address, d.serverHosts);
        opsForFederation.push({ file: d.file, op });
      }
    }
    const anyHostless = [...hostsByAddress.values()].some(h => !h.length);
    const federated = await federatedConsumersOf(opsForFederation, hostsByAddress, input, root, boundaries)
      // A present-but-corrupt registry throws on purpose, so a typo never degrades to "no
      // federation". Swallowing it told the caller to pass the flag they had just passed.
      .catch((error: unknown): { byAddress: Map<string, FederatedConsumer[]>; census: FederationCensus } => ({
        byAddress: new Map<string, FederatedConsumer[]>(),
        census: {
          repos: [], partial: [],
          skipped: [{ repo: '(registry)', reason: emittedText(`federation registry could not be read: ${String(error instanceof Error ? error.message : error).split('\n')[0]}`) }],
        },
      }));
    federationCensus = federated?.census;
    if (federated) {
      for (const [address, found] of federated.byAddress) {
        for (const f of found) federatedConsumers.push({ address: emittedText(address), ...f });
      }
      federatedConsumers.sort((a, b) => sortStr(a.address, b.address) || sortStr(a.repo, b.repo) || sortStr(a.file, b.file) || a.line - b.line);
    }
    if (federated && anyHostless) {
      boundaries.push('A changed specification declares no `servers` host, so a sibling call site matched only by path may belong to another service.');
    }
    for (const c of changes.filter(x => x.class === 'breaking' || x.class === 'dangerous')) {
      const who = consumers.get(c.address) ?? [];
      const across = federated?.byAddress.get(c.address) ?? [];
      const subject = `${c.address}${c.element ? ` ${c.element}` : ''}`;
      const format = formatOf.get(c);
      if (format) {
        findings.push({
          code: 'contract-breaking', severity: c.class === 'breaking' ? 'error' : 'warning', source: 'service-contract', subject: emittedText(subject),
          discriminator: c.rule, message: emittedText(`${c.detail} (${c.rule}, ${c.class}); ${format} consumers are not assessed.`),
          location: { path: emittedText(c.file), line: c.line },
        });
        continue;
      }
      // Three distinct states, never collapsed: called here, called elsewhere, or not called in
      // anything censused — and the last one names what was censused so it is not read as "safe".
      const where = who.length
        ? `; called from ${who.slice(0, 3).map(w => `${w.file}:${w.line}`).join(', ')}${who.length > 3 ? ` and ${who.length - 3} more` : ''}`
        : across.length
          ? `; no caller in this repository, but called from ${across.slice(0, 3).map(w => `${w.repo}:${w.file}:${w.line}`).join(', ')}${across.length > 3 ? ` and ${across.length - 3} more` : ''}`
          : federated
            // Never "censused and clean" without saying how complete the census was: a sibling
            // whose scan hit a file cap was only partly read, and one that was skipped was not
            // read at all.
            ? `; no caller in this repository or in ${federated.census.repos.length} censused sibling repositor${federated.census.repos.length === 1 ? 'y' : 'ies'}`
              + `${federated.census.partial.length ? ` (${federated.census.partial.length} only partly scanned)` : ''}`
              + `${federated.census.skipped.length ? `, with ${federated.census.skipped.length} not censused` : ''}`
            : '; no caller in this repository';
      findings.push({
        code: 'contract-breaking', severity: c.class === 'breaking' ? 'error' : 'warning', source: 'service-contract', subject: emittedText(subject),
        discriminator: c.rule, message: emittedText(`${c.detail} (${c.rule}, ${c.class})${where}.`),
        location: { path: emittedText(c.file), line: c.line },
      });
    }
    if (federated) {
      for (const s of federated.census.skipped) {
        boundaries.push(`Sibling repository ${s.repo} was not censused for consumers (${s.reason}), so a caller there is not counted.`);
      }
      if (federated.census.skippedOmitted) {
        boundaries.push(`${federated.census.skippedOmitted} further sibling repositor${federated.census.skippedOmitted === 1 ? 'y was' : 'ies were'} not censused and not listed.`);
      }
      for (const r of federated.census.partial) {
        boundaries.push(`Sibling repository ${r} was only partly scanned (a file cap was reached), so it is not evidence that nothing there calls these operations.`);
      }
      if (!federated.census.repos.length) {
        boundaries.push('No sibling repository was censused, so a consumer outside this repository is not assessed.');
      }
    } else if (httpChanges.length) {
      boundaries.push('Consumers outside this repository are not assessed; pass `federation: true` to census indexed sibling repositories.');
    }
    changesOut = {
      baseRef: input.baseRef, resolvedBaseRef: res.resolved, ...(res.fellBack ? { baseRefFallback: { requested: res.requested, resolved: res.resolved } } : {}),
      total: changes.length,
      items: changes.slice(0, limit).map(c => ({
        ...c, file: emittedText(c.file), address: emittedText(c.address), detail: emittedText(c.detail),
        ...(c.element ? { element: emittedText(c.element) } : {}),
        // A protobuf change names no consumer list at all: gRPC call sites are not read, and an
        // empty list would read as "no callers".
        ...(formatOf.has(c) ? { consumersNotAssessed: formatOf.get(c) === 'gRPC' ? 'gRPC client call sites are not read' : 'GraphQL client operations are not read' } : { consumers: consumers.get(c.address) ?? [] }),
        // A COUNT here, and the sites themselves in one top-level list below. Nesting them per
        // item put 25-per-sibling inside `changes.items`, which the response trimmer cannot
        // reach into (it shrinks top-level arrays only) — so at the default `maxResults` a
        // 200-operation change blew the byte budget and the agent received a cut JSON string
        // instead of the verdict, findings and census.
        ...(federated?.byAddress.get(c.address)?.length
          ? { federatedConsumerCount: federated.byAddress.get(c.address)!.length }
          : {}),
      })),
      ...(changes.length > limit ? { omitted: changes.length - limit } : {}),
      suggestedBump: uncomparedChanged ? null : contractBump(changes),
      ...(uncomparedChanged
        ? { suggestedBumpWithheld: `${uncomparedChanged} changed specification file(s) could not be compared, so compatibility is not proven` }
        : contractBump(changes) === null ? { suggestedBumpWithheld: 'a change is outside the model, so compatibility is not proven' } : {}),
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
    surface: [
      ...head.docs.flatMap(d => d.operations.map(o => ({ file: emittedText(d.file), address: emittedText(o.address), line: o.line, ...(o.operationId ? { operationId: emittedText(o.operationId) } : {}), ...(o.deprecated ? { deprecated: true } : {}) }))),
      ...head.proto.docs.flatMap(d => d.services.flatMap(s => s.rpcs.map(r => ({ file: emittedText(d.file), address: emittedText(r.address), line: r.line, ...(r.deprecated ? { deprecated: true } : {}) })))),
      ...(() => {
        const schema = mergeGraphqlSchema(head.graphql.docs);
        return (['query', 'mutation', 'subscription'] as const).flatMap(kind => {
          const root = schema.types.get(schema.roots[kind] ?? "");
          return (root?.fields ?? []).map(f => ({ file: emittedText(f.file ?? root!.file), address: emittedText(`${root!.name}.${f.name}`), line: f.line, ...(f.deprecated ? { deprecated: true } : {}) }));
        });
      })(),
    ].slice(0, limit),
    parity,
    payload,
    ...(changesOut ? { changes: changesOut } : {}),
    ...(federationCensus ? { federationCensus } : {}),
    // One flat top-level list, so the response trimmer can shrink it and keep the verdict.
    ...(federatedConsumers.length
      ? {
        federatedConsumers: federatedConsumers.slice(0, MAX_FEDERATED_CONSUMERS),
        ...(federatedConsumers.length > MAX_FEDERATED_CONSUMERS
          ? { federatedConsumersOmitted: federatedConsumers.length - MAX_FEDERATED_CONSUMERS }
          : {}),
      }
      : {}),
    findings: shown,
    ...(kept.length > shown.length ? { findingsOmitted: kept.length - shown.length } : {}),
    gated: gate.gated,
    ...(notAssessed.length ? { notAssessed: [...new Map(notAssessed.map(n => [`${n.file}\0${n.reason}`, n])).values()].sort((a, b) => sortStr(a.file, b.file)) } : {}),
    ...(boundaries.length ? { boundaries } : {}),
    note: 'OpenAPI 3.x, Swagger 2.0, protobuf v3, and GraphQL SDL. Advisory: nothing blocks unless enforcement.policy says so.',
  };
}
