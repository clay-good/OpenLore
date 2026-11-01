/**
 * get_handoff_briefing — session succession as a computed receipt (change: add-session-handoff-briefing).
 *
 * When a session ends mid-change (context exhausted, cleared, compacted, or moved), the successor
 * should not have to trust a prose summary. This composes the in-flight state from existing
 * lookups into one deterministic briefing: the same repository state gives the same bytes.
 *
 *   1. touched symbols: the working-tree diff's changed symbols (with callers, via `blast_radius`)
 *      and, when a session ledger is live, the symbols this session edited and already committed;
 *   2. anchored memories and decisions in scope: fresh ones listed, drifted ones flagged, orphaned
 *      ones withheld and counted (the recall discipline);
 *   3. drifted specs, and the open `openspec/changes/*` whose proposal or tasks name a touched file,
 *      with their unchecked task lines quoted;
 *   4. the tests that reach the touched set;
 *   5. unfinished receipts: uncommitted files (staged, unstaged, untracked), the index lease, and
 *      the session ledger's open facts.
 *
 * Every element carries `expand`: the tool call that returns its full detail, so the successor pays
 * only for what it needs. A token budget trims the least central sections first, each with an
 * omission receipt. Nothing is persisted, and no conversation transcript is read.
 *
 * NoRedundantConclusions: `blast_radius` reviews a pending diff, `briefing_since` catches up on
 * others' landed changes, and `orient` starts a session; this one hands an in-flight change over.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDirectory } from './utils.js';
import { execFileGit } from '../../../utils/git-exec.js';
import { gitPathArgs } from '../../../utils/git-args.js';
import { readOpenLoreConfig } from '../config-manager.js';

export interface HandoffInput {
  directory: string;
  /** Approximate token budget for the whole briefing (default 1,500; 300–8,000). */
  tokenBudget?: number;
}

interface Expand { tool: string; args: Record<string, unknown> }

interface TouchedSymbol { symbol: string; file: string; callers?: number; hub?: boolean; committedThisSession?: true; expand: Expand }
interface InScopeFact { kind: 'memory' | 'decision'; id: string; text: string; freshness: 'fresh' | 'drifted'; expand: Expand }
interface OpenChange { change: string; mentions: string[]; uncheckedTasks: string[]; expand: Expand }

const DEFAULT_BUDGET = 1500;
const MAX_CHANGE_FILE_BYTES = 64 * 1024;
const MAX_TASKS_QUOTED = 10;

const sortBy = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Uncommitted files, split as git reports them (porcelain v1, NUL-separated). */
async function uncommitted(root: string): Promise<{ staged: string[]; unstaged: string[]; untracked: string[] }> {
  const out = { staged: [] as string[], unstaged: [] as string[], untracked: [] as string[] };
  // Porcelain paths are repository-relative; the briefing's are relative to this root.
  const { getRepoPrefix } = await import('../../drift/git-diff.js');
  const prefix = (await getRepoPrefix(root)) ?? '';
  try {
    const { stdout } = await execFileGit('git', gitPathArgs('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'), { cwd: root });
    const recs = String(stdout).split('\0');
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.length < 4) continue;
      const [x, y, repoPath] = [r[0], r[1], r.slice(3)];
      if (prefix && !repoPath.startsWith(prefix)) continue;
      const path = repoPath.slice(prefix.length);
      if (x === 'R' || x === 'C') i++; // the next record is the rename source
      if (path === '.openlore' || path.startsWith('.openlore/')) continue; // OpenLore's own state, not work
      if (x === '?' && y === '?') { out.untracked.push(path); continue; }
      if (x !== ' ') out.staged.push(path);
      if (y !== ' ') out.unstaged.push(path);
    }
  } catch { /* not a git repository: nothing uncommitted can be listed */ }
  for (const k of ['staged', 'unstaged', 'untracked'] as const) out[k] = [...new Set(out[k])].sort();
  return out;
}

