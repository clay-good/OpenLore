/**
 * `openlore hook <moment>` (change: add-agent-loop-hook-surfaces).
 *
 * One command per moment of the agent loop, wired by `openlore install` into the harness's hook
 * events, so the agent receives OpenLore's deterministic receipts without having to call a tool:
 *
 * | Moment        | Claude Code event            | Receipt                                                     |
 * |---------------|------------------------------|-------------------------------------------------------------|
 * | `before-edit` | `PreToolUse` (edit tools)    | the target is a generated file: its source and command      |
 * | `after-tools` | `PostToolUse` (edit tools)   | the edit recorded for the session ledger; new ledger facts; |
 * |               |                              | generated-file, phantom-reference and check-weakening facts |
 * |               |                              | for the edited file                                         |
 * | `before-stop` | `Stop`                       | the `verify_change` receipt for the session's diff, shown   |
 * |               |                              | to the user; the agent sees it only as a policy block       |
 *
 * Every hook reads the harness payload from stdin and prints at most one budgeted receipt as the
 * event's `additionalContext`; it prints nothing when it has nothing new. A fact already delivered
 * under the payload's `session_id` is not repeated. Hooks are advisory: they exit 0, and on a
 * timeout or an error they print nothing. Only a finding code the repository's `enforcement.policy`
 * makes blocking can block, and only at `before-stop`. A moment is turned off with
 * `hooks.<moment>: false` in `.openlore/config.json`.
 */

import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readStdin } from '../../utils/stdin.js';
import { withLoggerOptions } from '../../utils/logger.js';
import { atomicWriteFile } from '../../core/decisions/atomic-store.js';
import { OPENLORE_DIR } from '../../constants.js';

export const HOOK_MOMENTS = ['before-edit', 'after-tools', 'before-stop'] as const;
export type HookMoment = typeof HOOK_MOMENTS[number];

/** The harness event each moment is wired to (Claude Code). */
export const HOOK_EVENT: Record<HookMoment, string> = {
  'before-edit': 'PreToolUse',
  'after-tools': 'PostToolUse',
  'before-stop': 'Stop',
};

/** Per-moment budget, in characters of the printed receipt (about four characters a token). */
const BUDGET_CHARS: Record<HookMoment, number> = { 'before-edit': 1600, 'after-tools': 4800, 'before-stop': 8000 };
/** Hard time limit per moment; past it the hook prints nothing. */
const TIMEOUT_MS: Record<HookMoment, number> = { 'before-edit': 8_000, 'after-tools': 15_000, 'before-stop': 50_000 };
const STDIN_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERED = 2000;

const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };

/** One fact for the receipt. `key` identifies it for the per-session dedupe. */
export interface HookItem { key: string; severity: string; text: string; next?: string }

export interface HookPayload {
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  /** Files the tool call writes, as given (absolute or relative). */
  files: string[];
  stopHookActive: boolean;
}

/** Read the fields OpenLore uses from a harness hook payload (Claude Code's shape). */
export function parseHookPayload(raw: string): HookPayload {
  let p: Record<string, unknown> = {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') p = v as Record<string, unknown>;
  } catch { /* an unreadable payload is an empty one */ }
  const input = p.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Record<string, unknown>) : {};
  const files = [input.file_path, input.path, input.notebook_path].filter((f): f is string => typeof f === 'string' && f.length > 0);
  return {
    ...(typeof p.session_id === 'string' && p.session_id ? { sessionId: p.session_id } : {}),
    ...(typeof p.cwd === 'string' && p.cwd ? { cwd: p.cwd } : {}),
    ...(typeof p.tool_name === 'string' ? { toolName: p.tool_name } : {}),
    files: files.slice(0, 1),
    stopHookActive: p.stop_hook_active === true,
  };
}

/**
 * A payload path as a root-relative path with forward slashes, or `undefined` when it is outside
 * the repository. The file need not exist yet (a `Write` of a new file).
 */
