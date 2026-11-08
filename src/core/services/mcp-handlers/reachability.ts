/**
 * Reachability & Dead-Code Analysis (spec-20) — cross-language mark-and-sweep
 * over the unified call graph.
 *
 * "Is this reachable from any entry point?", "what is dead?", and "what becomes
 * dead if I delete X?" — graph reachability questions grep can't answer (it sees
 * text, not reach) and the model burns tokens guessing at. Reachability is forward
 * BFS from roots; candidate-dead is the unreached remainder; "dead if I delete X"
 * is the set reachable only through X.
 *
 * Prior art: knip / ts-prune do mark-and-sweep, but TS/JS-only. This is the
 * cross-language version over the tree-sitter graph (15+ languages).
 *
 * HONEST LIMITS — output is *candidates*, never deletion authority. Callback /
 * event-channel and route→handler dispatch is now PARTIALLY recovered via
 * synthesized edges (single-language, statically-paired registration+dispatch;
 * spec: add-synthesized-dynamic-dispatch-edges), and polymorphic dispatch through
 * inheritance/interfaces is recovered via Class Hierarchy Analysis (name+arity,
 * declared-type-narrowed where the receiver type is statically recoverable; spec:
 * add-type-hierarchy-resolved-dispatch). A symbol reachable only through such an
 * edge is no longer reported as high-confidence dead. What remains a blind spot:
 * reflection, computed/string-built dispatch (`obj[name]()`), cross-language
 * bridges and cross-language polymorphism, DI/plugin registries with no
 * statically-visible binding, contract wiring the projection refused to bind (a
 * gRPC registration or GraphQL resolver map whose implementation could not be
 * pinned — capped below `high` where the refusal names the symbol, its class or
 * its file; a refusal naming none of those, and a registration style the scan
 * does not read at all, remain uncovered), RTA/VTA-level pruning of the CHA
 * name+arity over-approximation, and externally-consumed public exports — these can still
 * produce false "dead" positives. Roots include tests, imported symbols, files a config invokes, and
 * detected framework entries; every candidate carries a confidence level and a
 * reason; nothing is ever auto-deleted. Pass `directResolvedOnly` to ignore
 * synthesized edges and get the strict directly-resolved reachability instead.
 */

import { emittedText, classifyGeneratedFiles, type GeneratedFileFact } from '../generated-file-guard.js';
import { loadRouteInventoryRoots, routeHandlerReason, type RouteInventoryRoots } from './route-inventory-roots.js';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import { resolveFederationScope, findCrossRepoConsumersBatch } from '../../federation/resolver.js';
import { loadTraversalIndex } from './traversal.js';
import { assembleBoundary, computeStaleness, edgeBasisWithinSet, withheldOnPartialIndex, type KnownUnknowableCrossing } from './confidence-boundary.js';
import { loadParseHealthReport, parseHealthBoundary } from './parse-health-boundary.js';
import {
  loadDynamicBoundaryReport,
  dynamicBoundaryCrossing,
  buildQualifier,
  qualificationReason,
} from './dynamic-boundary-disclosure.js';
import { isProjectedLanguage } from '../../analyzer/projected-language.js';
import { collectExternalWiring, type ExternalWiringReport, type WiringReceipt } from '../../analyzer/entry-point-adapters.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH } from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

export interface FindDeadCodeInput {
  directory: string;
  /** "What becomes dead if I delete this symbol?" — switches to delete-impact mode. */
  ifDeleted?: string;
  /** Limit candidate-dead results (default 100). */
  maxResults?: number;
  /** Only report candidates whose file path contains this substring. */
  filePattern?: string;
  /**
   * Restrict reachability to directly-resolved edges only: synthesized
   * dynamic-dispatch edges are not traversed (spec: add-synthesized-dynamic-dispatch-edges).
   * Trades completeness for certainty — a symbol reachable only through a
   * synthesized edge is then treated as unreached. Default false.
   */
  directResolvedOnly?: boolean;
  /**
   * Opt in to federation scope: a symbol with no consumer in THIS repo may still
   * be live across the fleet. When set, candidates consumed by another indexed
   * repo are pulled out of candidate-dead and reported as live-via-federation.
   * (change: add-multi-repo-federation)
   */
  federation?: boolean;
  /** Restrict the federation scope to these registry repo names (default: all). */
  federationRepos?: string[];
}

type Confidence = 'high' | 'medium' | 'low';

// Languages where export is explicit and dispatch mostly static — deadness is
// more reliable. Dynamic languages (implicit exports, runtime dispatch) cap low.
const STATIC_LANGS = new Set([
  'TypeScript', 'JavaScript', 'Go', 'Rust', 'Java', 'Kotlin', 'C#', 'Swift', 'C++', 'C', 'Scala', 'Dart',
]);
const DYNAMIC_LANGS = new Set(['Python', 'Ruby', 'PHP', 'Lua', 'Elixir', 'Bash']);

/**
 * Repository files some config invokes (change: add-framework-entry-point-adapters), keyed by their
 * repo-relative path. Every function in such a file is a liveness root: the call graph has no node for
 * module-scope code, so what a wired file runs at load time cannot be told apart from its helpers —
 * and the roots doctrine prefers false-live over false-dead.
 */
export async function loadExternalWiring(absDir: string): Promise<{ report: ExternalWiringReport; byFile: Map<string, WiringReceipt[]> }> {
  const report = await collectExternalWiring(absDir)
    .catch((): ExternalWiringReport => ({ wired: [], boundaries: [], boundariesOmitted: 0 }));
  return { report, byFile: new Map(report.wired.map(w => [w.file, w.receipts])) };
}

/** Caveats every conclusion resting on config-wired roots carries. */
export function externalWiringCaveats(report: ExternalWiringReport): string[] {
  const caveats = [
    'Config wiring is read from the package.json of the repository root and of each DECLARED workspace member (bin, main, module, exports, scripts, jest), tsconfig.json files, vitest/vite/jest setup files, and POSIX-shell .github/workflows run steps. A manifest outside the declared workspace set, framework routing conventions, and other config formats are not read, so code wired only there can appear dead.',
  ];
  if (report.wired.length > 0) {
    caveats.push('Every function in a file a config invokes is treated as live, because module-scope code has no call-graph node; unused helpers in such a file are not flagged.');
  }
  const unresolved = report.boundaries.length + report.boundariesOmitted;
  if (unresolved > 0) {
    caveats.push(`${unresolved} config reference(s) could not be resolved to a repository file (dynamic, unsupported, missing, outside the repository, or an unreadable config; see externalWiring.boundaries) — code they would wire can appear dead.`);
  }
  return caveats;
}

