/**
 * `openlore review` — the PR-review surface (change: add-pr-review-surface).
 *
 * Composes two analyses that already ship into ONE deterministic, conclusion-shaped
 * briefing for a `base..head` range, rendered as Markdown for a PR comment (or JSON
 * for a programmatic consumer):
 *
 *   - the structural delta  (`handleStructuralDiff`): added / removed / signature-
 *     changed symbols, the callers they leave stale, and rename/move candidates;
 *   - the blast radius       (`computeBlastRadius`): hubs touched, layers crossed,
 *     tests to run, governing decisions, and the spec/memory/decision drift the
 *     change introduces — `computeBlastRadius` already folds change-scoped drift in,
 *     so `review` does not separately re-run `detectDrift`.
 *
 * No new structural computation, no LLM, no new MCP tool (north star c6d1ad07).
 * Advisory by default (exit 0); opt-in gating reuses the `.openlore/config.json`
 * `blastRadius.block` convention. Degrades honestly — a missing index, an unreachable
 * base, or a non-git directory states what it could not compute rather than emitting
 * a misleading empty briefing. Decision: 4f3efb11.
 */

import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { logger, configureLogger } from '../../utils/logger.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { writeStdout } from '../output.js';
import { computeBlastRadius, type BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';
import { handleStructuralDiff } from '../../core/services/mcp-handlers/structural-diff.js';
import { isGitRepository } from '../../core/drift/git-diff.js';
import type { BlastRadiusBlockPattern } from '../../types/index.js';
import { triggeredBlockPatterns } from './blast-radius.js';

/** Hidden HTML marker the GitHub Action greps for to find-and-update its single
 * sticky comment (create once, update in place, never duplicate). MUST be the first
 * line of the rendered markdown so a simple substring match locates it. */
export const REVIEW_MARKER = '<!-- openlore-review -->';

// These shapes mirror `handleStructuralDiff`'s return (it is typed `unknown`); the
// fields we read are marked optional so the renderer's guards against a partial/error
// payload are type-checked rather than lint noise.
interface SymbolRef { name: string; file: string; className?: string | null; signature?: string }
interface StructuralResult {
  base?: string;
  head?: string;
  message?: string;
  error?: string;
  changedFiles?: Array<{ path: string; status: string; oldPath?: string }>;
  summary?: {
    addedFunctions: number; removedFunctions: number; signatureChanges: number;
    addedEdges: number; removedEdges: number; staleCallers: number; renameCandidates: number;
  };
  added?: SymbolRef[];
  removed?: Array<SymbolRef & { staleCallers?: Array<{ file: string; name: string }> }>;
  signatureChanged?: Array<SymbolRef & { before: string; after: string; staleCallers?: Array<{ file: string; name: string }> }>;
  renameCandidates?: Array<{ from: SymbolRef; to: SymbolRef; confidence: string; note: string }>;
}

export interface ReviewBriefing {
  base: string;
  head: string;
  structural: StructuralResult;
  blast: BlastRadiusBriefing | { error: string };
  caveats: string[];
  /** `ok` when at least one of the two analyses produced a real result; `unavailable`
   * when both failed (e.g. not a git repo). The CLI/Action stays advisory either way. */
  status: 'ok' | 'unavailable';
}

const execFileAsync = promisify(execFile);

/** True when two git refs resolve to the same commit. On any git error returns false
 * (conservative — we'd rather emit the divergence caveat than silently hide it). */
async function sameCommit(cwd: string, refA: string, refB: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--verify', `${refA}^{commit}`], { cwd }),
      execFileAsync('git', ['rev-parse', '--verify', `${refB}^{commit}`], { cwd }),
    ]);
    return a.stdout.trim() === b.stdout.trim() && a.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Run both analyses for a `base..head` range and assemble the briefing. Never throws —
 * a thrown handler is captured as that section's `{error}` so an advisory caller (the
 * CLI, the CI Action) is never broken by a composed failure. */
