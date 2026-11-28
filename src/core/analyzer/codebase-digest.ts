/**
 * Codebase Digest — generates .openlore/CODEBASE.md
 *
 * A compact, agent-readable Markdown summary of the codebase produced by
 * `openlore analyze`.  Designed to be included in CLAUDE.md / .clinerules
 * so agents absorb architectural context passively at session start, without
 * needing to call any MCP tool.
 *
 * It also writes `CODEBASE.slim.md` (change: adopt-agent-context-interop): at most 12 lines of
 * repository shape that `orient --inject` prints once per harness session, so the full digest
 * need not be loaded on every turn.
 *
 * Content:
 *   - Entry points (functions with no internal callers)
 *   - Critical hubs (highest fan-in functions)
 *   - Spec domains (if openspec/specs/ exists)
 *   - Most coupled files (high in-degree in dependency graph)
 *   - God functions / oversized orchestrators
 *   - Layer violations (if any)
 */

import { lstat, readdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ARTIFACT_DEPENDENCY_GRAPH, ARTIFACT_SLIM_DIGEST, OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { resolveOpenspecDir } from '../../utils/openspec-dir.js';
import { confinedAtomicWriteFile } from '../../utils/path-confinement.js';
import { frameServedContent } from '../services/served-content.js';
import type { LLMContext, RepoStructure } from './artifact-generator.js';
import { collectExternalWiring } from './entry-point-adapters.js';
import type { DependencyGraphResult } from './dependency-graph.js';
import { ALL_LANGUAGES, languageCoverageMatrix, renderCoverageMatrixMarkdown } from './language-support.js';
import { isExcludedPath } from '../services/mcp-handlers/code-node.js';
import { isProjectedLanguage } from './projected-language.js';

// ============================================================================
// TYPES
// ============================================================================

interface DigestOptions {
  /** Absolute path to the project root */
  rootPath: string;
  /** Absolute path to the .openlore/analysis/ output directory */
  outputDir: string;
  /** Max entry points to list */
  maxEntryPoints?: number;
  /** Max hub functions to list */
  maxHubs?: number;
  /** Max god functions to list */
  maxGodFunctions?: number;
  /** Max most-coupled files to list */
  maxCoupledFiles?: number;
  /** Reconciled analyzer-owned domains; never inferred again by this consumer. */
  repoStructure?: RepoStructure;
  /** The configured spec root (`openspecPath`); default `openspec`. */
  openspecPath?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Neutralize repo-derived text before it is interpolated into a Markdown row.
 *
 * Every name in this digest comes from the ANALYZED repository — function names, class names,
 * directory-derived domain names, file paths. A name carrying a newline or a `|` could close the
 * row and forge further table rows (or whole sections) in a file that is @-imported into the
 * developer's agent instructions; a backtick could close the code span the value sits in and let
 * the rest render as markup. Structure is stripped, the text itself is not rewritten — the
 * surrounding frame (below) is what says the content is data.
 *
 * STRIPPED, not escaped. Escaping `|` as `\\|` was incomplete: a backslash is not itself
 * escaped, so `a\\|b` became `a\\\\|b` — an escaped BACKSLASH followed by a live pipe, which
 * closes the cell anyway. Removing the structural characters has no such ordering hazard.
 */
function repoText(value: string): string {
  return value.replace(/[\r\n|`]+/g, ' ');
}

function rel(absPath: string, rootPath: string): string {
  return absPath.startsWith(rootPath)
    ? absPath.slice(rootPath.length).replace(/^\//, '')
    : absPath;
}

/** Extract per-file coupling from pre-computed node metrics */
function fileCoupling(depGraph: DependencyGraphResult | null): Array<{ path: string; importedBy: number; imports: number }> {
  if (!depGraph) return [];
  return depGraph.nodes
    .map(n => ({
      path: n.file?.path ?? n.id,
      importedBy: n.metrics?.inDegree ?? 0,
      imports: n.metrics?.outDegree ?? 0,
    }))
    .sort((a, b) => b.importedBy - a.importedBy);
}

/**
 * Production functions and the call edges between them. `cg.nodes` also carries test, external
 * (library) and projected (IaC, contract) nodes for other tools; neither digest counts them.
 */
function productionCounts(cg: NonNullable<LLMContext['callGraph']>): { functions: number; internalEdges: number; ids: Set<string> } {
  // CODEBASE.md's own count; byte-identical to before (the slim digest narrows it: `slimScope`).
  const prodNodes = cg.nodes.filter(
    n => !n.isTest && !n.isExternal && !isProjectedLanguage(n.language),
  );
  const ids = new Set(prodNodes.map(n => n.id));
  const internalEdges = cg.edges.filter(
    e => (!e.kind || e.kind === 'calls') && ids.has(e.callerId) && ids.has(e.calleeId)
  ).length;
  return { functions: prodNodes.length, internalEdges, ids };
}

/** Spec domain folder names under `specsDir` that hold a `spec.md`, sorted platform-independently. */
async function specDomainNames(specsDir: string): Promise<string[]> {
  if (!existsSync(specsDir)) return [];
  try {
    return (await readdir(specsDir))
      .filter(e => existsSync(join(specsDir, e, 'spec.md')))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Number of ADR records (`adr-*.md` regular files) in a decisions folder; 0 when it is absent or
 * unreadable. The same rule as every other decision reader (`architecture/rules.ts`,
 * `drift/spec-mapper.ts`), so a `README.md` or a template is not counted as a decision.
 */
async function decisionRecordCount(decisionsDir: string): Promise<number> {
  if (!existsSync(decisionsDir)) return 0;
  try {
    return (await readdir(decisionsDir, { withFileTypes: true }))
      .filter(e => e.isFile() && /^adr-.*\.md$/i.test(e.name)).length;
  } catch {
    return 0;
  }
}


/** Upper bound on the slim digest, frame included (change: adopt-agent-context-interop). */
export const SLIM_DIGEST_MAX_LINES = 12;

/** First line of every slim digest. */
export const SLIM_DIGEST_TITLE = '# Repository shape at the last `openlore analyze` (OpenLore, once per session)';

/** A symbol name in a slim fact: one plain token, no spaces, ASCII only (so no sentence fits). */
const SLIM_NAME = '[A-Za-z_$][A-Za-z0-9_$.<>#~:-]{0,119}';
/** A repository-relative path in a slim fact: plain segments, no `..`, no leading `/`, ASCII only. */
const SLIM_PATH = '(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:/[A-Za-z0-9._@+-]+){0,30}';
const SLIM_CALLEE = `\`${SLIM_NAME}\` \\(\`${SLIM_PATH}\`, \\d{1,9}\\)`;
const KNOWN_LANGUAGES = new Set(ALL_LANGUAGES);

/**
 * The grammar of each fact line a slim digest may hold, in this order, each at most once. Every
 * variable part is a number, a plain name, a plain path, or a registered language, so a repository
 * cannot fit prose into a fact by committing a forged file. Writer and reader both use it: the
 * writer drops a value that does not fit, the reader refuses a file with a line that does not.
 */
export const SLIM_FACT_GRAMMAR: ReadonlyArray<(line: string) => boolean> = [
  line => /^- \d{1,9} functions? outside test, generated and vendored files, with \d{1,9} resolved caller-callee pairs? between them\.$/.test(line),
  line => new RegExp(`^- Most callers among them: ${SLIM_CALLEE}(?:, ${SLIM_CALLEE}){0,2}\\.$`).test(line),
  line => {
    const m = /^- Call graph built for: (.+)\.$/.exec(line);
    return !!m && m[1].split(', ').every(l => KNOWN_LANGUAGES.has(l));
  },
  line => new RegExp(`^- Written intent: (?:specs in \`${SLIM_PATH}\` \\(\\d{1,9} domains?\\)(?:; decisions in \`${SLIM_PATH}\` \\(\\d{1,9} ADRs?\\))?|decisions in \`${SLIM_PATH}\` \\(\\d{1,9} ADRs?\\))\\.$`).test(line),
];

/** True when `value` is a plain name, or a plain path, that a slim fact may carry. */
const isSlimName = (value: string) => new RegExp(`^${SLIM_NAME}$`).test(value);
const isSlimPath = (value: string) => new RegExp(`^${SLIM_PATH}$`).test(value);

const SLIM_FRAME_LABEL = 'slim digest';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface SlimDigestInput {
  /** Production functions and the distinct resolved caller-callee pairs between them. */
  counts?: { functions: number; pairs: number };
  /** Production functions with the most distinct production callers, already sorted; three are used. */
  hubs: Array<{ name: string; file: string; callers: number }>;
  /** Detected languages whose call graph OpenLore builds. */
  callGraphLanguages: string[];
  /** Spec domains and their folder, when the repository has any. */
  specs?: { path: string; domains: number };
  /** ADR records and their folder, when the repository has any. */
  decisions?: { path: string; records: number };
  /** Path of the full digest, shown in the pointer line. */
  fullDigestPath: string;
}

/** The full digest's repository-relative path, as the pointer line names it. */
function fullDigestPathOf(rootPath: string, outputDir: string): string {
  return `${relative(rootPath, outputDir).replaceAll('\\', '/')}/CODEBASE.md`;
}

/** The pointer line; its only variable part is the full digest's repository-relative path. */
export function slimPointerLine(fullDigestPath: string): string {
  return `For a task, call \`orient\` with what you are about to change. Full digest: \`${repoText(fullDigestPath)}\`.`;
}

/**
 * Assemble a slim digest from its fact lines: the title, the facts inside one data frame (left
 * out when there are none), and the pointer line. Both the writer and the reader's shape check use
 * this, so a file is accepted only when it is byte-for-byte what this function produces.
 */
export function assembleSlimDigest(facts: readonly string[], fullDigestPath: string): string {
  const lines = [SLIM_DIGEST_TITLE];
  if (facts.length > 0) lines.push(frameServedContent(facts.join('\n'), 'source-derived', SLIM_FRAME_LABEL));
  lines.push(slimPointerLine(fullDigestPath));
  return lines.join('\n') + '\n';
}

/** Where the full digest sits beside the slim one, as the writer names it in the pointer line. */
export const SLIM_FULL_DIGEST_PATH = `${OPENLORE_ANALYSIS_REL_PATH}/CODEBASE.md`;

/**
 * True only when `text` is byte-for-byte what `assembleSlimDigest` produces for its own fact lines
 * with the pointer to `fullDigestPath`, and every fact line fits its grammar (`SLIM_FACT_GRAMMAR`:
 * numbers, plain names, plain paths, registered languages), in the fixed order, at most once each.
 * So a file committed into `.openlore/analysis/` can neither put text outside the frame nor fit a
 * sentence inside it.
 */
export function isWellFormedSlimDigest(text: string, fullDigestPath = SLIM_FULL_DIGEST_PATH): boolean {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length < 2 || lines.length > SLIM_DIGEST_MAX_LINES || lines[0] !== SLIM_DIGEST_TITLE) return false;
  if (lines[lines.length - 1] !== slimPointerLine(fullDigestPath)) return false;
  const facts = lines.length === 2 ? [] : lines.slice(3, lines.length - 2);
  if (facts.length > SLIM_FACT_GRAMMAR.length) return false;
  let next = 0;
  for (const fact of facts) {
    const kind = SLIM_FACT_GRAMMAR.findIndex(g => g(fact));
    if (kind < next) return false;
    next = kind + 1;
  }
  return assembleSlimDigest(facts, fullDigestPath) === `${lines.join('\n')}\n`;
}

/**
 * Render the slim digest: a title, the framed repository facts (at most four lines), and one
 * pointer line. Every repo-derived value goes through `repoText` and the frame. A fact the index
 * does not hold is left out, never shown as zero.
 */
export function renderSlimDigest(input: SlimDigestInput): string {
  const facts: string[] = [];
  if (input.counts) {
    facts.push(`- ${plural(input.counts.functions, 'function', 'functions')} outside test, generated and vendored files, with ${plural(input.counts.pairs, 'resolved caller-callee pair', 'resolved caller-callee pairs')} between them.`);
  }
  // The ranked prefix up to the first entry whose name or path is not one plain token: dropping
  // that entry and showing the next would name the wrong function as having the most callers.
  const refused = input.hubs.findIndex(h => !(h.callers > 0 && isSlimName(h.name) && isSlimPath(h.file)));
  const hubs = (refused < 0 ? input.hubs : input.hubs.slice(0, refused)).slice(0, 3);
  if (hubs.length > 0) {
    facts.push(`- Most callers among them: ${hubs.map(h => `\`${h.name}\` (\`${h.file}\`, ${h.callers})`).join(', ')}.`);
  }
  const languages = input.callGraphLanguages.filter(l => KNOWN_LANGUAGES.has(l));
  if (languages.length > 0) facts.push(`- Call graph built for: ${languages.join(', ')}.`);
  const intent: string[] = [];
  if (input.specs && input.specs.domains > 0 && isSlimPath(input.specs.path)) intent.push(`specs in \`${input.specs.path}\` (${plural(input.specs.domains, 'domain', 'domains')})`);
  if (input.decisions && input.decisions.records > 0 && isSlimPath(input.decisions.path)) intent.push(`decisions in \`${input.decisions.path}\` (${plural(input.decisions.records, 'ADR', 'ADRs')})`);
  if (intent.length > 0) facts.push(`- Written intent: ${intent.join('; ')}.`);
  // Defense in depth: a line the reader would refuse is never written.
  return assembleSlimDigest(facts.filter(f => SLIM_FACT_GRAMMAR.some(g => g(f))), input.fullDigestPath);
}

/**
 * Production functions and the DISTINCT resolved caller-callee pairs between them: synthesized
 * dispatch edges (which over-approximate by method name), test, external and projected nodes, and
 * repeated call sites are left out, the same certain-edge basis the call graph's fan-in uses.
 */
/**
 * The functions the slim digest counts: not test, external or projected (as CODEBASE.md), and not
 * in a generated or vendored file (the shared `isExcludedPath`, as `briefing_since` and
 * `report_coverage_gaps` use). The fact lines say "outside test, generated and vendored files".
 */
function slimScope(cg: NonNullable<LLMContext['callGraph']>): Set<string> {
  return new Set(cg.nodes
    .filter(n => !n.isTest && !n.isExternal && !isProjectedLanguage(n.language) && !isExcludedPath(n.filePath.replaceAll('\\', '/')))
    .map(n => n.id));
}

function slimCounts(cg: NonNullable<LLMContext['callGraph']>, ids: ReadonlySet<string>): { functions: number; pairs: number } {
  const pairs = new Set<string>();
  for (const e of cg.edges) {
    if (isResolvedProductionCall(e, ids)) pairs.add(`${e.callerId}\0${e.calleeId}`);
  }
  return { functions: ids.size, pairs: pairs.size };
}

type CallEdge = NonNullable<LLMContext['callGraph']>['edges'][number];
function isResolvedProductionCall(e: CallEdge, ids: ReadonlySet<string>): boolean {
  return (!e.kind || e.kind === 'calls') && (e as { confidence?: string }).confidence !== 'synthesized'
    && e.callerId !== e.calleeId && ids.has(e.callerId) && ids.has(e.calleeId);
}

/**
 * Production functions ranked by DISTINCT resolved production callers (self-calls, synthesized
 * edges, and test, external and projected callers left out), with two callers or more; ties inside
 * the list are ordered by id so the bytes are stable. Unlike `fanIn`, which also counts test callers, this is what "called from production
 * code" means.
 */
function topProductionCallees(
  cg: NonNullable<LLMContext['callGraph']>,
  ids: ReadonlySet<string>,
  rootPath: string,
  limit = 3,
): Array<{ name: string; file: string; callers: number }> {
  const callers = new Map<string, Set<string>>();
  for (const e of cg.edges) {
    if (!isResolvedProductionCall(e, ids)) continue;
    let set = callers.get(e.calleeId);
    if (!set) callers.set(e.calleeId, set = new Set());
    set.add(e.callerId);
  }
  const byId = new Map(cg.nodes.map(n => [n.id, n]));
  // At least two callers, and no arbitrary pick from a tie at the cut: when the entry after the
  // last one shown has the same count, every entry with that count is left out.
  const ranked = [...callers.entries()]
    .map(([id, set]) => ({ id, count: set.size }))
    .filter(r => r.count >= 2)
    .sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cutTies = ranked.length > limit && ranked[limit - 1].count === ranked[limit].count;
  return (cutTies ? ranked.filter(r => r.count > ranked[limit - 1].count) : ranked)
    .slice(0, limit)
    .map(({ id, count }) => {
      const n = byId.get(id)!;
      return { name: n.className ? `${n.className}.${n.name}` : n.name, file: rel(n.filePath, rootPath), callers: count };
    });
}

/** Detected (non-external, known) languages whose registry record backs a call graph. */
function callGraphLanguages(cg: NonNullable<LLMContext['callGraph']>): string[] {
  const detected = [...new Set(
    cg.nodes.filter(n => !n.isExternal && n.language && n.language !== 'unknown' && !isProjectedLanguage(n.language)).map(n => n.language),
  )];
  return languageCoverageMatrix(detected).rows.filter(r => r.supported.callGraph).map(r => r.language);
}

/** Remove `path` when it is a regular file (never follows or removes a symlink). Never throws. */
async function removeRegularFile(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isFile()) await unlink(path);
  } catch { /* absent or not removable: nothing to serve stale */ }
}

/**
 * The slim digest `generateCodebaseDigest` writes for this analysis and repository state (specs and
 * ADRs are read from disk now). Shared by the writer and by `ensureSlimDigestCurrent`.
 */
export async function buildSlimDigest(
  llmContext: LLMContext,
  opts: { rootPath: string; outputDir: string; openspecPath?: string },
): Promise<string> {
  const { rootPath, outputDir } = opts;
  const cg = llmContext.callGraph;
  const specRoot = resolveOpenspecDir(rootPath, opts.openspecPath);
  const decisionsDir = join(specRoot, 'decisions');
  const ids = cg ? slimScope(cg) : undefined;
  return renderSlimDigest({
    ...(cg && ids ? { counts: slimCounts(cg, ids) } : {}),
    hubs: cg && ids ? topProductionCallees(cg, ids, rootPath) : [],
    callGraphLanguages: cg ? callGraphLanguages(cg) : [],
    specs: { path: `${relative(rootPath, specRoot).replaceAll('\\', '/')}/specs`.replace(/^\//, ''), domains: (await specDomainNames(join(specRoot, 'specs'))).length },
    decisions: { path: relative(rootPath, decisionsDir).replaceAll('\\', '/'), records: await decisionRecordCount(decisionsDir) },
    fullDigestPath: fullDigestPathOf(rootPath, outputDir),
  });
}

/**
 * The digests are written only by a full analyze, so an index built before the slim digest existed
 * (or with an older format of it) would never get one while the source stays unchanged, and specs
 * or ADRs added since would never be counted. Rebuild both from the cached analysis when the slim
 * one is not byte-for-byte what this state produces; with the same inputs, CODEBASE.md is
 * unchanged. Returns whether it rebuilt. Never throws.
 */
export async function ensureSlimDigestCurrent(
  llmContext: LLMContext,
  opts: { rootPath: string; outputDir: string; repoStructure?: RepoStructure; openspecPath?: string },
): Promise<boolean> {
  try {
    try {
      const current = await readFile(join(opts.outputDir, ARTIFACT_SLIM_DIGEST), 'utf-8');
      if (current === await buildSlimDigest(llmContext, opts)) return false;
    } catch { /* absent or unreadable: rebuild */ }
    let depGraph: DependencyGraphResult | null = null;
    try { depGraph = JSON.parse(await readFile(join(opts.outputDir, ARTIFACT_DEPENDENCY_GRAPH), 'utf-8')) as DependencyGraphResult; } catch { /* degraded */ }
    return await generateCodebaseDigest(llmContext, depGraph, opts);
  } catch {
    return false;
  }
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Generate `.openlore/CODEBASE.md` from cached analysis artifacts.
 *
 * Non-fatal: logs a warning and returns false if generation fails.
 */
export async function generateCodebaseDigest(
  llmContext: LLMContext,
  depGraph: DependencyGraphResult | null,
  opts: DigestOptions,
): Promise<boolean> {
  try {
    const {
      rootPath,
      outputDir,
      maxEntryPoints = 8,
      maxHubs = 10,
      maxGodFunctions = 5,
      maxCoupledFiles = 8,
      repoStructure,
    } = opts;
    // A slim digest from an earlier run (or one the repository committed) must never outlive this
    // run: removed first, so any failure below leaves no slim digest rather than a stale one.
    await removeRegularFile(join(outputDir, ARTIFACT_SLIM_DIGEST));

    const cg = llmContext.callGraph;
    const lines: string[] = [];
    lines.push(`# Codebase — architecture digest`);
    lines.push(`> Generated by openlore analyze. Re-run after significant refactors.`);
    lines.push(`> Add this file to CLAUDE.md or .clinerules so agents absorb it at session start.`);
    lines.push('');
    // Everything from here to the MCP-workflow section is derived from the ANALYZED repository and
    // is @-imported verbatim into the developer's agent instructions. That is the same untrusted
    // channel `orient --inject` serves, so it gets the same treatment: the repo-derived body is
    // wrapped by `frameServedContent` below. OpenLore's own title and workflow guidance stay
    // OUTSIDE the frame — framing them would label our instructions as data.
    const bodyStart = lines.length;

    // ── Overview ──────────────────────────────────────────────────────────────
    if (cg) {
      // Production functions only: cg.nodes also carries test and external (library)
      // nodes so the test-impact tools can use them. The digest describes the
      // production surface, so exclude both — otherwise test helpers and stdlib
      // calls inflate the counts and leak into the god-function list (e.g. a Java
      // `FooTest.checkOption` showing up as an orchestrator).
      // A projected declaration (an IaC resource, an OpenAPI operation or schema) is not a
      // function that was analyzed, and the tables below are labelled as functions — a document
      // declaring a few hundred schemas otherwise reports a seven-function repository as having
      // thousands, and fills "the natural starting point for any task" with YAML stanzas.
      // `stats.totalEdges` counts ALL `calls` edges — including test-caller and
      // external-callee edges — so labeling it "internal" next to the production-only
      // function count mixes two populations under one qualifier. Count only edges
      // whose BOTH endpoints are production nodes (`productionCounts`).
      const { functions, internalEdges } = productionCounts(cg);
      lines.push('## Overview');
      lines.push(`- **${functions}** functions / methods analyzed`);
      lines.push(`- **${internalEdges}** internal call edges`);
      // Decompose entry points into config-wired vs. orphaned (change: add-framework-entry-point-adapters).
      const wired = rootPath
        ? new Set((await collectExternalWiring(rootPath).catch(() => ({ wired: [] }))).wired.map(w => w.file))
        : new Set<string>();
      const wiredEntryPoints = (cg.entryPoints ?? [])
        .filter(n => wired.has(n.filePath.replaceAll('\\', '/').replace(/^\.\//, ''))).length;
      const entryPointCount = cg.entryPoints?.length ?? 0;
      lines.push(`- **${entryPointCount}** entry points (no internal callers)` + (rootPath && entryPointCount > 0
        ? `: **${wiredEntryPoints}** in files a config invokes (package.json, tsconfig, test-runner config, CI run steps), **${entryPointCount - wiredEntryPoints}** invoked by no config read`
        : ''));
      lines.push(`- **${cg.hubFunctions?.length ?? 0}** hub functions (high fan-in)`);
      if (cg.stats?.avgFanIn !== undefined) {
        lines.push(`- avg fan-in: **${cg.stats.avgFanIn.toFixed(2)}**, avg fan-out: **${cg.stats.avgFanOut.toFixed(2)}**`);
      }
      lines.push('');
    }

    // ── Language coverage ─────────────────────────────────────────────────────
    // A deterministic capability matrix over the repo's detected languages, so a
    // quiet structural result is interpretable: "·" means the capability is not
    // backed for that language (fail-soft), not that there were no matches.
    if (cg) {
      const detected = [...new Set(
        cg.nodes.filter(n => !n.isExternal && n.language && n.language !== 'unknown').map(n => n.language),
      )].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const detectedSet = new Set(detected);
      const additionallyBacked = languageCoverageMatrix().rows
        .filter(row => row.supportedCount > 0 && !detectedSet.has(row.language))
        .map(row => row.language);
      lines.push('## Language coverage');
      lines.push('This table is scoped to languages detected in this repository (`✓` backed, `·` fail-soft / not claimed). A `·` cell means a quiet result for that capability is "unsupported here", not "nothing found".');
      lines.push('');
      lines.push(...renderCoverageMatrixMarkdown(languageCoverageMatrix(detected)));
      lines.push('');
      if (additionallyBacked.length > 0) {
        lines.push(`Registry additionally backs: ${additionallyBacked.join(', ')}. Query \`get_language_support\` for the full matrix.`);
        lines.push('');
      }
      lines.push('> Query this at runtime with the `get_language_support` MCP tool (opt-in). See the "add a language" checklist in the docs.');
      lines.push('');
    }

    // ── Entry points ──────────────────────────────────────────────────────────
    if (cg?.entryPoints?.length) {
      lines.push('## Entry points');
      lines.push('Functions with no internal callers — the natural starting point for any task.');
      lines.push('');
      lines.push('| Function | File | fanOut |');
      lines.push('|----------|------|--------|');
      for (const ep of cg.entryPoints.slice(0, maxEntryPoints)) {
        const file = rel(ep.filePath, rootPath);
        const name = ep.className ? `${ep.className}.${ep.name}` : ep.name;
        lines.push(`| \`${repoText(name)}\` | \`${repoText(file)}\` | ${ep.fanOut} |`);
      }
      if (cg.entryPoints.length > maxEntryPoints) {
        lines.push(`| … | *(${cg.entryPoints.length - maxEntryPoints} more)* | |`);
      }
      lines.push('');
    }

    // ── Critical hubs ─────────────────────────────────────────────────────────
    if (cg?.hubFunctions?.length) {
      const sorted = [...cg.hubFunctions].sort((a, b) => b.fanIn - a.fanIn);
      lines.push('## Critical hubs');
      lines.push('Most-called functions — modifying these has the widest blast radius.');
      lines.push('');
      lines.push('| Function | File | fanIn | fanOut |');
      lines.push('|----------|------|-------|--------|');
      for (const hub of sorted.slice(0, maxHubs)) {
        const file = rel(hub.filePath, rootPath);
        const name = hub.className ? `${hub.className}.${hub.name}` : hub.name;
        lines.push(`| \`${repoText(name)}\` | \`${repoText(file)}\` | ${hub.fanIn} | ${hub.fanOut} |`);
      }
      if (sorted.length > maxHubs) {
        lines.push(`| … | *(${sorted.length - maxHubs} more)* | | |`);
      }
      lines.push('');
    }

    // ── God functions ─────────────────────────────────────────────────────────
    if (cg?.nodes?.length) {
      // Production functions only — test helpers and external (library) nodes are
      // not orchestrators of this codebase (see Overview note above).
      const gods = cg.nodes
        .filter(n => !n.isTest && !n.isExternal && n.fanOut >= 8)
        .sort((a, b) => b.fanOut - a.fanOut)
        .slice(0, maxGodFunctions);

      if (gods.length > 0) {
        lines.push('## God functions (high fan-out orchestrators)');
        lines.push('These functions coordinate many downstream calls — extend them carefully.');
        lines.push('');
        lines.push('| Function | File | fanOut |');
        lines.push('|----------|------|--------|');
        for (const g of gods) {
          const file = rel(g.filePath, rootPath);
          const name = g.className ? `${g.className}.${g.name}` : g.name;
          lines.push(`| \`${repoText(name)}\` | \`${repoText(file)}\` | ${g.fanOut} |`);
        }
        lines.push('');
      }
    }

    // ── Most coupled files ────────────────────────────────────────────────────
    const coupled = fileCoupling(depGraph);
    if (coupled.length > 0) {
      const top = coupled.filter(f => f.importedBy >= 3).slice(0, maxCoupledFiles);
      if (top.length > 0) {
        lines.push('## Most imported files');
        lines.push('High in-degree files — changes here ripple widely. Prefer extending over modifying.');
        lines.push('');
        lines.push('| File | imported by | imports |');
        lines.push('|------|-------------|---------|');
        for (const f of top) {
          lines.push(`| \`${repoText(f.path)}\` | ${f.importedBy} | ${f.imports} |`);
        }
        lines.push('');
      }
    }

    // ── Layer violations ──────────────────────────────────────────────────────
    if (cg?.layerViolations?.length) {
      lines.push('## Layer violations');
      lines.push('These cross-layer call patterns indicate architecture drift.');
      lines.push('');
      for (const v of cg.layerViolations.slice(0, 5)) {
        lines.push(`- \`${repoText(v.callerId)}\` → \`${repoText(v.calleeId)}\` *(${repoText(v.callerLayer)} → ${repoText(v.calleeLayer)})*`);
      }
      if (cg.layerViolations.length > 5) {
        lines.push(`- … (${cg.layerViolations.length - 5} more violations)`);
      }
      lines.push('');
    }

    // ── Reconciled analysis domains ──────────────────────────────────────────
    if (repoStructure?.domains.length) {
      const raw = repoStructure.statistics.rawDomainCandidateCount ?? repoStructure.domains.length;
      lines.push('## Inferred ownership domains');
      lines.push(`${raw} raw candidates reconciled into ${repoStructure.domains.length} generation-ready domains.`);
      lines.push('');
      for (const domain of repoStructure.domains) {
        const defining = domain.definingFiles?.length ?? domain.files.length;
        const supporting = domain.supportingFiles?.length ?? 0;
        lines.push(`- \`${repoText(domain.name)}\` — ${defining} defining, ${supporting} supporting files`);
      }
      lines.push('');
    }

    // ── Spec domains ──────────────────────────────────────────────────────────
    const specRoot = resolveOpenspecDir(rootPath, opts.openspecPath);
    const specsPrefix = `${relative(rootPath, specRoot).replaceAll('\\', '/')}/specs`.replace(/^\//, '');
    const specsDir = join(specRoot, 'specs');
    // Sorted before emission: raw `readdir` order is platform-dependent, so an
    // unsorted list would make the digest bytes vary across machines.
    const specDomains = await specDomainNames(specsDir);
    if (specDomains.length > 0) {
      lines.push('## Spec domains');
      lines.push('OpenSpec domains available for this project. Use `search_specs` or `get_spec` to query them.');
      lines.push('');
      for (const d of specDomains) {
        lines.push(`- \`${repoText(d)}\` — \`${repoText(specsPrefix)}/${repoText(d)}/spec.md\``);
      }
      lines.push('');
    }

    // ── MCP workflow ─────────────────────────────────────────────────────────────────────────────
    const bodyEnd = lines.length;
    lines.push('## openlore MCP workflow');
    lines.push('');
    lines.push('**Follow this sequence for every task:**');
    lines.push('');
    lines.push('1. **`orient "<task description>"`** — always start here. Returns relevant functions, files, spec domains, call paths, and insertion points in one call.');
    lines.push('2. **If the task involves data models, APIs, or config** — call the relevant inventory tool:');
    lines.push('   `get_schema_inventory` · `get_route_inventory` · `get_env_vars` · `get_ui_component_inventory` · `get_middleware_inventory`');
    lines.push('3. **If debugging a call flow** ("how does X reach Y?") — `trace_execution_path`');
    lines.push('4. **Before modifying a function** — `get_subgraph` to understand blast radius');
    lines.push('5. **Before opening a PR** — `check_spec_drift`');
    lines.push('');
    lines.push("**On-demand** (when orient's results aren't enough):");
    lines.push('`search_code` · `suggest_insertion_points` · `get_spec <domain>` · `search_specs` · `analyze_impact` · `get_function_body` · `get_function_skeleton`');

    const digest = [
      ...lines.slice(0, bodyStart),
      frameServedContent(lines.slice(bodyStart, bodyEnd).join('\n'), 'source-derived', 'codebase digest'),
      '',
      ...lines.slice(bodyEnd),
    ].join('\n') + '\n';
    // `writeFile` FOLLOWED a symlink at this path. A repository committing
    // `.openlore/analysis/CODEBASE.md -> ~/.claude/CLAUDE.md` therefore had repo-chosen text
    // (directory-derived domain names, function names) written straight into the developer's
    // GLOBAL agent instructions by a plain `openlore install`. The confined atomic writer refuses
    // a non-regular target and a symlinked path component, like every other artifact in the tree.
    await confinedAtomicWriteFile(outputDir, join(outputDir, 'CODEBASE.md'), digest);

    // ── Slim digest (change: adopt-agent-context-interop) ───────────────────
    // A failure here leaves CODEBASE.md written and reported as written, and no slim digest (the
    // earlier one was removed at the start of this run).
    try {
      const slim = await buildSlimDigest(llmContext, { rootPath, outputDir, openspecPath: opts.openspecPath });
      await confinedAtomicWriteFile(outputDir, join(outputDir, ARTIFACT_SLIM_DIGEST), slim);
    } catch { /* no slim digest this run */ }
    return true;
  } catch {
    return false;
  }
}