/** A path's directory, trailing slash kept, for the one proven class scope. */
function dirOf(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf('/') + 1);
}

/** A graph file path in the adapters' repo-relative spelling. */
export function wiringKey(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** A code node we can reason about (not external, not infrastructure). */
function isCodeNode(n: FunctionNode): boolean {
  return !n.isExternal && !isProjectedLanguage(n.language);
}

/**
 * A TypeScript ambient declaration file (change: root-framework-routes).
 *
 * Every function-shaped thing in a `.d.ts` is a BODYLESS type declaration
 * (`public static create(properties?: ITrace): Trace;`) — there is no code there to
 * be dead, so calling it dead is a category error, not a false negative. The
 * extractor still makes a node for it (another agent owns that walk, and the node is
 * useful for signatures and the public surface); this is the narrowest predicate that
 * keeps such a node out of a deadness verdict, and it is deliberately file-shaped
 * rather than body-shaped so it needs nothing the graph does not already carry.
 */
function isAmbientDeclarationFile(filePath: string): boolean {
  return /\.d\.(ts|mts|cts)$/i.test(filePath.replaceAll('\\', '/'));
}

/** A graph file path in the generated-file guard's own key spelling. */
function generatedKey(filePath: string): string {
  return posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\/+/, '').replace(/^\/+/, '');
}

/** Distinct candidate files classified against the generated-file guard, at most. */
const MAX_GENERATED_CLASSIFIED = 5_000;

/**
 * Classify the candidates' own files against the generated-file guard (change:
 * root-framework-routes). A generated file's symbols are driven by whatever generated
 * them — protobuf reflection, Go struct embedding, a runtime registry — never by a
 * direct in-repo call, so a `high` verdict over them carries no signal. They stay
 * candidates (that is the honest answer: nothing here proves a caller), but the
 * confidence is capped and the rule that capped it is named.
 */
async function generatedFactsForCandidates(absDir: string, files: readonly string[]): Promise<{
  facts: Map<string, GeneratedFileFact>; boundaries: string[];
}> {
  const distinct = [...new Set(files)].sort();
  const capped = distinct.length > MAX_GENERATED_CLASSIFIED;
  const { facts, boundaries } = await classifyGeneratedFiles(absDir, distinct.slice(0, MAX_GENERATED_CLASSIFIED))
    .catch(() => ({ facts: new Map<string, GeneratedFileFact>(), boundaries: ['The generated-file guard could not run, so a generated file\'s symbols may be rated as if hand-written.'] }));
  if (capped) {
    boundaries.push(`Candidates span ${distinct.length} files; only the first ${MAX_GENERATED_CLASSIFIED} were classified against the generated-file guard, so a generated file past that point may be rated as if hand-written.`);
  }
  return { facts, boundaries };
}

/**
 * Node-ids invoked by something OUTSIDE the call graph — they are liveness roots,
 * not dead code. Always includes cross-language HTTP handlers (`http_endpoint`
 * edges). When `includeSynthesizedRoutes` is set (default reachability, not strict
 * mode), also includes targets of synthesized `route-handler` edges: a framework
 * invokes a route handler regardless of whether its registration site is itself
 * reached, so a top-level/unenclosed route still keeps its handler live.
 */
function externallyInvokedHandlerIds(cg: SerializedCallGraph, includeSynthesizedRoutes = true): Set<string> {
  const ids = new Set<string>();
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    if (e.confidence === 'http_endpoint') ids.add(e.calleeId);
    // A function a resource deploys (a Lambda handler) is invoked from outside the code (add-iac-deploy-binding).
    else if (e.kind === 'deploys_symbol') ids.add(e.calleeId);
    // A handler that serves a DECLARED operation is invoked by whoever calls that endpoint, in
    // this repository or outside it (change: add-contract-node-projection). The edge runs
    // handler → operation, so the handler is the CALLER side.
    else if (e.kind === 'implements_endpoint') ids.add(e.callerId);
    else if (includeSynthesizedRoutes && e.confidence === 'synthesized' && e.synthesizedBy === 'route-handler') {
      ids.add(e.calleeId);
    }
  }
  return ids;
}

interface DepSignals {
  /** Symbol names imported by name somewhere (`import { X }`). */
  names: Set<string>;
  /** Repo-relative file paths of modules imported anywhere — a broader "module is
   *  used" signal that catches namespace/default/re-export usage named-import
   *  detection misses. A symbol in a consumed module can't be high-confidence dead. */
  files: Set<string>;
  /**
   * Forward import adjacency, repo-relative path → the paths it imports. Used to compute the set of
   * files that can NAME a candidate's module (change: disclose-dynamic-boundary-regions), which is
   * what keeps a dynamic-boundary qualification scoped to the candidate's own reachable
   * neighbourhood instead of the whole repository.
   */
  imports: Map<string, string[]>;
}