export async function composeReview(opts: { cwd: string; base?: string; head?: string }): Promise<ReviewBriefing> {
  const caveats: string[] = [];

  // Suppress the per-call "Successfully validated directory" chatter from the
  // composed handlers so only the briefing (or --json) reaches stdout.
  configureLogger({ quiet: true });
  let structural: StructuralResult;
  let blast: BlastRadiusBriefing | { error: string };
  try {
    const [s, b] = await Promise.all([
      handleStructuralDiff({ directory: opts.cwd, baseRef: opts.base, headRef: opts.head })
        .then(r => r as StructuralResult)
        .catch(err => ({ error: err instanceof Error ? err.message : String(err) }) as StructuralResult),
      // computeBlastRadius diffs the working tree against `base` — it has no headRef.
      // In CI the runner checks out the head SHA so working tree == head; locally with
      // an explicit `--head` that differs, we caveat it below rather than silently
      // mixing ranges.
      computeBlastRadius({ directory: opts.cwd, baseRef: opts.base })
        .catch(err => ({ error: err instanceof Error ? err.message : String(err) })),
    ]);
    structural = s;
    blast = b;
  } finally {
    configureLogger({ quiet: false });
  }

  // Honest range note: blast radius is always working-tree-vs-base; structural honors
  // an explicit head. Flag the case where they can diverge (an explicit --head that
  // is NOT the checked-out commit). In CI the runner checks out the head SHA, so
  // working tree == head and this caveat is correctly suppressed (no noise per PR).
  if (opts.head && opts.head !== 'working tree') {
    const headIsWorkingTree = await sameCommit(opts.cwd, opts.head, 'HEAD');
    if (!headIsWorkingTree) {
      caveats.push(
        `Blast radius is computed against the working tree vs "${opts.base ?? 'HEAD'}"; the structural delta uses "${opts.base ?? 'HEAD'}..${opts.head}". ` +
          'They can differ when --head is not the checked-out commit.',
      );
    }
  }
  // Surface a silent base-ref fallback (a typo'd / unreachable --base) so the briefing
  // never misrepresents what it diffed. Derive the resolved base from whichever analysis
  // succeeded — so a shallow CI checkout with no index (blast unavailable) still discloses
  // the fallback via the structural delta's resolved base.
  const resolvedFromAnalyses = !('error' in blast) ? blast.resolvedBaseRef : (!structural.error ? structural.base : undefined);
  if (opts.base && resolvedFromAnalyses && resolvedFromAnalyses !== opts.base) {
    caveats.push(`Base ref "${opts.base}" did not resolve — diffed against "${resolvedFromAnalyses}" instead.`);
  }
  if (!structural.error && blast && 'error' in blast) {
    caveats.push(`Blast radius unavailable (${blast.error}) — showing the structural delta only. Run \`openlore analyze\` for the full briefing.`);
  }

  const resolvedBase = (!('error' in blast) && blast.resolvedBaseRef) || structural.base || opts.base || 'HEAD';
  return {
    base: resolvedBase,
    head: opts.head ?? 'working tree',
    structural,
    blast,
    caveats,
    status: structural.error && blast && 'error' in blast ? 'unavailable' : 'ok',
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────────

/** GitHub rejects an issue/PR comment body over this many characters with HTTP 422.
 * renderMarkdown clamps to it so the bundled Action can always post the briefing. */
export const MAX_MARKDOWN_CHARS = 65536;
/** Per-item identifier clamp — one pathologically long symbol/file name (minified or
 * generated code) must not blow a single bullet past the comment limit on its own. */
const MAX_IDENT = 160;
/** Per-inline-list clamp — hubs/layers/decisions are joined onto one line; bound the
 * count so a hub-heavy change stays a briefing, not an unbounded line. */
const INLINE_CAP = 12;

function fileName(p: string): string {
  return p.replace(/^.*\//, '');
}

/** Clip an identifier/message to a sane length so no single token dominates the briefing. */
function clip(s: string, max = MAX_IDENT): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Join an inline list with a bounded count + "…and N more" tail (no unbounded one-liner). */
function inlineList(items: string[], cap = INLINE_CAP, sep = ', '): string {
  if (items.length <= cap) return items.join(sep);
  return items.slice(0, cap).join(sep) + sep + `…and ${items.length - cap} more`;
}

/** One-line conclusion summarising the whole review. */
function headline(b: ReviewBriefing): string {
  const s = b.structural.summary;
  const blast = b.blast;
  if (b.status === 'unavailable') return 'OpenLore could not analyze this change (see notes below).';
  const parts: string[] = [];
  if (s) {
    if (s.removedFunctions) parts.push(`removed ${s.removedFunctions} function${s.removedFunctions === 1 ? '' : 's'}`);
    if (s.addedFunctions) parts.push(`added ${s.addedFunctions} function${s.addedFunctions === 1 ? '' : 's'}`);
    if (s.signatureChanges) parts.push(`changed ${s.signatureChanges} signature${s.signatureChanges === 1 ? '' : 's'}`);
    if (s.staleCallers) parts.push(`${s.staleCallers} caller${s.staleCallers === 1 ? '' : 's'} now stale`);
  }
  if (!('error' in blast)) {
    if (blast.impact.hubsTouched.length) parts.push(`touches ${blast.impact.hubsTouched.length} hub${blast.impact.hubsTouched.length === 1 ? '' : 's'}`);
    if (blast.tests.count) parts.push(`${blast.tests.count} test${blast.tests.count === 1 ? '' : 's'} to run`);
  }
  return parts.length ? `This change ${parts.join(', ')}.` : 'No structural changes detected.';
}

function mdList(items: string[], cap = 12): string[] {
  const out = items.slice(0, cap).map(i => `- ${i}`);
  if (items.length > cap) out.push(`- …and ${items.length - cap} more`);
  return out;
}

/** Render the full briefing as a Markdown PR comment. First line is the sticky marker. */
export function renderMarkdown(b: ReviewBriefing): string {
  const L: string[] = [];
  L.push(REVIEW_MARKER);
  L.push('## 🔭 OpenLore structural review');
  L.push('');
  L.push(`**${headline(b)}**`);
  L.push('');
  L.push(`<sub>Deterministic structural analysis (no LLM) of \`${b.base}…${b.head}\`.</sub>`);
  L.push('');

  const s = b.structural;
  if (s.error) {
    L.push(`> ⚠ Structural delta unavailable: ${s.error}`);
    L.push('');
  } else if (s.summary) {
    // ── Structural delta ───────────────────────────────────────────────────────
    const removed = s.removed ?? [];
    const added = s.added ?? [];
    const sig = s.signatureChanged ?? [];
    const renames = s.renameCandidates ?? [];
    if (removed.length || added.length || sig.length || renames.length) {
      L.push('### Structural delta');
      if (removed.length) {
        L.push(...mdList(removed.map(r => {
          const stale = (r.staleCallers?.length ?? 0);
          return `**Removed** \`${clip(r.name)}\` (${clip(fileName(r.file))})${stale ? ` — ${stale} caller${stale === 1 ? '' : 's'} now dangling` : ''}`;
        })));
      }
      if (sig.length) {
        L.push(...mdList(sig.map(c => {
          const stale = (c.staleCallers?.length ?? 0);
          return `**Signature changed** \`${clip(c.name)}\` (${clip(fileName(c.file))})${stale ? ` — ${stale} caller${stale === 1 ? '' : 's'} may be stale` : ''}`;
        })));
      }
      if (added.length) {
        L.push(...mdList(added.map(a => `**Added** \`${clip(a.name)}\` (${clip(fileName(a.file))})`)));
      }
      if (renames.length) {
        L.push(...mdList(renames.map(r => `**Renamed/moved** \`${clip(r.from.name)}\` → \`${clip(r.to.name)}\` (${clip(r.confidence, 24)})`)));
      }
      L.push('');
    } else if (s.message) {
      L.push(`_${s.message}_`);
      L.push('');
    }
  }

  // ── Blast radius ─────────────────────────────────────────────────────────────
  const blast = b.blast;
  if ('error' in blast) {
    L.push(`> ⚠ Blast radius unavailable: ${blast.error}`);
    L.push('');
  } else {
    const hasImpact = blast.impact.hubsTouched.length || blast.impact.layersCrossed.length ||
      blast.impact.governingDecisions.length || blast.tests.count;
    if (hasImpact) {
      L.push('### Blast radius');
      if (blast.impact.hubsTouched.length) {
        L.push(`- **Hubs touched:** ${inlineList(blast.impact.hubsTouched.map(h => `\`${clip(h.symbol)}\` (${h.fanIn} callers)`))}`);
      }
      if (blast.impact.layersCrossed.length) {
        L.push(`- **Layers crossed:** ${inlineList(blast.impact.layersCrossed.map(l => clip(l, 60)))}`);
      }
      if (blast.impact.governingDecisions.length) {
        L.push(`- **Governing decisions:** ${inlineList(blast.impact.governingDecisions.map(d => clip(d, 200)), INLINE_CAP, '; ')}`);
      }
      if (blast.tests.count) {
        const tests = blast.tests.toRun.slice(0, 10).map(t => `\`${t.test}\``).join(', ');
        L.push(`- **Tests to run (${blast.tests.count}):** ${tests}${blast.tests.count > 10 ? ', …' : ''}`);
      }
      L.push('');
    }

    // ── Drift this change introduces (from the blast briefing) ─────────────────
    // Conclusion-shaped: cap each category and summarise the tail, so a wide change
    // (many ADRs reference a touched domain) stays a briefing, not a wall of text.
    const DRIFT_CAP = 5;
    const driftLines: string[] = [];
    for (const m of blast.memory.willDrift.slice(0, DRIFT_CAP)) {
      driftLines.push(`**Memory** ${m.kind === 'memory-orphaned' ? 'orphaned' : 'drifted'}: ${clip(m.message, 200)}`);
    }
    const memExtra = blast.memory.drifted + blast.memory.orphaned - Math.min(blast.memory.willDrift.length, DRIFT_CAP);
    if (memExtra > 0) driftLines.push(`…and ${memExtra} more anchored memor${memExtra === 1 ? 'y' : 'ies'}`);
    for (const d of blast.decisions.items.slice(0, DRIFT_CAP)) driftLines.push(`**Decision** ${d.kind}: ${clip(d.message, 200)}`);
    if (blast.decisions.affected > Math.min(blast.decisions.items.length, DRIFT_CAP)) {
      driftLines.push(`…and ${blast.decisions.affected - Math.min(blast.decisions.items.length, DRIFT_CAP)} more decision issue(s)`);
    }
    for (const sp of blast.specs.items.slice(0, DRIFT_CAP)) driftLines.push(`**Spec** ${sp.kind}: ${clip(sp.message, 200)}`);
    if (blast.specs.willGoStale > Math.min(blast.specs.items.length, DRIFT_CAP)) {
      driftLines.push(`…and ${blast.specs.willGoStale - Math.min(blast.specs.items.length, DRIFT_CAP)} more spec issue(s)`);
    }
    if (driftLines.length) {
      L.push('### Drift introduced by this change');
      L.push(...driftLines.map(d => `- ${d}`));
      L.push('');
    }
  }

  if (b.caveats.length) {
    L.push('### Notes');
    L.push(...b.caveats.map(c => `- ${c}`));
    L.push('');
  }

  L.push('<sub>Advisory — informational, never a gate (unless your repo opts into `blastRadius.block`). Generated by [OpenLore](https://github.com/clay-good/OpenLore) `openlore review`.</sub>');
  const out = L.join('\n') + '\n';
  // Final safety net: GitHub rejects a comment body over MAX_MARKDOWN_CHARS (422). The
  // per-item clips + inline caps make this practically unreachable, but a degenerate diff
  // must never produce an un-postable briefing. Head-truncate (the sticky marker is line 1,
  // so it survives) and append a clear notice.
  if (out.length > MAX_MARKDOWN_CHARS) {
    const notice = '\n\n<sub>⚠ Briefing truncated to fit GitHub\'s comment size limit — run `openlore review` locally for the full output.</sub>\n';
    return out.slice(0, MAX_MARKDOWN_CHARS - notice.length) + notice;
  }
  return out;
}