export function repoPath(root: string, file: string): string | undefined {
  // A file not written yet resolves through its nearest existing parent.
  const real = (p: string): string => {
    try { return realpathSync(p); } catch {
      const parent = dirname(p);
      return parent === p ? p : join(real(parent), basename(p));
    }
  };
  const abs = real(isAbsolute(file) ? file : resolve(root, file));
  const rel = relative(real(root), abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** Keep the most severe items within the budget; the rest are counted. */
export function renderReceipt(moment: HookMoment, items: HookItem[], budgetChars = BUDGET_CHARS[moment]): string | null {
  return renderShown(moment, items, budgetChars).text;
}

/** The receipt and the keys of the items it shows (only those count as delivered). */
function renderShown(moment: HookMoment, items: HookItem[], budgetChars = BUDGET_CHARS[moment]): { text: string | null; shown: string[] } {
  if (!items.length) return { text: null, shown: [] };
  const sorted = [...items].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  const header = `[openlore ${moment}]`;
  const lines: string[] = [];
  let used = header.length;
  let omitted = 0;
  const shown: string[] = [];
  for (const it of sorted) {
    const line = `- ${it.text}${it.next ? ` (next action: ${it.next})` : ''}`;
    if (used + line.length + 1 > budgetChars) { omitted++; continue; }
    lines.push(line);
    shown.push(it.key);
    used += line.length + 1;
  }
  if (!lines.length) return { text: null, shown: [] };
  if (omitted) lines.push(`- ${omitted} more fact(s) not shown (budget); they are stated on a later call.`);
  return { text: `${header}\n${lines.join('\n')}`, shown };
}

function deliveredDir(root: string): string {
  return join(root, OPENLORE_DIR, 'session-ledger', 'hook-delivered');
}

function deliveredPath(root: string, sessionId: string): string {
  const id = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(deliveredDir(root), `${id}.json`);
}

/** Per harness session: the facts already delivered, and the commit the session started from. */
interface SessionRecord { keys: Set<string>; startHead?: string }

function readSession(root: string, sessionId: string | undefined): SessionRecord {
  if (!sessionId) return { keys: new Set() };
  try {
    const v = JSON.parse(readFileSync(deliveredPath(root, sessionId), 'utf-8')) as { keys?: unknown; startHead?: unknown } | unknown[];
    // Fail-open on an older or foreign shape.
    const keys = Array.isArray(v) ? v : Array.isArray((v as { keys?: unknown }).keys) ? (v as { keys: unknown[] }).keys : [];
    const head = Array.isArray(v) ? undefined : (v as { startHead?: unknown }).startHead;
    return { keys: new Set(keys.filter((x): x is string => typeof x === 'string')), ...(typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head) ? { startHead: head } : {}) };
  } catch {
    return { keys: new Set() };
  }
}

/**
 * Write the session record, merged with what a concurrent hook of the same session wrote meanwhile
 * (the harness runs matching hooks in parallel). Records untouched for a week are removed.
 */
async function writeSession(root: string, sessionId: string | undefined, rec: SessionRecord): Promise<void> {
  if (!sessionId) return;
  try {
    const now = readSession(root, sessionId);
    const keys = [...new Set([...now.keys, ...rec.keys])].slice(-MAX_DELIVERED);
    await atomicWriteFile(deliveredPath(root, sessionId), JSON.stringify({ startHead: now.startHead ?? rec.startHead, keys }));
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const n of readdirSync(deliveredDir(root))) {
      try { if (statSync(join(deliveredDir(root), n)).mtimeMs < cutoff) unlinkSync(join(deliveredDir(root), n)); } catch { /* raced */ }
    }
  } catch { /* dedupe is best-effort: at worst a fact is said twice */ }
}