/** Load the cross-file import signals from the dependency graph. */
async function loadDepSignals(absDir: string): Promise<DepSignals | null> {
  try {
    const raw = await readFile(join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8');
    const g = JSON.parse(raw) as {
      nodes?: Array<{ id: string; file?: { path?: string } }>;
      edges?: Array<{ source?: string; target?: string; importedNames?: string[] }>;
    };
    const names = new Set<string>();
    const idToPath = new Map((g.nodes ?? []).map(n => [n.id, n.file?.path ?? '']));
    const files = new Set<string>();
    const imports = new Map<string, string[]>();
    for (const e of g.edges ?? []) {
      for (const n of e.importedNames ?? []) names.add(n);
      const path = e.target ? idToPath.get(e.target) : undefined;
      if (path) files.add(path);
      const from = e.source ? idToPath.get(e.source) : undefined;
      if (from && path) {
        const list = imports.get(from);
        if (list) list.push(path);
        else imports.set(from, [path]);
      }
    }
    return { names, files, imports };
  } catch {
    return null;
  }
}

/** A candidate's module is imported somewhere → tolerant path match against the dep-graph file set. */
function fileImported(filePath: string, importedFiles: Set<string>): boolean {
  if (importedFiles.has(filePath)) return true;
  const a = filePath.replace(/^\/+/, '');
  for (const f of importedFiles) {
    const b = f.replace(/^\/+/, '');
    if (a === b || a.endsWith('/' + b) || b.endsWith('/' + a)) return true;
  }
  return false;
}

/**
 * What a contract registration or resolver map NAMED and the projection REFUSED to bind
 * (change: cap-unbound-contract-handler-confidence).
 *
 * A handler bound to a declared operation is a liveness root; a refused binding roots nothing. So a
 * gRPC `RegisterOrderServiceServer` call or a GraphQL resolver map can name a function literally
 * and that function still reach no root — it looks dead while its wiring is sitting in the source.
 * `find_dead_code` reads this to keep such a symbol out of its HIGH-confidence verdicts, exactly as
 * it does for a node named by an unresolved-ambiguous call site.
 *
 * The buckets, and the bucket RULE, belong to the producer ({@link unboundHandlerNames}): they are
 * computed over the COMPLETE refusal list, because `unresolvedRegistrations.items` is bounded for a
 * READER and a reader's cap must not decide a correctness question. An artifact written before that
 * field existed is read back from the bounded items instead, and then — and only then — the missing
 * remainder forces a repository-wide ceiling: `legacyTruncated` counts the refusals whose names the
 * artifact cannot carry, and no candidate in such a repository is rated high-confidence dead.
 *
 * OpenAPI `unresolvedBindings` are NOT read here: that disclosure names no symbol (the one name on
 * a route, `handlerName`, substitutes the placeholders `handler`/`unknown` when extraction fails,
 * so it cannot ground a symbol match). They stay disclosed in `contractRootsNotAssessed`.
 */
export interface UnboundContractScope {
  symbols: Set<string>;
  /** Class name → the ONE directory it may live in, or `undefined` where no scope is proven. */
  classes: Map<string, string | undefined>;
  files: Set<string>;
  /** Distinct names a FRESH artifact dropped at its own cap; disclosed, not a ceiling trigger. */
  namesOmitted: number;
  /** Refusals a LEGACY (or truncated-items) artifact cannot name. Forces the ceiling. */
  legacyTruncated: number;
}

export function unboundContractSymbols(cg: SerializedCallGraph): UnboundContractScope {
  const symbols = new Set<string>();
  const classes = new Map<string, string | undefined>();
  const files = new Set<string>();
  const complete = cg.contracts?.unboundHandlerNames;
  if (complete) {
    for (const name of complete.symbols ?? []) if (typeof name === 'string') symbols.add(name);
    for (const c of complete.classes ?? []) if (c && typeof c.name === 'string') classes.set(c.name, c.dir);
    for (const f of complete.files ?? []) if (typeof f === 'string') files.add(wiringKey(f));
    const omitted = Number(complete.truncated);
    return { symbols, classes, files, namesOmitted: Number.isFinite(omitted) && omitted > 0 ? omitted : 0, legacyTruncated: 0 };
  }
  // Legacy artifact: the bounded items are all there is. Apply the SAME bucket rule by hand — a
  // refusal that names no function and is not a `not-literal` implementation argument buckets
  // nothing — and count what the bound hid, which the ceiling then answers for.
  let legacyTruncated = 0;
  const lists = [cg.contracts?.unresolvedRegistrations, cg.contracts?.unresolvedResolvers];
  for (const list of lists) {
    if (!list || typeof list !== 'object') continue;
    const items = Array.isArray(list.items) ? list.items : [];
    const total = Number(list.total);
    legacyTruncated += Number.isFinite(total) ? Math.max(0, total - items.length) : 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { symbol?: unknown; symbols?: unknown; className?: unknown; classDir?: unknown; file?: unknown; reason?: unknown };
      let named = false;
      const syms = [...(typeof row.symbol === 'string' ? [row.symbol] : []), ...(Array.isArray(row.symbols) ? row.symbols : [])];
      for (const sym of syms) if (typeof sym === 'string') { symbols.add(sym); named = true; }
      if (typeof row.className === 'string') {
        named = true;
        classes.set(row.className, typeof row.classDir === 'string' ? row.classDir : undefined);
      }
      if (!named && row.reason === 'not-literal' && typeof row.file === 'string') files.add(wiringKey(row.file));
    }
  }
  return { symbols, classes, files, namesOmitted: 0, legacyTruncated };
}

/**
 * The candidate dead-code id set: code nodes (excluding tests) not reachable from
 * any liveness root (tests, by-name imports, HTTP handlers, main-like, config-wired files). Shares the
 * documented roots definition with {@link handleFindDeadCode} so `find_dead_code`
 * and landmark signals agree on what "dead" means. Candidate ids only — deadness
 * is a signal, never deletion authority (see module header).
 */
export async function deadCodeIds(
  absDir: string,
  cg: SerializedCallGraph,
  opts?: { directResolvedOnly?: boolean; externalWiring?: Map<string, WiringReceipt[]> },
): Promise<Set<string>> {
  // Strict mode (opt-in): drop synthesized dynamic-dispatch edges from both the
  // reachability walk AND the synthesized route-handler roots, so a caller that
  // computes its own partition with `directResolvedOnly` gets a dead set grounded
  // on the SAME edge basis (otherwise the two conclusions can disagree). Default
  // (no opts) preserves the prior non-strict behavior byte-for-byte.
  const strict = opts?.directResolvedOnly === true;
  const dep = await loadDepSignals(absDir);
  const importedNames = dep?.names ?? null;
  const traversal = await loadTraversalIndex(absDir, cg);
  const handlerRootIds = externallyInvokedHandlerIds(cg, !strict);
  const wiredFiles = opts?.externalWiring ?? (await loadExternalWiring(absDir)).byFile;
  const codeNodes = cg.nodes.filter(isCodeNode);
  // Framework route handlers from the route inventory (change: root-framework-routes).
  // Applied in strict mode too: an inventoried route is a decorator literally above the
  // declaration, not a synthesized edge, so `directResolvedOnly` does not exclude it.
  const routeRoots = await loadRouteInventoryRoots(absDir, codeNodes);
  const isMainLike = (n: FunctionNode) => n.name === 'main' || n.name === 'Main' || n.name === 'default';
  const isRoot = (n: FunctionNode): boolean =>
    !!n.isTest || handlerRootIds.has(n.id) || routeRoots.rootIds.has(n.id) || isMainLike(n) ||
    wiredFiles.has(wiringKey(n.filePath)) ||
    (importedNames !== null && importedNames.has(n.name));
  const seedIds = codeNodes.filter(isRoot).map(r => r.id).sort();
  const live = traversal.reachAll(seedIds, 'forward', { directResolvedOnly: strict });
  return new Set(codeNodes
    .filter(n => !n.isTest && !live.has(n.id) && !isAmbientDeclarationFile(n.filePath))
    .map(n => n.id));
}