/** Compact terminal rendering (human-readable, to stdout). */
export function renderHuman(b: ReviewBriefing): string {
  const L: string[] = [];
  L.push('');
  L.push('🔭 OpenLore structural review');
  L.push('   ' + headline(b));
  const s = b.structural;
  if (s.error) L.push(`   ⚠ structural delta: ${s.error}`);
  else if (s.summary) {
    const { removedFunctions: rm, addedFunctions: ad, signatureChanges: sc, staleCallers: st, renameCandidates: rc } = s.summary;
    L.push(`   Delta: ${rm} removed, ${ad} added, ${sc} sig change(s), ${st} stale caller(s), ${rc} rename(s)`);
  }
  const blast = b.blast;
  if ('error' in blast) L.push(`   ⚠ blast radius: ${blast.error}`);
  else {
    if (blast.impact.hubsTouched.length) L.push('   Hubs: ' + blast.impact.hubsTouched.map(h => `${h.symbol} (${h.fanIn})`).join(', '));
    if (blast.impact.layersCrossed.length) L.push('   Layers crossed: ' + blast.impact.layersCrossed.join(', '));
    if (blast.tests.count) L.push(`   Tests to run (${blast.tests.count}): ${blast.tests.toRun.slice(0, 8).map(t => t.test).join(', ')}${blast.tests.count > 8 ? ', …' : ''}`);
    if (blast.impact.governingDecisions.length) L.push('   Governing decisions: ' + blast.impact.governingDecisions.join('; '));
  }
  for (const c of b.caveats) L.push(`   ⚠ ${c}`);
  L.push('');
  return L.join('\n');
}

