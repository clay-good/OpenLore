/**
 * Guards for the uniform CLI output contracts (OutputContractsAreUniform,
 * change: fix-cli-output-hygiene).
 *
 * 1. Raw-ANSI guard: no command module embeds `\x1b[…m` escape literals. Color
 *    must flow through the shared color layer (src/utils/colors.ts) so it honors
 *    --no-color and non-TTY streams. The one exception is the full-screen
 *    interactive approval TUI, which needs cursor-control codes chalk cannot
 *    express and never writes to a pipe.
 * 2. Color layer: the shared helpers emit no escape bytes when color is off.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { palette } from '../utils/colors.js';

/** Files that legitimately contain raw ANSI: interactive full-screen renderers. */
const ANSI_ALLOWLIST = new Set(['tui-approval.ts']);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('CLI output hygiene — raw ANSI guard', () => {
  it('no command module embeds raw ANSI escape literals', () => {
    const cliDir = join(__dirname);
    // Match the escape as it appears in source: \x1b[ , [ , or \033[ .
    const rawAnsi = /\\x1b\[|\\u001b\[|\\033\[/;
    const offenders: string[] = [];

    for (const file of walkTsFiles(cliDir)) {
      // `basename`, not `split('/')`: on Windows the walker yields `\`-joined paths, so the split
      // returns the whole path and the allow-list never matches — the guard then reports its own
      // exempted file as an offender.
      const base = basename(file);
      if (ANSI_ALLOWLIST.has(base)) continue;
      if (rawAnsi.test(readFileSync(file, 'utf-8'))) {
        offenders.push(file);
      }
    }

    expect(
      offenders,
      `Route color through src/utils/colors.ts instead of raw ANSI literals:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('CLI output hygiene — shared color layer', () => {
  it('emits no escape bytes when color is disabled', () => {
    const c = palette(false);
    const painted = `${c.green('ok')} ${c.red('bad')} ${c.yellow('warn')} ${c.dim('x')}`;
    expect(painted).toBe('ok bad warn x');
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(painted)).toBe(false);
  });
});

describe('CLI output hygiene — untrusted terminal control sequences', () => {
  /**
   * `writeStdout` strips terminal control sequences centrally, which is only safe
   * while nothing colorizes through it. If a command starts emitting chalk/colors
   * down that path, the strip would eat its escapes and the colour would silently
   * vanish — so pin the assumption rather than leaving it as a comment.
   */
  it('keeps writeStdout a color-free path', () => {
    const commandsDir = join(import.meta.dirname, 'commands');
    const offenders: string[] = [];
    for (const file of walkTsFiles(commandsDir)) {
      const src = readFileSync(file, 'utf-8');
      if (!src.includes('writeStdout')) continue;
      if (/from 'chalk'|colorForStdout|palette\(/.test(src)) {
        offenders.push(file.split('/src/')[1] ?? file);
      }
    }
    expect(
      offenders,
      'These modules both write through writeStdout and emit colour. writeStdout strips\n' +
        'control characters (including the ESC that colour needs), so either route the\n' +
        'coloured output through the logger, or narrow the strip:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});

/**
 * The terminal-sink guard: NOTHING in src/ may interpolate an unsanitized value into
 * a `console.*` or `process.std{out,err}.write` template.
 *
 * This replaces a narrower guard that matched `console.log` only, only its FIRST
 * interpolation, only a `.field` access from a closed list of field names, and only
 * under `src/cli/commands/`. Every finding of the red-team pass that produced this
 * version slipped through one of those four holes: `console.error`, a raw
 * `process.stderr.write` twin of a sanitized `writeStdout` call, a bare `${name}`,
 * `verificationEvidence`, and sinks in `tui-approval.ts` / `config-manager.ts` /
 * `mcp-watcher.ts` / `mcp-handlers/**`. A guard whose shape has to predict the next
 * mistake does not hold, so this one inverts the question: every interpolation is an
 * offender until it is either sanitized or named in the table below.
 *
 * "Sanitized" means the interpolated expression calls one of the sanitizers
 * (`sanitizeForTerminal`, usually imported as `safe`, or the review/markdown
 * wrappers). Values reaching these sinks are repository-derived — symbol names, file
 * paths, spec requirement names, decision titles, memory text, config keys, code
 * comments — and a `\x1b[2K\r` in any of them erases a risk warning and lets the
 * analyzed repository forge OpenLore's verdict.
 *
 * The scan is statement-scoped, not line-scoped: the call's whole argument list is
 * read (string- and comment-aware), so a multi-line `process.stderr.write(\n  \`…\`)`
 * is covered too.
 */
const SINK = /(?:console\.(?:log|error|warn|info|debug)|process\.(?:stdout|stderr)\.write)\s*\(/g;
const SANITIZER = /\b(?:safe|sanitizeForTerminal|markdownText|sanitizeReviewValue)\s*\(/;

/**
 * Interpolations that are allowed to reach a terminal sink unsanitized, per file.
 *
 * The table names EXPRESSIONS, not line numbers, so moving a line does not churn it,
 * and the same expression stays allowed wherever that file prints it. Entries are
 * counts, computed numbers, OpenLore-authored labels and glyphs, and colour-helper
 * calls over string literals — values that cannot carry repository text.
 *
 * IT IS A RATCHET, NOT A BLESSING. It was seeded from the state of the tree when the
 * guard was inverted, which is wider than "numbers and literals": some entries are
 * pre-existing raw sinks in modules outside that change's scope (an `err.message`
 * quoting a path, a `--out` argument echoed back). They are recorded so the class
 * cannot GROW silently, and each one is a candidate for a follow-up. Adding an entry
 * is a review decision: if the value can contain repository text, wrap it in `safe()`
 * instead of listing it here.
 */
const ALLOWED_RAW_INTERPOLATIONS: Record<string, readonly string[]> = {
  'api/index.ts': [
    'drift.summary.total',
  ],
  'cli/commands/analyze.ts': [
    '(s.duplicationRatio * 100).toFixed(1)',
    'artifacts.dynamicBoundary.totalFiles',
    'artifacts.dynamicBoundary.totalSites',
    'artifacts.repoStructure.domains.length',
    'artifacts.repoStructure.domains.length - 6',
    'artifacts.repoStructure.envVars.length',
    'artifacts.repoStructure.middleware.length',
    'artifacts.repoStructure.routeInventory.total',
    'artifacts.repoStructure.schemas.length',
    'artifacts.repoStructure.uiComponents.length',
    'artifacts.repoStructure.undomained.length',
    'cg.entryPoints?.length ?? 0',
    'cg.layerViolations.length',
    'cg.stats.totalEdges',
    'cg.stats.totalNodes',
    'depGraph.statistics.avgDegree.toFixed(1)',
    'depGraph.statistics.clusterCount',
    'depGraph.statistics.cycleCount',
    'depGraph.statistics.edgeCount',
    'depGraph.statistics.nodeCount',
    "digestWritten ? '├─' : '└─'",
    'domain.files.length',
    "event.detail ?? 'Spec index updated'",
    'formatDuration(totalDuration)',
    'group.instances.length',
    'group.lineCount',
    'label',
    'prefix',
    'rawCandidates',
    'repoMap.highValueFiles.length',
    'repoMap.summary.analyzedFiles',
    's.cloneGroupCount',
    's.duplicatedFunctions',
    's.totalFunctions',
    's.withIssues',
    'severity',
    'tag',
  ],
  'cli/commands/audit.ts': [
    '(err as Error).message',
    'd.sourcesModifiedAt.slice(0, 10)',
    'd.specModifiedAt.slice(0, 10)',
    'fn.fanIn',
    'formatDuration(Date.now() - startTime)',
    'hub',
    'line',
    'metric(summary.hubGapCount, coverageAvailable)',
    'metric(summary.orphanRequirementCount, coverageAvailable)',
    'metric(summary.uncoveredCount, coverageAvailable)',
    'reportPath',
    'summary.staleDomainCount',
    'summary.uncoveredCount - 20',
  ],
  'cli/commands/decisions.ts': [
    'all.length',
    'approved.length',
    "c.blue('◉')",
    "c.blue('●')",
    "c.green('✔')",
    "c.red('✗')",
    "c.yellow('↗')",
    "c.yellow('⧖')",
    'commit',
    'confidence',
    'describeDisposition(decision)',
    'entries.length',
    'f',
    'icon',
    'originLabel',
    "parts.length ? parts.join(' · ') : 'nothing new'",
    'rejected.length',
    "result.modifiedSpecs.join(', ')",
    'safeScopeLabel',
    'scopeBadge',
    "unreviewedCount > 0 ? ` · ${unreviewedCount} awaiting review (openlore decisions review)` : ''",
    'when',
  ],
  'cli/commands/doctor.ts': [
    "' '.repeat(22)",
    'icon',
  ],
  'cli/commands/drift.ts': [
    'd.testFiles.length',
    "d.testFiles.length !== 1 ? 's' : ''",
    'icon',
    'issue.changedLines.added',
    'issue.changedLines.removed',
    'kindLabel(issue.kind)',
    'part',
    'result.analyzedFiles',
    'result.filesOmitted',
    'result.summary.total',
    'sev',
  ],
  'cli/commands/enforce.ts': [
    "failedGateCodes.join(', ')",
    'message',
  ],
  'cli/commands/features.ts': [
    "' '.repeat(38)",
    'c.bold(group)',
    "c.cyan('• default-on')",
    "c.dim('Core value needs zero config: orient, search, blast-radius, and the full graph work with no keys set.')",
    "c.dim('○ off')",
    'c.dim(`${inventory.activeCount} of ${inventory.optInCount} opt-in features active · legend:`)',
    'c.dim(f.detail)',
    "c.green('✓ on')",
    'c.yellow(`→ ${f.activate}`)',
    'f.title.padEnd(38)',
    'icon',
  ],
  'cli/commands/federation.ts': [
    "''.padEnd(20)",
    '(err as Error).message',
    'STATE_LABEL[state] ?? state',
    'fp',
    'nameOrPath',
    'repos.length',
    "repos.length === 1 ? '' : 's'",
    'resolve(process.cwd())',
  ],
  'cli/commands/generate.ts': [
    'ARTIFACT_GENERATION_REPORT',
    'OPENLORE_DIR',
    'OPENLORE_OUTPUTS_SUBDIR',
    'formatDuration(duration)',
    'i + 1',
    'report.filesBackedUp.length',
    'report.filesMerged.length',
    'report.filesSkipped.length',
    'report.filesWritten.length',
    'report.warnings.length - 5',
  ],
  'cli/commands/mapping.ts': [
    'resolution.index.stats.ambiguous',
    'resolution.message',
    'resolution.remediation',
  ],
  'cli/commands/mcp.ts': [
    '(e as Error).message',
    '(error as Error).message',
    'err.message',
  ],
  'cli/commands/orient.ts': [
    "evaluation.failedCriteria.join(',') || 'none'",
    "evaluation.passedCriteria.join(',') || 'none'",
    "evaluation.reason ?? 'none'",
    'ip.rank',
    'tokens',
    'verdict',
    'wallMs.toFixed(1)',
  ],
  'cli/commands/panic-hotspots.ts': [
    'ARTIFACT_REL',
    'e instanceof Error ? e.message : String(e)',
  ],
  'cli/commands/panic-level.ts': [
    'state.panicLevel',
  ],
  'cli/commands/panic-replay.ts': [
    'e instanceof Error ? e.message : String(e)',
    'trace',
  ],
  'cli/commands/prove.ts': [
    '(err as Error).message',
    'path',
    'recall.baselineRecall.toFixed(2)',
    'recall.recallAt',
    'recall.vocabularyRecall.toFixed(2)',
  ],
  'cli/commands/review-corpus.ts': [
    'message',
  ],
  'cli/commands/setup.ts': [
    'LABELS[tool as ToolName]',
    'created',
    'e.rel',
    'marker',
    'skipped',
    'updated',
  ],
  'cli/commands/telemetry.ts': [
    "''.padStart(5)",
    "'across agents'.padEnd(28)",
    "'agent'.padEnd(28)",
    "'avg files'.padStart(10)",
    "'avg fn'.padStart(8)",
    "'avg ins pts'.padStart(12)",
    "'avg ms'.padStart(8)",
    "'cache'.padStart(7)",
    "'calls'.padStart(6)",
    "'errors'.padStart(7)",
    "'max ms'.padStart(8)",
    "'sess'.padStart(5)",
    "'tool'.padEnd(32)",
    "'—'.repeat(28)",
    "Number(ev['density'] ?? 0).toFixed(3)",
    'String(a.calls).padStart(6)',
    'String(a.errors).padStart(7)',
    'String(a.sessions).padStart(5)',
    'String(breakdown.across_agents.calls).padStart(6)',
    'String(breakdown.across_agents.errors).padStart(7)',
    'String(r.avg_files).padStart(10)',
    'String(r.avg_functions).padStart(8)',
    'String(r.avg_insertion_points).padStart(12)',
    'String(r.calls).padStart(6)',
    'String(s.avg_ms).padStart(8)',
    'String(s.count).padStart(6)',
    'String(s.max_ms).padStart(8)',
    'UNKNOWN_AGENT',
    '`${a.cache.hit_rate}%`.padStart(7)',
    '`${breakdown.across_agents.cache.hit_rate}%`.padStart(7)',
    'agent',
    'basename(filePath)',
    'breakdown.across_agents.agents',
    'burstStr',
    'cacheStats.hit_rate',
    'cacheStats.hits',
    'cacheStats.total',
    'd2',
    'd3',
    'degraded',
    'obstinacy.avg_calls_before_orient',
    'obstinacy.depth2_avg',
    'obstinacy.depth3_avg',
    'obstinacy.total_stale_episodes',
    "panicStats.avg_recovery_ms != null ? `${panicStats.avg_recovery_ms}ms` : '—'",
    'panicStats.failed_recovery_rate',
    'panicStats.gryph_enriched_intercepts',
    'panicStats.hook_intercepts',
    'panicStats.mcp_injections',
    'panicStats.orient_rapid_events',
    'panicStats.orient_spam_events',
    'panicStats.panic_episodes',
    'pct(pv.false_positive.proxy_rate)',
    'pct(pv.intervention.follow_through_rate)',
    'pv.episodes.completed',
    'pv.episodes.total',
    'pv.false_positive.resolved_via_decay',
    'pv.intervention.hook_intercepts',
    'pv.intervention.responses',
    'pv.min_episodes',
    'pv.verdict',
    'quality.total_calls',
    'recovery.avg_recovery_ms != null ? `${recovery.avg_recovery_ms}ms` : noPair(recovery.recovery_excluded_pairs)',
    'recovery.avg_stable_after_orient_ms != null ? `${recovery.avg_stable_after_orient_ms}ms` : noPair(recovery.stability_excluded_pairs)',
    'recovery.orient_resets',
    'recovery.recovery_excluded_pairs',
    'recovery.recovery_sessions',
    'recovery.recurrence_rate',
    'recovery.stability_excluded_pairs',
    'recovery.stability_sessions',
    'sessions.size',
    'stale',
    'title',
    'tool',
    'tool.padEnd(30)',
    'tools.total_calls',
    'tools.total_errors',
    'trajectory.avg_density',
    'trajectory.burst_events',
    'trajectory.max_density',
    'ts',
    'unattributed',
  ],
  'cli/commands/test.ts': [
    'bar.padStart(6)',
    'drift',
    'pct.padEnd(8)',
    'report.coveragePercent',
    'report.discoveredScenarios',
    'report.taggedScenarios',
    'report.totalScenarios',
    'report.totalScenarios - report.coveredScenarios',
    'report.uncovered.length - 20',
    'status',
    'thresholdSuffix',
  ],
  'cli/commands/verify.ts': [
    '(result.overallScore).toFixed(2)',
    '(result.requirementCoverage.coverage * 100).toFixed(0)',
    'OPENLORE_DIR',
    'OPENLORE_VERIFICATION_SUBDIR',
    'bar',
    'basis',
    'confidenceBasis',
    'confidencePercent',
    'evidence',
    'exportEvidence',
    'exportPercent',
    'i + 1',
    'importEvidence',
    'importPercent',
    'index',
    'model',
    'paddedName',
    'passedPercent',
    'prefix',
    'purposeEvidence',
    'purposeStatus',
    'recommendationDetail',
    'recommendationIcon',
    'recommendationText',
    'report.attemptedFiles',
    'report.failedFiles',
    'report.passedFiles',
    "report.recommendationBasis ?? 'provenance unavailable'",
    'report.sampledFiles',
    'result.exportMatch.actual.length',
    'result.exportMatch.predicted.length',
    'result.importMatch.actual.length',
    'result.importMatch.predicted.length',
    "result.purposeMatch.similarity >= 0.5 ? 'Correctly identified' : 'Partially matched'",
    'scoreBasis',
    'scorePercent',
    'status',
    'total',
  ],
  'cli/heap-sizing.ts': [
    '(err as Error).message',
    'NO_AUTO_HEAP_ENV',
    'plan.reason',
    'plan.targetMb',
    'result.error.message',
  ],
  'cli/index.ts': [
    "c.yellow('[warn]')",
  ],
  'cli/node-version-guard.ts': [
    'result.message',
  ],
  'core/analyzer/call-graph-cfg.ts': [
    '(error as Error).message',
    'language',
  ],
  'core/analyzer/call-graph.ts': [
    '(error as Error).message',
    'file.path',
  ],
  'core/analyzer/dependency-graph.ts': [
    '(error as Error).message',
    'file.absolutePath',
  ],
  'core/analyzer/extraction-pool.ts': [
    'Math.round(SLOW_FILE_DISCLOSURE_MS / 1000)',
  ],
  'core/runtime/analysis-ownership.ts': [
    '(err as Error).message',
  ],
  'core/services/config-manager.ts': [
    'OPENLORE_CONFIG_REL_PATH',
    'prefix',
  ],
  'core/services/mcp-handlers/graph.ts': [
    '(error as Error).message',
  ],
  'core/services/mcp-handlers/live-data/repo-cache.ts': [
    'line',
  ],
  'core/services/mcp-watcher.ts': [
    'Date.now() - t0',
    'Math.round(WATCH_FLUSH_STALL_DISCLOSURE_MS / 1000)',
    'absPaths.length',
    'attempt + 1',
    'attempts',
    'batch.length',
    'batchSize',
    'changed.length',
    'changedFilePaths.size',
    'changedFiles.length',
    'count',
    'deletedRels.length',
    'deletions.length',
    'embedded',
    'err.timeoutMs',
    "isBulk ? `coalesced ${n} changes` : `updated ${n} file${n === 1 ? '' : 's'}`",
    'newEdges.length',
    'newNodes.length',
    'reason',
    'recomputed.length',
    'rels.length',
    'requeued.length',
    'reused',
    'staleFiles.length',
    "staleNow.length ? `, ${formatStaleRegionComposition(staleComposition)} → stale${usedPathFallback ? ', stable-path fallback' : ''}${testReachabilityDegraded ? ', configured budget defers test reachability' : ''}${skipped.length ? ` (${skipped.length} unreadable)` : ''}` : ''",
    "this.embed && !this.embedDegraded ? '' : ' (signatures-only)'",
    'this.embedFileCeiling',
    'this.pending.size',
    'this.pendingDeletions.size',
    'total',
    'unreadable.length',
  ],
  'core/services/tls-scope.ts': [
    'reason',
  ],
  'utils/logger.ts': [
    "chalk.dim(key + ':')",
    'chalk.dim(prefix)',
    'item',
    'key',
    'message',
    'prefix',
    'title',
    'value',
  ],
  'utils/progress.ts': [
    '(options.score * 100).toFixed(1)',
    "isTTY ? '🏷️ ' : '-'",
    "isTTY ? '📁' : '-'",
    "isTTY ? '📊' : '-'",
    "isTTY ? '🔤' : '-'",
    'options.domains',
    'options.filesAnalyzed',
    'options.filesVerified',
    'options.specsCount',
    'options.tokensUsed.toLocaleString()',
  ],
  'utils/prompts.ts': [
    'envVar',
    'error',
    'stage',
    'url',
  ],
  'utils/shutdown.ts': [
    'this.state.savedResults',
    'this.stateFile',
  ],
};

/** Recursive walk of production `.ts` under a directory. */
function walkProductionTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `viewer` is a browser bundle (its console goes to devtools, not a terminal);
      // `fuzz` and `*.test.ts` are not shipped output paths.
      if (entry === 'viewer' || entry === 'fuzz') continue;
      walkProductionTs(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Index just past a quoted string starting at `i`. */
function skipQuoted(src: string, i: number, quote: string): number {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === quote) return i + 1;
    else i++;
  }
  return i;
}

/** Index just past a template literal starting at `i` (its `${}` parts included). */
function skipTemplate(src: string, i: number): number {
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '`') return i + 1;
    if (src[i] === '$' && src[i + 1] === '{') { i = skipBraces(src, i + 1); continue; }
    i++;
  }
  return i;
}

/** Index just past the `{…}` starting at `i`, counting nested braces and strings. */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

/** `[start, end)` of the argument list whose `(` is at `open`. */
function argumentSpan(src: string, open: number): [number, number] {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i); if (end < 0) break; i = end + 2; continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return [open, i + 1]; }
    i++;
  }
  return [open, src.length];
}

/** Every top-level `${…}` expression of every template literal inside `[a, b)`. */
function interpolations(src: string, a: number, b: number): string[] {
  const found: string[] = [];
  let i = a;
  while (i < b) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipQuoted(src, i, c); continue; }
    if (c !== '`') { i++; continue; }
    const end = skipTemplate(src, i);
    let j = i + 1;
    while (j < end) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        const close = skipBraces(src, j + 1);
        found.push(src.slice(j + 2, close - 1).trim().replace(/\s+/g, ' '));
        j = close;
        continue;
      }
      j++;
    }
    i = end;
  }
  return found;
}