export async function handleFindDeadCode(input: FindDeadCodeInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return await diagnoseIndexUnservable(absDir);
  // A partial first-run index cannot ground a negative conclusion (change:
  // refine-first-run-partial-serving).
  const withheld = withheldOnPartialIndex(ctx, 'dead-code candidates');
  if (withheld) return withheld;
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const dep = await loadDepSignals(absDir);
  const importedNames = dep?.names ?? null;
  const importedFiles = dep?.files ?? null;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const traversal = await loadTraversalIndex(absDir, cg);
  const edgeFilter = { directResolvedOnly: input.directResolvedOnly };

  // Map each node reached *into* by a synthesized edge → the rule that produced it.
  // Used (in non-strict mode) to cap confidence at `low` for any candidate-dead
  // node that has an incoming synthesized edge whose source is itself unreached —
  // so a synthesized-dispatch target is never reported as high-confidence dead.
  const synthRuleByCallee = new Map<string, string>();
  if (!input.directResolvedOnly) {
    for (const e of cg.edges) {
      if (e.confidence === 'synthesized' && e.calleeId) {
        synthRuleByCallee.set(e.calleeId, e.synthesizedBy ?? 'synthesized');
      }
    }
  }

  // Nodes named as a candidate by an unresolved-ambiguous call site (change:
  // harden-call-resolution-ambiguity). Such a node has a *potential* caller the
  // resolver refused to bind — it may well be live via that call. It is therefore
  // never reported as high-confidence dead, mirroring the synthesized-edge downgrade.
  // Applies in both strict and non-strict mode (ambiguity is a resolution gap, not a
  // synthesized-edge artifact).
  const ambiguousCandidateIds = new Set<string>();
  for (const site of cg.ambiguousSites ?? []) {
    for (const id of site.candidateIds) ambiguousCandidateIds.add(id);
  }

  // Symbols a contract registration or resolver map named and the projection refused to bind
  // (change: cap-unbound-contract-handler-confidence). See {@link unboundContractSymbols}: such a
  // symbol is wired up in the source but roots nothing, so it is never high-confidence dead.
  const unboundContract = unboundContractSymbols(cg);

  // ── Roots (liveness seeds) — conservative: prefer false-live over false-dead ──
  // tests (they invoke code) · symbols imported by another file · HTTP route
  // handlers · synthesized route handlers (framework-invoked entry points; omitted
  // in strict mode) · main-like entry functions · functions in files a config
  // invokes (package.json, tsconfig, test-runner config, CI run steps).
  const httpHandlerIds = externallyInvokedHandlerIds(cg, !input.directResolvedOnly);
  const deployedIds = new Set(cg.edges.filter(e => e.kind === 'deploys_symbol' && e.calleeId).map(e => e.calleeId));
  const wiring = await loadExternalWiring(absDir);
  const isWired = (n: FunctionNode) => wiring.byFile.has(wiringKey(n.filePath));
  const isMainLike = (n: FunctionNode) => n.name === 'main' || n.name === 'Main' || n.name === 'default';

  const codeNodes = cg.nodes.filter(isCodeNode);
  // Framework route handlers the route inventory already found (change: root-framework-routes) —
  // `get_route_inventory` and this answer read the same build and must not contradict each other.
  // Only a handler that pins to exactly ONE declaration in its file is rooted; every refusal is
  // counted in `routeRootsNotAssessed` rather than guessed.
  const routeRoots: RouteInventoryRoots = await loadRouteInventoryRoots(absDir, codeNodes);
  const isRoot = (n: FunctionNode): boolean =>
    !!n.isTest ||
    httpHandlerIds.has(n.id) ||
    routeRoots.rootIds.has(n.id) ||
    isMainLike(n) ||
    isWired(n) ||
    (importedNames !== null && importedNames.has(n.name));

  const roots = codeNodes.filter(isRoot);
  const seedIds = [...roots].map(r => r.id).sort();
  const live = traversal.reachAll(seedIds, 'forward', edgeFilter);

  const exportSignal: 'dependency-graph' | 'none' = importedNames !== null ? 'dependency-graph' : 'none';
  const languages = [...new Set(codeNodes.map(n => n.language))].sort();

  // Confidence boundary: the liveness partition (and so every dead verdict) rests
  // on the edges traversed within the reachable set. Synthesized edges among them
  // mean a candidate's deadness leaned on a heuristic; disclose it. (spec:
  // add-confidence-boundary-disclosure)
  const liveBasis = edgeBasisWithinSet(cg.edges, live);
  const staleness = await computeStaleness(absDir);
  const boundaryParts = { basis: liveBasis, staleness, integrity: ctx?.integrity };
  // Dynamic-boundary sites (change: disclose-dynamic-boundary-regions). Read once per invocation —
  // and not at all beyond this, since a repository with no site has no artifact. The crossing itself
  // is assembled per answer, from the files THAT answer touched, never from the repository.
  // Strict mode folds bound literal-reflection constructs back in as sites: it ignores their edges
  // (change: resolve-literal-reflective-dispatch).
  const dynamicReport = await loadDynamicBoundaryReport(absDir, undefined, { directResolvedOnly: input.directResolvedOnly });
  const qualifyDynamic = buildQualifier(dynamicReport, dep?.imports ?? new Map());

  // ── Delete-impact mode: "what becomes dead if I delete X?" ──────────────────
  if (input.ifDeleted !== undefined) {
    const target = codeNodes.find(n => n.name === input.ifDeleted)
      ?? codeNodes.find(n => n.name.toLowerCase() === input.ifDeleted!.toLowerCase());
    if (!target) return { error: `Symbol "${input.ifDeleted}" not found in the code graph.` };

    const liveWithout = traversal.reachAll(seedIds, 'forward', edgeFilter, target.id);
    const becomesDead = [...live]
      .filter(id => id !== target.id && !liveWithout.has(id))
      .map(id => nodeMap.get(id))
      .filter((n): n is FunctionNode => !!n && isCodeNode(n) && !n.isTest)
      .map(n => ({ name: n.name, file: n.filePath, language: n.language, fanIn: n.fanIn }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

    // Delete-impact is a within-repo reachability question; federation scope (a
    // cross-repo *liveness* signal) does not apply. Disclose rather than silently
    // drop an opt-in flag — a cross-repo consumer is surfaced by the candidate-dead
    // mode (omit `ifDeleted`), not here.
    const federationRequested = input.federation === true || (input.federationRepos?.length ?? 0) > 0;
    return {
      target: target.name,
      file: target.filePath,
      becomesDeadIfDeleted: becomesDead,
      count: becomesDead.length,
      note: becomesDead.length === 0
        ? 'Nothing else becomes unreachable — every other node has an independent path to a root (or is itself a root).'
        : 'These nodes are reachable only through the target. Deleting it orphans them — verify before removing (dynamic callers are invisible here).',
      ...(federationRequested ? { federationNote: 'Federation scope is not applied in delete-impact (ifDeleted) mode — it is a within-repo reachability query. To see cross-repo consumers that keep a symbol live, call find_dead_code with federation and without ifDeleted, or analyze_impact with federation.' } : {}),
      soundness: deadCodeSoundness(exportSignal, languages, wiring.report, unboundContract),
      confidenceBoundary: assembleBoundary({
        ...boundaryParts,
        extraCrossings: crossingsOf(dynamicBoundaryCrossing(
          dynamicReport,
          [target.filePath, ...becomesDead.map(n => n.file)],
        )),
      }),
    };
  }

  // ── Candidate dead-code report ──────────────────────────────────────────────
  let candidates = codeNodes.filter(n => !n.isTest && !live.has(n.id));
  // A pattern that matches nothing scopes the report to an EMPTY set, and an empty report
  // over an empty scope said "no dead code here" without ever saying it looked nowhere
  // (change: never-claim-complete-beside-a-refusal). Counted over every indexed file, not
  // only the candidates, so "your pattern is wrong" is distinguishable from "that region
  // has no dead code".
  let filePatternMatch: { pattern: string; matchedFiles: number; detail?: string } | undefined;
  if (input.filePattern) {
    const pattern = input.filePattern;
    const matched = new Set<string>();
    for (const n of codeNodes) if (n.filePath.includes(pattern)) matched.add(n.filePath);
    candidates = candidates.filter(n => n.filePath.includes(pattern));
    filePatternMatch = {
      pattern,
      matchedFiles: matched.size,
      ...(matched.size === 0
        ? {
            detail:
              `filePattern "${pattern}" matched 0 of the indexed files, so this report covers an empty scope. ` +
              'An empty candidateDead here means "nothing was examined", NOT "nothing is dead" — the pattern is a '
              + 'plain substring of the repo-relative path, not a glob.',
          }
        : {}),
    };
  }
  // A `.d.ts` declaration is bodyless — there is no code there to be dead, so it is not a
  // candidate at all (change: root-framework-routes). Disclosed as a count (within the same
  // `filePattern` scope as the candidates), not dropped silently.
  const ambientDeclarations = candidates.filter(n => isAmbientDeclarationFile(n.filePath));
  candidates = candidates.filter(n => !isAmbientDeclarationFile(n.filePath));
  const generated = await generatedFactsForCandidates(absDir, candidates.map(n => n.filePath));
  const parseHealthReport = await loadParseHealthReport(absDir);
  const scriptContainerFiles = new Set(
    (parseHealthReport?.scriptContainers ?? [])
      .flatMap(boundary => boundary.files ?? [])
      .map(file => file.filePath),
  );

  const ranked = candidates
    .map(n => {
      const noCaller = (n.fanIn ?? 0) === 0;
      const dynamic = DYNAMIC_LANGS.has(n.language) || !STATIC_LANGS.has(n.language);
      const moduleUsed = importedFiles !== null && fileImported(n.filePath, importedFiles);
      const reasons: string[] = [];
      if (noCaller) reasons.push('no internal caller');
      else reasons.push('reachable only from other candidate-dead code');
      if (importedNames !== null && !importedNames.has(n.name)) reasons.push('not imported by name from any other file');
      if (moduleUsed) reasons.push('but its module IS imported elsewhere (symbol-level usage unresolved — e.g. namespace/default import or external API)');
      // The inventory's own word overrides the generic clause: a symbol it calls a route
      // handler must never be told it is "not a route handler" (change: root-framework-routes).
      if (routeRoots.namedButUnresolvedIds.has(n.id)) reasons.push(routeHandlerReason());
      else reasons.push('not a test, route handler, or main entry');

      // Conservative: a symbol whose module is consumed elsewhere can't be high —
      // named-import detection misses namespace/default/re-export usage.
      let confidence: Confidence;
      if (dynamic) confidence = 'low';
      else if (moduleUsed) confidence = 'low';
      else if (exportSignal === 'none') confidence = 'medium';
      else confidence = noCaller ? 'high' : 'medium';

      // A candidate reached into by a synthesized dynamic-dispatch edge (its
      // dispatcher itself unreached) is never high-confidence dead — it is a known
      // dynamic-dispatch blind spot, downgraded to low with the rule named.
      const synthRule = synthRuleByCallee.get(n.id);
      if (synthRule) {
        confidence = 'low';
        reasons.push(`reachable via a synthesized ${synthRule} edge whose dispatcher is not itself reached — likely live through dynamic dispatch`);
      }

      // A node named by an unresolved-ambiguous call site has a potential caller the
      // resolver refused to bind — never high-confidence dead (change:
      // harden-call-resolution-ambiguity).
      if (ambiguousCandidateIds.has(n.id)) {
        confidence = 'low';
        reasons.push('listed as a candidate by an unresolved-ambiguous call site — a potential caller was not bound, so it may be live');
      }

      // An inventoried handler the join refused to pin may well be the one serving the route.
      if (routeRoots.namedButUnresolvedIds.has(n.id)) confidence = 'low';

      // A generated file's symbols are driven by whatever generated them, never by a direct
      // in-repo call — `high` over them carries no signal (change: root-framework-routes).
      const gen = generated.facts.get(generatedKey(n.filePath));
      if (gen) {
        confidence = 'low';
        const why = gen.kind === 'vendored'
          ? 'third-party code vendored into this repository, whose callers need not be in it'
          : 'its symbols are driven by whatever generated them (reflection, embedding, a runtime registry), not by an in-repo call';
        reasons.push(`in a ${gen.kind} file (${gen.rule} rule, matched ${JSON.stringify(gen.matched)}, certainty ${gen.certainty}) — ${why}`);
      }

      // A symbol a gRPC registration or a GraphQL resolver map NAMED, whose binding the projection
      // refused to make (change: cap-unbound-contract-handler-confidence). A bound handler is a
      // liveness root; this one is not, so it can reach no root while its wiring names it in the
      // source. Never high-confidence dead, mirroring the unresolved-ambiguous downgrade. None of
      // the three reasons interpolates the repository's own text — the row already carries `name`,
      // `file` and `className`, and `contractRootsNotAssessed` names the registration site.
      if (unboundContract.symbols.has(n.name)) {
        confidence = 'low';
        reasons.push('a contract registration or resolver map writes this name and the binding was refused (see contractRootsNotAssessed) — the wiring that would root it was not bound, so it may be live');
      }
      // Matched by class NAME, narrowed to the one directory the projection's scope rule proves
      // (a Go registration naming an unqualified type means its own package). Where no such proof
      // exists the match is by name alone, which the reason says rather than asserting identity.
      if (n.className && unboundContract.classes.has(n.className)) {
        const dir = unboundContract.classes.get(n.className);
        if (dir === undefined || dirOf(wiringKey(n.filePath)) === dirOf(wiringKey(dir))) {
          confidence = 'low';
          reasons.push(`its class name matches the implementation a contract registration named${dir === undefined ? ', by name alone' : ' in this directory'}, and that registration could not be bound (see contractRootsNotAssessed) — the registration may serve this method`);
        }
      }
      // The refusal named no function at all — the registration or resolver map handed over a
      // variable, so what it binds is not written there. The file that declares it is the honest
      // granularity (such an object is written where it is registered), so every candidate in that
      // file is capped rather than one guessed name. This over-caps unrelated candidates in the
      // same file; `soundness.caveats` says so.
      if (unboundContract.files.has(wiringKey(n.filePath))) {
        confidence = 'low';
        reasons.push('declared in a file holding a contract registration or resolver map whose implementation argument could not be read (see contractRootsNotAssessed) — it may name this symbol, and which symbol cannot be said');
      }

      if (scriptContainerFiles.has(n.filePath)) {
        confidence = 'low';
        reasons.push('script-container templates and framework macros are unanalyzed and may invoke this symbol');
      }

      // A dynamic-boundary site that can reach this symbol (change:
      // disclose-dynamic-boundary-regions). Two properties make this a refinement, not a third
      // downgrade:
      //   - `low` is the floor every cap here shares, so a candidate a whole-language or
      //     synthesized-dispatch rule already capped is not made "more dead" by this one;
      //   - the standing caveats say only THAT reflection may hide a caller. This ADDS the specific
      //     site alongside them, so the reader learns WHICH construct bounds this answer. Nothing
      //     is removed: the dynamic-language rule contributes no per-candidate reason to replace,
      //     and `deadCodeSoundness` still emits its blanket caveat for the whole report.
      // A language with no matcher records no sites, so this simply never fires for it and the
      // shipped language-level cap remains its floor.
      const dynamicHit = qualifyDynamic(n.filePath, n.language);
      if (dynamicHit) {
        confidence = 'low';
        reasons.push(qualificationReason(dynamicHit));
      }

      // Repository-wide ceiling, for an index whose artifact cannot name every refusal (one written
      // before `unboundHandlerNames` existed, or whose own name cap was reached). An unnamed
      // refusal may be this very candidate and nothing here can tell, so `high` is withheld for the
      // whole repository. A current artifact names them all and reaches this never.
      const unnamedRefusals = unboundContract.legacyTruncated + unboundContract.namesOmitted;
      if (unnamedRefusals > 0 && confidence === 'high') {
        confidence = 'medium';
        reasons.push(`${unnamedRefusals} refused contract binding(s) are not named by this index (see contractRootsNotAssessed.refusalsNotNamed), so no candidate in this repository is rated high-confidence dead — re-run \`openlore analyze\` to name them`);
      }

      return {
        name: n.name, file: n.filePath, language: n.language, className: n.className ?? null,
        fanIn: n.fanIn ?? 0, startLine: n.startLine ?? null,
        confidence, reason: reasons.join('; '),
      };
    })
    .sort((a, b) =>
      ({ high: 0, medium: 1, low: 2 })[a.confidence] - ({ high: 0, medium: 1, low: 2 })[b.confidence] ||
      a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  // Federation (opt-in): a symbol with no consumer in THIS repo can still be live
  // fleet-wide. Pull any candidate consumed by another indexed repo out of the
  // candidate-dead set and report it as live-via-federation, with named coverage.
  // (change: add-multi-repo-federation)
  let finalRanked = ranked;
  let federationBlock: Record<string, unknown> | undefined;
  const fedScope = resolveFederationScope(absDir, { federation: input.federation, federationRepos: input.federationRepos });
  if (fedScope.active && ranked.length > 0) {
    const names = [...new Set(ranked.map(r => r.name))];
    const batch = await findCrossRepoConsumersBatch(fedScope, names);
    const liveNames = new Set([...batch.bySymbol.entries()].filter(([, v]) => v.length > 0).map(([k]) => k));
    const liveViaFederation = ranked
      .filter(r => liveNames.has(r.name))
      .map(r => ({
        name: r.name,
        file: r.file,
        consumers: (batch.bySymbol.get(r.name) ?? []).map(c => ({ repo: c.repo, caller: c.caller.name, file: c.caller.file })),
      }));
    finalRanked = ranked.filter(r => !liveNames.has(r.name));
    federationBlock = {
      liveViaFederation,
      keptAliveCount: liveViaFederation.length,
      reposConsulted: batch.coverage.reposConsulted.map(r => r.name),
      reposSkipped: batch.coverage.reposSkipped.map(r => ({ name: r.name, state: r.state, reason: r.reason })),
      // Disclose the consumer cap, matching analyze_impact — never silently drop.
      ...(batch.truncated > 0 ? { truncated: batch.truncated } : {}),
      caveats: batch.coverage.caveats,
    };
  } else if (fedScope.active) {
    federationBlock = {
      liveViaFederation: [],
      keptAliveCount: 0,
      reposConsulted: [],
      reposSkipped: [],
      caveats: [],
    };
  }

  const limit = Math.max(1, Math.min(input.maxResults ?? 100, 1000));
  const byConfidence = {
    high: finalRanked.filter(r => r.confidence === 'high').length,
    medium: finalRanked.filter(r => r.confidence === 'medium').length,
    low: finalRanked.filter(r => r.confidence === 'low').length,
  };

  // Parse-health boundary (change: add-parse-health-boundary-disclosure): a candidate whose file
  // parsed with errors may be FALSELY dead — a swallowed parse error can drop the very caller that
  // keeps it live. Disclose it so the candidate is not trusted as absent. Absent on a clean repo.
  const parseHealthNote = parseHealthBoundary(
    parseHealthReport,
    finalRanked.map(r => r.file),
  );

  return {
    stats: {
      analyzed: codeNodes.filter(n => !n.isTest).length,
      roots: roots.length,
      reachable: [...live].filter(id => { const n = nodeMap.get(id); return !!n && isCodeNode(n) && !n.isTest; }).length,
      candidateDead: finalRanked.length,
    },
    rootKinds: {
      tests: roots.filter(r => r.isTest).length,
      imported: importedNames !== null ? roots.filter(r => !r.isTest && importedNames.has(r.name)).length : 0,
      // Every framework the route inventory names is an HTTP routing framework (nestjs, express,
      // fastify, nextjs-app, fastapi, flask, django, starlette, spring, jaxrs, …), so its roots
      // count here; no finer split is clearly true from that field alone.
      httpHandlers: roots.filter(r => (httpHandlerIds.has(r.id) || routeRoots.rootIds.has(r.id)) && !deployedIds.has(r.id)).length,
      externallyWired: roots.filter(isWired).length,
      deployed: roots.filter(r => deployedIds.has(r.id)).length,
    },
    // Function resources whose handler binds to no indexed function: the code they run can look dead.
    ...(cg.unresolvedDeployBindings?.length ? {
      unresolvedDeployBindings: {
        count: cg.unresolvedDeployBindings.length,
        items: cg.unresolvedDeployBindings.slice(0, 20).map(u => ({ ...u, resource: emittedText(u.resource), file: emittedText(u.file), ...(u.handler ? { handler: emittedText(u.handler) } : {}), reason: emittedText(u.reason) })),
        note: 'These function resources name a handler that binds to no indexed function (an expression, a build-output path, or a missing file); the code they run can appear dead.',
      },
    } : {}),
    // A declared operation whose handler could not be pinned to one node keeps NO function live,
    // so a handler that really does serve a declared endpoint can appear dead; an unread
    // specification, or a projection that was not assessed, has the same effect
    // (change: add-contract-node-projection).
    ...((cg.contracts?.unresolvedBindings.total || cg.contracts?.unreadSpecifications.total || cg.contracts?.notAssessed?.length
      || cg.contracts?.unresolvedRegistrations?.total || cg.contracts?.unresolvedResolvers?.total
      || cg.contracts?.unboundGraphqlOperations?.total || cg.contracts?.unboundRpcs?.total) ? {
      contractRootsNotAssessed: {
        unresolvedBindings: cg.contracts.unresolvedBindings.total,
        // A gRPC registration that named a service but bound no method (a variable, a factory
        // call, an ambiguous type) leaves the implementation unrooted, exactly as an unresolved
        // route does (change: add-contract-graph-projection).
        ...(cg.contracts.unresolvedRegistrations?.total ? {
          unresolvedRegistrations: cg.contracts.unresolvedRegistrations.total,
          unresolvedRegistrationItems: cg.contracts.unresolvedRegistrations.items.slice(0, 10).map(u => ({
            file: emittedText(u.file), line: u.line, service: emittedText(u.service), reason: u.reason,
            ...(u.rpc ? { rpc: emittedText(u.rpc) } : {}),
            // What was left unrooted, so a reader sees which candidate-dead rows this explains.
            ...(u.symbol ? { symbol: emittedText(u.symbol) } : {}),
            ...(u.symbols?.length ? { symbols: u.symbols.slice(0, 10).map(emittedText) } : {}),
            ...(u.className ? { className: emittedText(u.className) } : {}),
          })),
        } : {}),
        unresolvedBindingItems: cg.contracts.unresolvedBindings.items.slice(0, 10).map(u => ({
          file: emittedText(u.file), line: u.line, method: emittedText(u.method),
          path: emittedText(u.path), operation: emittedText(u.operation),
        })),
        unreadSpecifications: cg.contracts.unreadSpecifications.items.slice(0, 5).map(u => ({ file: emittedText(u.file), reason: emittedText(u.reason) })),
        // A GraphQL resolver-map entry that bound nothing leaves its function unrooted the same way.
        ...(cg.contracts.unresolvedResolvers?.total ? {
          unresolvedResolvers: cg.contracts.unresolvedResolvers.total,
          unresolvedResolverItems: cg.contracts.unresolvedResolvers.items.slice(0, 10).map(u => ({
            file: emittedText(u.file), line: u.line, root: emittedText(u.root), reason: u.reason,
            ...(u.field ? { field: emittedText(u.field) } : {}),
            ...(u.symbol ? { symbol: emittedText(u.symbol) } : {}),
          })),
        } : {}),
        // Operations and RPCs no resolver map or registration binds: the code that serves them (a
        // code-first server, a style not read) is not rooted by them, so it may be listed here.
        ...(cg.contracts.unboundGraphqlOperations?.total ? { unboundGraphqlOperations: cg.contracts.unboundGraphqlOperations.total } : {}),
        ...(cg.contracts.unboundRpcs?.total ? { unboundRpcs: cg.contracts.unboundRpcs.total } : {}),
        // The ceiling, stated once whether or not a candidate reached the `high` branch.
        ...(unboundContract.legacyTruncated + unboundContract.namesOmitted > 0 ? {
          refusalsNotNamed: unboundContract.legacyTruncated + unboundContract.namesOmitted,
          refusalsNotNamedNote: 'This index cannot name these refused bindings (an artifact written before the names were carried, or past the name cap), so no candidate in this repository is rated high-confidence dead. Re-run `openlore analyze`.',
        } : {}),
        ...(cg.contracts.notAssessed?.length ? { notAssessed: cg.contracts.notAssessed.map(emittedText) } : {}),
        ...(cg.contracts.notes?.length ? { notes: cg.contracts.notes.map(emittedText) } : {}),
        note: 'A handler bound to a declared operation is a liveness root. These bindings were NOT made, so a handler that serves a declared endpoint may be listed as a candidate here — a candidate a refused registration or resolver names by symbol or class, or that is declared in the file of one whose implementation argument could not be read, is never rated high-confidence dead. Run `openlore analyze` after a specification changes; `certify_service_contract` grades the parity.',
      },
    } : {}),
    // What the route-inventory join rooted, and every route it refused to pin to one declaration
    // (change: root-framework-routes).
    routeInventoryRoots: {
      routesRead: routeRoots.routesRead,
      rooted: routeRoots.rootIds.size,
      byFramework: routeRoots.byFramework,
      ...(routeRoots.artifactBoundary ? { boundary: routeRoots.artifactBoundary } : {}),
    },
    ...(routeRoots.notAssessed ? { routeRootsNotAssessed: routeRoots.notAssessed } : {}),
    // `.d.ts` declarations are bodyless type declarations, not code — excluded from the
    // candidate set rather than rated, and counted here so the exclusion is visible.
    ...(ambientDeclarations.length > 0 ? {
      declarationsExcluded: {
        count: ambientDeclarations.length,
        files: [...new Set(ambientDeclarations.map(n => n.filePath))].sort().slice(0, 20),
        note: 'Declarations in TypeScript ambient declaration files (`.d.ts`) are bodyless — there is no code in them to be dead — so they are not dead-code candidates. Use `certify_public_surface` for the exported contract\'s shape.',
      },
    } : {}),
    // Receipts for every config-wired file that kept code live, and every config reference that
    // could not be resolved (change: add-framework-entry-point-adapters).
    externalWiring: externalWiringBlock(wiring.report, roots.filter(isWired)),
    byConfidence,
    candidateDead: finalRanked.slice(0, limit),
    ...(filePatternMatch ? { filePatternMatch } : {}),
    truncated: finalRanked.length > limit ? finalRanked.length - limit : 0,
    coverage: { languages, exportSignal },
    ...(federationBlock ? { federation: federationBlock } : {}),
    soundness: deadCodeSoundness(exportSignal, languages, wiring.report, unboundContract, [
      ...(routeRoots.artifactBoundary ? [routeRoots.artifactBoundary] : []),
      ...(routeRoots.notAssessed ? [`${routeRoots.notAssessed.total} inventoried route(s) did not pin to one declaration, so they rooted nothing (see routeRootsNotAssessed) — a handler that really serves a route can appear here.`] : []),
      ...generated.boundaries,
    ]),
    ...(parseHealthNote ? { parseHealthBoundary: parseHealthNote } : {}),
    confidenceBoundary: assembleBoundary({
      ...boundaryParts,
      extraCrossings: crossingsOf(dynamicBoundaryCrossing(
        dynamicReport,
        finalRanked.map(r => r.file),
      )),
    }),
  };
}

/** `extraCrossings` takes a list; a helper keeps every call site from repeating the same ternary. */
function crossingsOf(crossing: KnownUnknowableCrossing | undefined): KnownUnknowableCrossing[] {
  return crossing ? [crossing] : [];
}

/** Files listed in the `externalWiring` receipt block, at most. */
const MAX_WIRED_FILES_LISTED = 50;

function externalWiringBlock(report: ExternalWiringReport, wiredRoots: FunctionNode[]): Record<string, unknown> {
  const rootsByFile = new Map<string, number>();
  for (const r of wiredRoots) rootsByFile.set(wiringKey(r.filePath), (rootsByFile.get(wiringKey(r.filePath)) ?? 0) + 1);
  const files = report.wired
    .filter(w => rootsByFile.has(w.file))
    .map(w => ({ file: w.file, receipts: w.receipts, roots: rootsByFile.get(w.file)! }));
  return {
    files: files.slice(0, MAX_WIRED_FILES_LISTED),
    ...(files.length > MAX_WIRED_FILES_LISTED ? { filesOmitted: files.length - MAX_WIRED_FILES_LISTED } : {}),
    boundaries: report.boundaries,
    ...(report.boundariesOmitted > 0 ? { boundariesOmitted: report.boundariesOmitted } : {}),
  };
}

function deadCodeSoundness(
  exportSignal: 'dependency-graph' | 'none',
  languages: string[],
  wiring?: ExternalWiringReport,
  contract?: UnboundContractScope,
  extra: readonly string[] = [],
): { posture: string; caveats: string[] } {
  const caveats = [
    'These are CANDIDATES, not deletion authority — never auto-delete based on this.',
    'Dynamic dispatch, reflection, DI, plugin registries, and framework routing invoke code invisibly to static analysis; such symbols can be flagged dead falsely.',
    'Public API consumed OUTSIDE this repo is not visible as a root and may appear dead — treat exported library symbols with caution.',
  ];
  if (exportSignal === 'none') {
    caveats.push('No dependency graph found — the "imported elsewhere" liveness signal is unavailable, so confidence is reduced. Run analyze_codebase to generate it.');
  }
  if (wiring) caveats.push(...externalWiringCaveats(wiring));
  // The contract cap's own boundary, for the READER of the response and not only the source: it
  // fires where a refusal names the symbol, its class or its file, and nowhere else.
  if (contract && (contract.symbols.size || contract.classes.size || contract.files.size)) {
    caveats.push('A refused contract binding (a gRPC registration or GraphQL resolver map the projection could not bind) caps a candidate only where the refusal names its symbol, its class, or the file that declares the registration — so this cap is a LOWER BOUND: an implementation object assembled in another module, and a registration style the scan does not read at all (see contractRootsNotAssessed.unboundRpcs), are not covered. Where the refusal names only a file, unrelated candidates in it are capped too.');
  }
  if (contract && contract.legacyTruncated + contract.namesOmitted > 0) {
    caveats.push(`${contract.legacyTruncated + contract.namesOmitted} refused contract binding(s) are not named by this index, so NO candidate here is rated high-confidence dead. Re-run \`openlore analyze\`.`);
  }
  const dynamic = languages.filter(l => DYNAMIC_LANGS.has(l));
  if (dynamic.length > 0) {
    caveats.push(`Dynamic languages present (${dynamic.join(', ')}): implicit exports and runtime dispatch make deadness unreliable — those candidates are capped at low confidence.`);
  }
  caveats.push(...extra);
  return { posture: 'candidates-not-authority', caveats };
}