export interface ReviewCliOptions {
  cwd?: string;
  base?: string;
  head?: string;
  format?: 'markdown' | 'json';
  out?: string;
  /** Hook/gating mode: honor `blastRadius.block` and exit non-zero on a triggered pattern. */
  hook?: boolean;
}

export async function runReviewCli(opts: ReviewCliOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const format = opts.format ?? 'markdown';

  const briefing = await composeReview({ cwd, base: opts.base, head: opts.head });

  const rendered = format === 'json'
    ? JSON.stringify(briefing, null, 2) + '\n'
    : renderMarkdown(briefing);

  if (opts.out) {
    // Never throw (advisory contract): if the path is unwritable, say so on stderr and
    // fall back to stdout so the briefing is not lost. Diagnostics stay off stdout.
    try {
      await writeFile(opts.out, rendered, 'utf-8');
      process.stderr.write(`[ok] Wrote review briefing to ${opts.out}\n`);
    } catch (err) {
      process.stderr.write(`[warn] Could not write ${opts.out} (${err instanceof Error ? err.message : String(err)}); writing to stdout instead.\n`);
      await writeStdout(rendered);
    }
  } else if (format === 'json') {
    // Await the flush: a large JSON briefing piped to a consumer is truncated at the
    // ~64KB pipe buffer if process.exit() races the async write (see writeStdout).
    await writeStdout(rendered);
  } else {
    // Markdown to stdout (so the CI Action can capture it); a compact human summary
    // to stderr so an interactive run is readable without scraping the markdown.
    await writeStdout(rendered);
    if (process.stderr.isTTY) process.stderr.write(renderHuman(briefing) + '\n');
  }

  // Opt-in gating: reuse the exact `blastRadius.block` convention — no second config
  // dialect. Advisory unless --hook AND a configured pattern actually fires.
  if (opts.hook && !('error' in briefing.blast)) {
    let block: BlastRadiusBlockPattern[] = [];
    try {
      const config = await readOpenLoreConfig(cwd);
      const raw = config?.blastRadius?.block;
      block = Array.isArray(raw) ? raw : [];
    } catch { block = []; }
    const fired = triggeredBlockPatterns(briefing.blast, block);
    if (fired.length > 0) {
      process.stderr.write(`\n⛔ openlore review: gated by configured high-risk pattern(s): ${fired.join(', ')}.\n\n`);
      return 1;
    }
  }
  return 0;
}