async function headSha(root: string): Promise<string | undefined> {
  try {
    const { execFileGit } = await import('../../utils/git-exec.js');
    const sha = String((await execFileGit('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root })).stdout).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function repoTop(root: string): Promise<string | undefined> {
  try {
    const { execFileGit } = await import('../../utils/git-exec.js');
    return String((await execFileGit('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Where `root` sits in its git repository (`packages/app/`), so git-based checks get repo paths. */
async function repoPrefix(root: string): Promise<string> {
  const { getRepoPrefix } = await import('../../core/drift/git-diff.js');
  return (await getRepoPrefix(root)) ?? '';
}

/** `before-edit`: the target is generated, vendored, or a lockfile. Reads headers; writes nothing. */
async function beforeEdit(root: string, files: string[]): Promise<HookItem[]> {
  const { classifyGeneratedFiles } = await import('../../core/services/generated-file-guard.js');
  const { facts } = await classifyGeneratedFiles(root, files);
  return [...facts.values()].map(f => ({
    key: `generated:${f.file}`,
    severity: 'warning',
    text: generatedText(f),
    ...(f.kind !== 'lockfile' ? { next: f.regenerateWith !== 'unknown' ? `regenerate with \`${f.regenerateWith}\`` : 'edit the source and regenerate' } : {}),
  }));
}

function generatedText(f: { file: string; kind: string; generatedFrom: string[] | 'unknown'; matched: string }): string {
  if (f.kind === 'lockfile') return `${f.file} is a lockfile; its manifest and the package manager produce it.`;
  const from = f.generatedFrom !== 'unknown' && f.generatedFrom.length ? `, from ${f.generatedFrom.join(', ')}` : ' (source not named)';
  return `${f.file} is ${f.kind === 'vendored' ? 'vendored' : 'generated'} (${f.matched})${from}; a hand edit is lost when it is regenerated.`;
}

/**
 * `after-tools`: record the agent's edit for the session ledger, then the facts new since the last
 * delivery — the live ledger's background changes and edit loops, and for the edited file its
 * generated-file, phantom-reference and check-weakening findings.
 */
async function afterTools(root: string, files: string[], baseline: string | undefined): Promise<HookItem[]> {
  const items: HookItem[] = [];
  const { recordAgentEdit, readLiveLedger } = await import('../../core/services/session-ledger.js');
  for (const f of files) recordAgentEdit(root, f);

  const live = readLiveLedger(root);
  if ('ledger' in live) {
    for (const c of live.ledger.backgroundChanges) {
      items.push({ key: `bg:${c.id}@${c.changedAt}`, severity: 'warning', text: `${c.name} (${c.file}) changed since this session read it (another process's edit).` });
    }
    for (const o of live.ledger.editOscillation) {
      items.push({ key: `loop:${o.id}#${o.returns}`, severity: 'warning', text: `${o.name} (${o.file}) returned to an earlier version ${o.returns} times this session.` });
    }
  }
  if (!files.length) return items;

  items.push(...(await beforeEdit(root, files)));

  if (!baseline) return items; // no commit to compare with (an unborn branch)
  // Compared with the commit this harness session started from: a finding in an earlier commit is
  // not this session's, and is not raised again in every session.
  const prefix = await repoPrefix(root);
  const repoFiles = files.map(f => prefix + f);
  const { classifyFile } = await import('../../core/drift/git-diff.js');
  const changed = repoFiles.map(path => ({ path, status: 'modified' as const, additions: 0, deletions: 0, ...classifyFile(path) }));
  const { checkPhantomReferences } = await import('../../core/services/phantom-references.js');
  const phantom = await checkPhantomReferences(root, baseline, changed).catch(() => undefined);
  for (const f of phantom?.findings ?? []) {
    items.push({ key: `${f.code}:${f.location?.path ?? ''}:${f.subject}`, severity: f.severity, text: f.message, ...(f.remediation ? { next: f.remediation } : {}) });
  }

  const { checkWeakening } = await import('../../core/services/check-weakening.js');
  const top = prefix ? await repoTop(root) : root;
  const weak = top ? await checkWeakening({ root: top, baseRef: baseline, files: repoFiles }).catch(() => undefined) : undefined;
  for (const f of weak?.findings ?? []) items.push({ key: `${f.code}:${f.subject}:${f.discriminator ?? ''}`, severity: f.severity, text: f.message });
  return items;
}

/**
 * `before-stop`: the `verify_change` receipt. Blocks only when `enforcement.policy` makes one of its
 * findings blocking, and never twice in a row (`stop_hook_active`).
 */
async function beforeStop(root: string, baseline: string | undefined): Promise<{ items: HookItem[]; block?: string }> {
  const { handleVerifyChange } = await import('../../core/services/mcp-handlers/verify-change.js');
  const r = await handleVerifyChange({ directory: root, ...(baseline ? { baseRef: baseline } : {}) }) as {
    error?: string;
    items?: Array<{ subject: string; check: string; severity: string; nextAction: string }>;
    findings?: Array<{ code: string; subject: string; message: string; enforcementClass?: string; remediation?: string }>;
    gated?: boolean;
  };
  if (r.error) return { items: [] };
  const items: HookItem[] = (r.items ?? []).map(i => ({ key: `${i.check}:${i.subject}`, severity: i.severity, text: `${i.subject} [${i.check}]`, next: i.nextAction }));
  const blocking = (r.findings ?? []).filter(f => f.enforcementClass === 'blocking');
  if (!r.gated || !blocking.length) return { items };
  const reason = [
    `[openlore before-stop] ${blocking.length} finding(s) are blocking under this repository's enforcement.policy:`,
    ...blocking.map(f => `- ${f.code}: ${f.message}${f.remediation ? ` (next action: ${f.remediation})` : ''}`),
  ].join('\n');
  return { items, block: reason };
}

/**
 * The nearest directory at or above `start` that has `.openlore`, within the same repository: the
 * walk stops at the repository's top (a `.git` entry) and never accepts the home directory, whose
 * `~/.openlore` is OpenLore's user-level store, not a project.
 */
function openloreRoot(start: string): string | undefined {
  const home = resolve(process.env.OPENLORE_HOME ?? homedir());
  for (let dir = start; ; dir = dirname(dir)) {
    if (dir === home) return undefined;
    if (existsSync(join(dir, OPENLORE_DIR))) return dir;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return undefined;
  }
}

/** Whether `hooks.<moment>` is turned off in `.openlore/config.json` (an unreadable config is "on"). */
function momentDisabled(root: string, moment: HookMoment): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(root, OPENLORE_DIR, 'config.json'), 'utf-8')) as { hooks?: Record<string, unknown> };
    return cfg?.hooks?.[moment] === false;
  } catch {
    return false;
  }
}

export interface HookRunResult { stdout: string; exitCode: 0 }

/**
 * Run one moment over a payload. Never throws and always exits 0: a timeout or an error prints
 * nothing. Exported for tests; the CLI prints `stdout`.
 */
export async function runHook(moment: HookMoment, raw: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<HookRunResult> {
  const silent: HookRunResult = { stdout: '', exitCode: 0 };
  const payload = parseHookPayload(raw);
  // The OpenLore root: the nearest directory at or above the session's working directory (the agent
  // may have `cd`-ed into a subdirectory) that has `.openlore`. None: nothing to say.
  const root = openloreRoot(resolve(payload.cwd ?? opts.cwd ?? process.cwd()));
  if (!root) return silent;
  if (momentDisabled(root, moment)) return silent;
  if (moment === 'before-stop' && payload.stopHookActive) return silent;
  const files = payload.files.map(f => repoPath(root, f)).filter((f): f is string => !!f);
  if (moment === 'before-edit' && !files.length) return silent;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), opts.timeoutMs ?? TIMEOUT_MS[moment]); timer.unref?.(); });
  try {
    const session = readSession(root, payload.sessionId);
    // The commit this session started from: recorded by its first hook, reused by every later one.
    const baseline = session.startHead ?? await headSha(root);
    if (!session.startHead && baseline) session.startHead = baseline;
    // Quiet: the hook's stdout is the harness's JSON channel, so no log line may reach it.
    const work = withLoggerOptions({ quiet: true }, async () => {
      if (moment === 'before-edit') return { items: await beforeEdit(root, files) };
      if (moment === 'after-tools') return { items: await afterTools(root, files, baseline) };
      return beforeStop(root, baseline);
    });
    const done = await Promise.race([work, timeout]);
    if (done === 'timeout') return silent;
    if ('block' in done && done.block) {
      return { stdout: JSON.stringify({ decision: 'block', reason: done.block }), exitCode: 0 };
    }
    const { text, shown } = renderShown(moment, done.items.filter(i => !session.keys.has(i.key)));
    if (!text) { await writeSession(root, payload.sessionId, session); return silent; }
    for (const k of shown) session.keys.add(k);
    await writeSession(root, payload.sessionId, session);
    // At Stop, context for the model makes it continue working; the advisory receipt is for the
    // user instead. Only a policy block reaches the model at Stop.
    if (moment === 'before-stop') return { stdout: JSON.stringify({ systemMessage: text }), exitCode: 0 };
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT[moment], additionalContext: text } }), exitCode: 0 };
  } catch {
    return silent;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const hookCommand = new Command('hook')
  .description('Print the receipt for one moment of the agent loop (wired by `openlore install` into harness hooks)')
  .argument('<moment>', `one of: ${HOOK_MOMENTS.join(', ')}`)
  .addHelpText('after', `
Reads the harness hook payload on stdin and prints at most one receipt as the event's
additionalContext. Prints nothing when there is nothing new; always exits 0. Turn a moment off with
"hooks": { "<moment>": false } in .openlore/config.json.
`)
  .action(async (moment: string) => {
    if (!(HOOK_MOMENTS as readonly string[]).includes(moment)) process.exit(0);
    let raw = '';
    try { raw = await readStdin(process.stdin, 1500, STDIN_MAX_BYTES); } catch { /* no payload */ }
    // Anything a dependency prints while the receipt is computed is dropped: stdout must carry
    // exactly one JSON object (or nothing) for the harness to parse.
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let r: HookRunResult;
    try { r = await runHook(moment as HookMoment, raw); } finally { process.stdout.write = write; }
    if (r.stdout) write(r.stdout + '\n');
    process.exit(0);
  });