/** Open change folders that name a touched file, with their unchecked tasks. */
async function openChanges(root: string, touchedFiles: readonly string[]): Promise<OpenChange[]> {
  let openspec = 'openspec';
  try { openspec = (await readOpenLoreConfig(root))?.openspecPath?.replace(/^\.\//, '') || 'openspec'; } catch { /* default */ }
  const dir = join(root, openspec, 'changes');
  let names: string[];
  try { names = (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory() && d.name !== 'archive').map(d => d.name).sort(); } catch { return []; }
  const out: OpenChange[] = [];
  for (const name of names) {
    let text = '';
    let tasks = '';
    for (const f of ['proposal.md', 'tasks.md', 'design.md']) {
      try {
        const t = (await readFile(join(dir, name, f), 'utf-8')).slice(0, MAX_CHANGE_FILE_BYTES);
        text += t + '\n';
        if (f === 'tasks.md') tasks = t;
      } catch { /* absent */ }
    }
    const mentions = touchedFiles.filter(file => text.includes(file)).sort();
    if (!mentions.length) continue;
    const unchecked = tasks.split('\n').filter(l => /^\s*-\s*\[ \]/.test(l)).map(l => l.trim().replace(/^-\s*\[ \]\s*/, ''));
    out.push({
      change: name,
      mentions,
      uncheckedTasks: unchecked.slice(0, MAX_TASKS_QUOTED),
      expand: { tool: 'read', args: { path: `${openspec}/changes/${name}/tasks.md` } },
    });
  }
  return out;
}

/** Memories and decisions anchored to a touched file: fresh listed, drifted flagged, orphaned withheld. */
async function inScopeFacts(root: string, touchedFiles: ReadonlySet<string>): Promise<{ facts: InScopeFact[]; orphanedWithheld: number }> {
  const facts: InScopeFact[] = [];
  let orphanedWithheld = 0;
  try {
    const [{ loadMemoryStore }, { loadDecisionStore, INACTIVE_STATUSES }, { AnchorContext }, { memoryFreshness, decisionAnchors }, { isWellFormedMemory }] = await Promise.all([
      import('../../decisions/memory-store.js'),
      import('../../decisions/store.js'),
      import('../../decisions/anchor-adapter.js'),
      import('../../decisions/anchor.js'),
      import('./memory-triggers.js'),
    ]);
    const [mem, dec] = await Promise.all([loadMemoryStore(root), loadDecisionStore(root)]);
    const ctx = AnchorContext.open(root);
    const view = ctx ? ctx.freshnessView() : { nodeHash: () => undefined, fileExists: () => false, fileHash: () => undefined };
    try {
      const touches = (anchors: ReadonlyArray<{ filePath: string }>) => anchors.some(a => touchedFiles.has(a.filePath));
      for (const m of mem.memories.filter(isWellFormedMemory)) {
        if (m.invalidatedAt || !touches(m.anchors)) continue;
        const f = memoryFreshness(m.anchors, view).freshness;
        if (f === 'orphaned') { orphanedWithheld++; continue; }
        facts.push({ kind: 'memory', id: m.id, text: m.content.slice(0, 300), freshness: f === 'fresh' ? 'fresh' : 'drifted', expand: { tool: 'recall', args: { task: m.anchors[0]?.symbolName ?? m.anchors[0]?.filePath ?? m.id } } });
      }
      for (const d of dec.decisions) {
        if (INACTIVE_STATUSES.has(d.status)) continue;
        const anchors = decisionAnchors(d);
        if (!touches(anchors)) continue;
        const f = memoryFreshness(anchors, view).freshness;
        if (f === 'orphaned') { orphanedWithheld++; continue; }
        facts.push({ kind: 'decision', id: d.id, text: d.title, freshness: f === 'fresh' ? 'fresh' : 'drifted', expand: { tool: 'verify_claim', args: { kind: 'decision-current', subject: d.id } } });
      }
    } finally {
      ctx?.close();
    }
  } catch { /* no stores: nothing in scope */ }
  facts.sort(sortBy(f => `${f.kind}\0${f.id}`));
  return { facts, orphanedWithheld };
}

/** Rough token count of a section (four characters a token). */
const tokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

/**
 * Fit the sections into the budget: the least central sections are trimmed first (receipts, then
 * specs, memories, tests, open changes; touched symbols last), each trimmed list gaining an
 * omission receipt that names the call returning the rest.
 */
function fitBudget(b: Record<string, unknown>, budget: number): Record<string, unknown> {
  const order: Array<{ key: string; expand: Expand }> = [
    { key: 'driftedSpecs', expand: { tool: 'check_spec_drift', args: {} } },
    { key: 'inScope', expand: { tool: 'recall', args: {} } },
    { key: 'testsToRun', expand: { tool: 'select_tests', args: { diffRef: 'HEAD' } } },
    { key: 'openChanges', expand: { tool: 'read', args: { path: 'openspec/changes' } } },
    { key: 'touched', expand: { tool: 'blast_radius', args: { baseRef: 'HEAD' } } },
  ];
  const omitted: Record<string, { omitted: number; expand: Expand }> = {};
  for (const { key, expand } of order) {
    const list = b[key];
    if (!Array.isArray(list)) continue;
    while (tokens(b) > budget && list.length > 1) {
      list.pop();
      omitted[key] = { omitted: (omitted[key]?.omitted ?? 0) + 1, expand };
    }
  }
  return Object.keys(omitted).length ? { ...b, truncated: omitted } : b;
}

export async function handleGetHandoffBriefing(input: HandoffInput): Promise<Record<string, unknown>> {
  const root = await validateDirectory(input.directory);
  const budget = Math.max(300, Math.min(input.tokenBudget ?? DEFAULT_BUDGET, 8000));
  const files = await uncommitted(root);

  const { readLiveLedger } = await import('../session-ledger.js');
  const live = readLiveLedger(root);
  const ledger = 'ledger' in live ? live.ledger : undefined;
  const { computeStaleness } = await import('./confidence-boundary.js');
  const staleness = await computeStaleness(root);
  const lease = staleness
    ? { index: 'behind', indexCommit: staleness.indexCommit, filesChangedSince: staleness.filesChangedSince }
    : { index: 'current' };

  const workingFiles = [...new Set([...files.staged, ...files.unstaged, ...files.untracked])].sort();
  const committedEdits = (ledger?.edited ?? []).filter(e => !workingFiles.includes(e.file));
  if (!workingFiles.length && !committedEdits.length) {
    return {
      tool: 'get_handoff_briefing',
      inFlight: false,
      message: 'Nothing is in flight: the working tree is clean and no session ledger records edits this session.',
      lease,
      ...(ledger ? {} : { ledger: 'withheld' in live ? live.withheld : 'none' }),
    };
  }

  // ── Touched symbols, tests, drift: blast_radius over the working tree ──
  const { computeBlastRadius } = await import('./blast-radius.js');
  const br = workingFiles.length ? await computeBlastRadius({ directory: root, baseRef: 'HEAD' }) : undefined;
  const boundaries: string[] = [];
  const touched: TouchedSymbol[] = [];
  let tests: Array<{ test: string; file: string }> = [];
  let driftedSpecs: Array<{ domain: string | null; message: string; expand: Expand }> = [];
  if (br && 'error' in br) boundaries.push(`The working-tree diff could not be analyzed: ${br.error}`);
  else if (br) {
    const seen = new Set<string>();
    for (const s of br.impact.topSymbols) {
      seen.add(s.symbol);
      touched.push({ symbol: s.symbol, file: s.file, callers: s.affectedCallers, ...(s.isHub ? { hub: true } : {}), expand: { tool: 'get_subgraph', args: { functionName: s.symbol, direction: 'upstream' } } });
    }
    for (const name of br.changed.symbolNames) {
      if (!seen.has(name)) touched.push({ symbol: name, file: '', expand: { tool: 'get_function_body', args: { functionName: name } } });
    }
    tests = br.tests.toRun.map(t => ({ test: t.test, file: t.file }));
    if (br.tests.unavailable) boundaries.push(`Tests to run could not be computed: ${br.tests.unavailable}`);
    driftedSpecs = br.specs.items.map(i => ({ domain: i.domain, message: i.message, expand: { tool: 'get_spec', args: { domain: i.domain ?? '' } } }));
    if (br.confidenceBoundary) boundaries.push('The index is behind the working tree; touched symbols and tests are a lower bound until re-analyze.');
  }

  // ── Committed this session (session ledger) ──
  for (const e of committedEdits) touched.push({ symbol: e.name, file: e.file, committedThisSession: true, expand: { tool: 'get_function_body', args: { functionName: e.name, filePath: e.file } } });
  if (committedEdits.length) {
    try {
      const { handleSelectTests } = await import('./test-impact.js');
      const sel = await handleSelectTests({ directory: root, changedSymbols: [...new Set(committedEdits.map(e => e.name))].slice(0, 50) }) as { selectedTests?: Array<{ test: string; file: string }> };
      tests.push(...(sel.selectedTests ?? []).map(t => ({ test: t.test, file: t.file })));
    } catch { boundaries.push('Tests reaching the symbols committed this session could not be computed.'); }
  }
  touched.sort(sortBy(t => `${t.file}\0${t.symbol}`));
  tests = [...new Map(tests.map(t => [`${t.file}\0${t.test}`, t])).values()].sort(sortBy(t => `${t.file}\0${t.test}`));
  driftedSpecs.sort(sortBy(s => `${s.domain ?? ''}\0${s.message}`));

  const touchedFiles = [...new Set([...workingFiles, ...committedEdits.map(e => e.file)])].sort();
  const scope = await inScopeFacts(root, new Set(touchedFiles));
  const changes = await openChanges(root, touchedFiles);
  if (scope.orphanedWithheld) boundaries.push(`${scope.orphanedWithheld} anchored memory or decision record(s) in scope were orphaned by these edits and are withheld; \`recall\` lists them.`);
  if (!ledger) boundaries.push(`No session ledger: only the working tree is in the touched set (${'withheld' in live ? live.withheld : 'none'}).`);

  const briefing: Record<string, unknown> = {
    tool: 'get_handoff_briefing',
    inFlight: true,
    touched,
    openChanges: changes,
    testsToRun: tests,
    inScope: scope.facts,
    driftedSpecs,
    unfinished: {
      uncommitted: files,
      lease,
      ...(ledger && (ledger.backgroundChanges.length || ledger.editOscillation.length)
        ? { ledger: { backgroundChanges: ledger.backgroundChanges.map(c => ({ name: c.name, file: c.file })), editOscillation: ledger.editOscillation.map(o => ({ name: o.name, file: o.file, returns: o.returns })) } }
        : {}),
    },
    ...(boundaries.length ? { boundaries: boundaries.sort() } : {}),
    note: 'Computed from the repository (no transcript). Each element\'s `expand` is the call that returns its detail.',
  };
  return fitBudget(briefing, budget);
}

/** A plain-text rendering for a hook or a terminal. */
export function renderHandoff(b: Record<string, unknown>): string {
  if (b.inFlight !== true) return `[openlore handoff] ${String(b.message ?? 'Nothing is in flight.')}`;
  const lines: string[] = ['[openlore handoff] In-flight work in this repository:'];
  const list = <T>(key: string) => (Array.isArray(b[key]) ? b[key] as T[] : []);
  const touched = list<TouchedSymbol>('touched');
  if (touched.length) lines.push(`Touched: ${touched.map(t => `${t.symbol}${t.file ? ` (${t.file})` : ''}${t.committedThisSession ? ' [committed this session]' : ''}${t.callers ? ` — ${t.callers} caller(s)` : ''}`).join('; ')}.`);
  for (const c of list<OpenChange>('openChanges')) {
    lines.push(`Open change ${c.change} names ${c.mentions.join(', ')}${c.uncheckedTasks.length ? `; unchecked: ${c.uncheckedTasks.map(t => `"${t}"`).join('; ')}` : ''}.`);
  }
  const tests = list<{ test: string; file: string }>('testsToRun');
  if (tests.length) lines.push(`Tests to run: ${tests.map(t => (t.test === '*' ? t.file : t.test)).join(', ')}.`);
  const facts = list<InScopeFact>('inScope');
  if (facts.length) lines.push(`In scope: ${facts.map(f => `${f.kind} ${f.id}${f.freshness === 'drifted' ? ' (drifted)' : ''}: ${f.text}`).join(' | ')}.`);
  const specs = list<{ domain: string | null; message: string }>('driftedSpecs');
  if (specs.length) lines.push(`Specs that may go stale: ${specs.map(s => `${s.domain ?? '?'} — ${s.message}`).join('; ')}.`);
  const u = b.unfinished as { uncommitted?: { staged: string[]; unstaged: string[]; untracked: string[] } } | undefined;
  if (u?.uncommitted) lines.push(`Uncommitted: ${u.uncommitted.staged.length} staged, ${u.uncommitted.unstaged.length} unstaged, ${u.uncommitted.untracked.length} untracked.`);
  for (const note of Array.isArray(b.boundaries) ? b.boundaries as string[] : []) lines.push(`Note: ${note}`);
  if (b.truncated) lines.push('Some lists were cut to the budget; `openlore handoff --json` names the call that returns each.');
  return lines.join('\n');
}