/** Every terminal sink in `src` whose interpolations are neither sanitized nor allowed. */
function unsanitizedSinks(src: string, allowed: ReadonlySet<string>): { line: number; exprs: string[] }[] {
  const found: { line: number; exprs: string[] }[] = [];
  for (const match of src.matchAll(SINK)) {
    const open = match.index + match[0].length - 1;
    const [a, b] = argumentSpan(src, open);
    const exprs = interpolations(src, a, b).filter(
      (expr) => !SANITIZER.test(expr) && !allowed.has(expr),
    );
    if (exprs.length === 0) continue;
    found.push({ line: src.slice(0, match.index).split('\n').length, exprs });
  }
  return found;
}

describe('CLI output hygiene — untrusted values reaching a terminal sink', () => {
  it('catches the shapes the previous guard missed', () => {
    // Non-vacuity: a guard this broad is worthless if its scanner silently matches
    // nothing. Each case below is one of the four holes that let a real finding
    // through — a non-`console.log` sink, a bare `${name}`, a second interpolation,
    // and a multi-line write — plus the two shapes that must NOT be flagged.
    const sample = [
      'console.error(`decision: ${d.title}`);',
      'console.log(`${name}`);',
      'console.log(`${safe(a)} and ${b}`);',
      'process.stderr.write(',
      '  `[warn] ${err.message}\\n`,',
      ');',
      'console.log(`${safe(value)}`);',
      "console.log('no interpolation at all');",
    ].join('\n');
    const hits = unsanitizedSinks(sample, new Set());
    expect(hits.map((h) => h.exprs)).toEqual([['d.title'], ['name'], ['b'], ['err.message']]);
  });

  it('sanitizes (or explicitly allows) every interpolation into console/process.std* writes', () => {
    const srcDir = join(import.meta.dirname, '..');
    const offenders: string[] = [];

    for (const file of walkProductionTs(srcDir)) {
      const rel = file.slice(file.indexOf(`${sep}src${sep}`) + 5).split(sep).join('/');
      const allowed = new Set(ALLOWED_RAW_INTERPOLATIONS[rel] ?? []);
      for (const hit of unsanitizedSinks(readFileSync(file, 'utf-8'), allowed)) {
        offenders.push(`${rel}:${hit.line}  ${hit.exprs.map((e) => `\${${e}}`).join(' ')}`);
      }
    }

    expect(
      offenders,
      'These interpolate an unsanitized value into a terminal sink. A repository being\n' +
        'analyzed can smuggle terminal control sequences through any of them and forge\n' +
        "OpenLore's own output. Wrap the value: `${safe(value)}`\n" +
        '(import { sanitizeForTerminal as safe }), or — only if the value cannot contain\n' +
        'repository text — add the expression to ALLOWED_RAW_INTERPOLATIONS above.\n\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
