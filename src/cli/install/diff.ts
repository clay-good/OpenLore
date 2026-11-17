/**
 * Tiny line-oriented diff helper used to populate `--dry-run` previews.
 *
 * This is not a full Myers diff — it's the cheapest output that still lets a user see what
 * `openlore install --dry-run` would do without us shelling out to `diff(1)`. The result is
 * meant for human eyeballing, not machine consumption.
 *
 * PRIVACY IS THE DESIGN CONSTRAINT HERE, not brevity (change: fix-install-never-blocks-by-default).
 * These previews render the user's `~/.claude.json` and `~/.claude/settings.json`, which routinely
 * hold an `signedInAccount` block and per-MCP-server `env` blocks with provider API keys. The previous
 * implementation trimmed only the common PREFIX and SUFFIX, so one changed line near the top and
 * one near the bottom made the whole untouched middle of the file "the changed region" — a
 * re-ordered `mcpServers.openlore` key was enough to print ~11 KB of unrelated private
 * configuration, twice (once as `-`, once as `+`), on a command that looks read-only.
 *
 * Two rules follow, and `diff.test.ts` pins both:
 *
 * 1. Only the ACTUAL changed hunks are printed, each inside a bounded context window. An
 *    untouched key far from any change is never rendered, whatever its position in the file.
 * 2. Every line that is rendered goes through the repository's own secret redaction first, so a
 *    credential that genuinely sits inside a changed hunk is still never echoed.
 */

import { redactSecretString } from '../../core/services/secret-redaction.js';

/** Hard cap on rendered body lines, per preview. */
const MAX_PREVIEW_LINES = 60;
/** Unchanged lines rendered on each side of a hunk, so a change is readable in context. */
const HUNK_CONTEXT_LINES = 2;
/** Hunks rendered before the rest are summarized as a count. */
const MAX_HUNKS = 6;
/**
 * Cells the LCS table may use. The input is already the common-prefix/suffix-trimmed region, so
 * this is reached only by a file that changed almost everywhere; past it the preview degrades to a
 * bounded head of the region with a receipt, never to an unbounded dump.
 */
const LCS_CELL_BUDGET = 250_000;

/** Redact, then prefix. One funnel: nothing reaches a preview without passing through here. */
function render(marker: string, line: string): string {
  return `${marker}${redactSecretString(line)}`;
}

export function previewCreate(filePath: string, content: string): string {
  const lines = content.split('\n');
  const truncated = lines.length > MAX_PREVIEW_LINES;
  const shown = truncated ? lines.slice(0, MAX_PREVIEW_LINES) : lines;
  const body = shown.map((l) => render('+ ', l)).join('\n');
  const suffix = truncated ? `\n  ... (${lines.length - MAX_PREVIEW_LINES} more lines)` : '';
  return `--- (new file) ${filePath}\n${body}${suffix}`;
}

type Op = { kind: 'equal'; a: number } | { kind: 'del'; a: number } | { kind: 'ins'; b: number };

/**
 * Line-level LCS over the trimmed region. Returns `null` when the region is too large to
 * diff within {@link LCS_CELL_BUDGET} — the caller degrades honestly rather than guessing.
 */
function lcsOps(a: readonly string[], b: readonly string[]): Op[] | null {
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_BUDGET) return null;
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: 'equal', a: i }); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push({ kind: 'del', a: i++ });
    else ops.push({ kind: 'ins', b: j++ });
  }
  while (i < a.length) ops.push({ kind: 'del', a: i++ });
  while (j < b.length) ops.push({ kind: 'ins', b: j++ });
  return ops;
}

interface Hunk {
  /** Index into `ops` of the first op rendered (context included). */
  start: number;
  /** Index into `ops` one past the last op rendered. */
  end: number;
  /** Line number in the BEFORE file of the hunk's first CHANGED line (1-based). */
  anchor: number;
}

/** Group changed ops into hunks, each padded by at most {@link HUNK_CONTEXT_LINES} equal ops. */
function groupHunks(ops: readonly Op[], prefix: number): Hunk[] {
  const hunks: Hunk[] = [];
  // Before-file lines consumed by the ops BEFORE this one (an insertion consumes none),
  // accumulated in one pass so each anchor is exact without re-scanning.
  let consumed = 0;
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (op.kind === 'equal') { consumed++; continue; }
    const anchor = prefix + consumed + 1;
    if (op.kind === 'del') consumed++;
    const last = hunks[hunks.length - 1];
    // Merge when the gap would otherwise print the same equal lines twice.
    if (last && index - last.end <= HUNK_CONTEXT_LINES * 2) {
      last.end = Math.min(ops.length, index + 1 + HUNK_CONTEXT_LINES);
      continue;
    }
    hunks.push({
      start: Math.max(0, index - HUNK_CONTEXT_LINES),
      end: Math.min(ops.length, index + 1 + HUNK_CONTEXT_LINES),
      anchor,
    });
  }
  return hunks;
}

export function previewDiff(filePath: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');

  // Trim the common prefix and suffix first: it is cheap, and it bounds the LCS input.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return `--- ${filePath}\n  (no textual change)`;
  }

  const ops = lcsOps(removed, added);
  if (!ops) {
    // Too large to diff precisely. Print a bounded HEAD of the changed region and say so —
    // never the whole region, which is the leak this function exists to prevent.
    const half = Math.floor(MAX_PREVIEW_LINES / 2);
    const parts = [`--- ${filePath} @ line ${prefix + 1}`];
    for (const line of removed.slice(0, half)) parts.push(render('- ', line));
    for (const line of added.slice(0, half)) parts.push(render('+ ', line));
    parts.push(
      `  ... (changed region is ${removed.length} removed / ${added.length} added lines — too large `
      + 'to diff precisely; showing the first lines only)',
    );
    return parts.join('\n');
  }

  const hunks = groupHunks(ops, prefix);
  const parts: string[] = [`--- ${filePath} @ line ${hunks[0]?.anchor ?? prefix + 1}`];
  let body = 0;
  let renderedHunks = 0;
  for (const hunk of hunks) {
    if (renderedHunks >= MAX_HUNKS || body >= MAX_PREVIEW_LINES) break;
    if (renderedHunks > 0) parts.push(`  ... @ line ${hunk.anchor}`);
    for (let index = hunk.start; index < hunk.end && body < MAX_PREVIEW_LINES; index++) {
      const op = ops[index];
      if (op.kind === 'equal') parts.push(render('  ', removed[op.a]));
      else if (op.kind === 'del') parts.push(render('- ', removed[op.a]));
      else parts.push(render('+ ', added[op.b]));
      body++;
    }
    renderedHunks++;
  }
  if (renderedHunks < hunks.length) {
    parts.push(`  ... (${hunks.length - renderedHunks} more changed hunk(s) not shown)`);
  }
  return parts.join('\n');
}