export const reviewCommand = new Command('review')
  .description('Deterministic structural PR review: structural delta + blast radius as a Markdown briefing (advisory). Composes structural_diff + blast_radius — no LLM.')
  .option('--base <ref>', 'Base git ref to compare against (default: auto-detected — requested → main → master → HEAD~1)')
  .option('--head <ref>', 'Head git ref (default: working tree)')
  .option('--format <fmt>', 'Output format: markdown (default) or json', 'markdown')
  .option('--out <path>', 'Write the briefing to a file instead of stdout')
  .option('--hook', 'Honor blastRadius.block and exit non-zero on a triggered high-risk pattern', false)
  .action(async (opts: { base?: string; head?: string; format?: string; out?: string; hook?: boolean }) => {
    const format = opts.format === 'json' ? 'json' : 'markdown';
    if (opts.format && opts.format !== 'json' && opts.format !== 'markdown') {
      logger.error(`Unknown --format "${opts.format}". Use "markdown" or "json".`);
      process.exit(2);
    }
    // A non-git directory cannot produce a review at all — say so cleanly on stderr
    // (exit 0, advisory) so stdout stays empty rather than carrying a marker-less,
    // non-markdown line that a `review > out.md` consumer would capture.
    if (!(await isGitRepository(process.cwd()).catch(() => false))) {
      process.stderr.write('[warn] openlore review: not a git repository — nothing to compare. Run inside a git repo.\n');
      process.exit(0);
    }
    const code = await runReviewCli({
      base: opts.base,
      head: opts.head,
      format,
      out: opts.out,
      hook: opts.hook,
    });
    process.exit(code);
  });
