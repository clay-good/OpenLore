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
 * | `after-compact` | `SessionStart` (`compact`)  | the handoff briefing of the in-flight change                |
 * | `before-subagent` | `PreToolUse` (`Agent|Task`) | nothing: queues the sub-agent's task                      |
 * | `subagent-start` | `SubagentStart`            | the sub-agent's task-scoped briefing and the board's peers  |
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
import { sanitizeForTerminal, screenJsonText } from '../../utils/misc.js';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readStdin } from '../../utils/stdin.js';
import { withLoggerOptions } from '../../utils/logger.js';
import { OPENLORE_DIR } from '../../constants.js';
import { openloreProjectRoot } from '../../utils/project-root.js';
import { errorReason, recordHookRun, type HookOutcome } from '../../core/services/hook-health.js';
import { HOOK_MOMENTS, findingIdentity, markFixed, markOpen, markShown, readSession, wasShown, writeSession, type FindingProof, type HookMoment } from '../../core/services/hook-session.js';

export { HOOK_MOMENTS, type HookMoment };

/** The harness event each moment is wired to (Claude Code). */
export const HOOK_EVENT: Record<HookMoment, string> = {
  'before-edit': 'PreToolUse',
  'after-tools': 'PostToolUse',
  'before-stop': 'Stop',
  'after-compact': 'SessionStart',
  // The parent's Agent/Task call queues the sub-agent's task; SubagentStart briefs the sub-agent.
  'before-subagent': 'PreToolUse',
  'subagent-start': 'SubagentStart',
};

/** Per-moment budget, in characters of the printed receipt (about four characters a token). */
const BUDGET_CHARS: Record<HookMoment, number> = { 'before-edit': 1600, 'after-tools': 4800, 'before-stop': 8000, 'after-compact': 8000, 'before-subagent': 0, 'subagent-start': 6000 };
/**
 * Hard time limit per moment, timed in-process; past it the hook prints nothing. before-edit,
 * after-tools, and before-stop were set from measurement (hook-reliability design section 2,
 * `npm run bench:hooks`); each stays below its harness timeout in `MANAGED_HOOKS`.
 */
export const TIMEOUT_MS: Record<HookMoment, number> = { 'before-edit': 3_000, 'after-tools': 6_000, 'before-stop': 20_000, 'after-compact': 30_000, 'before-subagent': 5_000, 'subagent-start': 10_000 };
const STDIN_MAX_BYTES = 8 * 1024 * 1024;

const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2, info: 3 };

/**
 * One fact for the receipt. `code`, `subject`, and `proof` give its identity for the per-session
 * dedupe (`findingIdentity`; without a code, the `key` is the identity); `key` is still recorded
 * for an older CLI reading the same session record.
 */
/**
 * What the agent does with a finding (change: reframe-governance-as-agent-evidence, design 4):
 * `fix` — the repair is in its own diff; `decide` — a trade-off it may take (and record);
 * `raise` — only a human can accept it.
 */
export type HookAction = 'fix' | 'decide' | 'raise';
// A disclosure (severity `info`: what was not observed) states a limit, not a problem, so it
// carries no action.
export interface HookItem { key: string; severity: string; text: string; next?: string; action?: HookAction; code?: string; subject?: string; proof?: FindingProof; id?: string; check?: string; file?: string }

/** A finding item states its evidence: a file, a cited line, or a receipt discriminator. */
export function hasProof(item: HookItem): boolean {
  return !!(item.proof && (item.proof.path || item.proof.lineText !== undefined || item.proof.discriminator));
}

/** The proof as printed: the file, and the cited line when the text does not already quote it. */
function proofLabel(item: HookItem): string | undefined {
  const p = item.proof;
  if (!p?.path) return undefined;
  const line = p.lineText?.trim();
  return line && !item.text.includes(line) ? `proof: ${p.path}: ${line.length > 80 ? `${line.slice(0, 79)}…` : line}` : `proof: ${p.path}`;
}

export interface HookPayload {
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  /** Files the tool call writes, as given (absolute or relative). */
  files: string[];
  /** The shell command of a shell tool call, and its exit status when the payload carries one. */
  command?: string;
  exit?: number;
  /** The shell call was interrupted before it finished. */
  interrupted?: boolean;
  stopHookActive: boolean;
  /** An Agent/Task tool call: the sub-agent's task and type. */
  agentPrompt?: string;
  subagentType?: string;
  /** A SubagentStart event: the starting sub-agent's type. */
  agentType?: string;
  /** An edit tool call's pending change: Write's content, or Edit/MultiEdit's replacements. */
  edit?: { content?: string; edits?: Array<{ oldString: string; newString: string; replaceAll: boolean }> };
}

/** Read the fields OpenLore uses from a harness hook payload (Claude Code's shape). */
export function parseHookPayload(raw: string): HookPayload {
  let p: Record<string, unknown> = {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object') p = v as Record<string, unknown>;
  } catch { /* an unreadable payload is an empty one */ }
  const input = p.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Record<string, unknown>) : {};
  // Codex edits through `apply_patch`: its `command` is the patch text, naming every file it touches.
  const patch = p.tool_name === 'apply_patch' && typeof input.command === 'string' ? input.command : undefined;
  const files = patch !== undefined
    ? patchFiles(patch)
    : [input.file_path, input.path, input.notebook_path].filter((f): f is string => typeof f === 'string' && f.length > 0);
  const response = p.tool_response && typeof p.tool_response === 'object' ? (p.tool_response as Record<string, unknown>) : {};
  let exit = [response.exit_code, response.exitCode, response.returncode, response.code].find((x): x is number => typeof x === 'number' && Number.isInteger(x));
  // Codex sends a shell result as text: its exit status line, when present, heads the text.
  if (exit === undefined && typeof p.tool_response === 'string') {
    const m = /^(?:Exit code: |Process exited with code )(\d+)\b/m.exec(p.tool_response.split('\n', 3).join('\n'));
    if (m) exit = Number(m[1]);
  }
  // Claude Code reports a non-zero shell exit as a tool failure (PostToolUseFailure, `error` text).
  if (exit === undefined && p.hook_event_name === 'PostToolUseFailure') {
    const m = typeof p.error === 'string' ? /exit code (\d+)/i.exec(p.error) : null;
    exit = m ? Number(m[1]) : 1;
  }
  return {
    ...(response.interrupted === true || p.is_interrupt === true ? { interrupted: true } : {}),
    ...(patch === undefined && typeof input.command === 'string' && input.command ? { command: input.command } : {}),
    ...(exit !== undefined ? { exit } : {}),
    ...(typeof p.session_id === 'string' && p.session_id ? { sessionId: p.session_id } : {}),
    ...(typeof p.cwd === 'string' && p.cwd ? { cwd: p.cwd } : {}),
    ...(typeof p.tool_name === 'string' ? { toolName: p.tool_name } : {}),
    files: files.slice(0, patch !== undefined ? MAX_PATCH_FILES : 1),
    stopHookActive: p.stop_hook_active === true,
    ...(typeof input.prompt === 'string' && input.prompt ? { agentPrompt: input.prompt } : {}),
    ...(typeof input.subagent_type === 'string' && input.subagent_type ? { subagentType: input.subagent_type } : {}),
    ...(typeof p.agent_type === 'string' && p.agent_type ? { agentType: p.agent_type } : {}),
    ...pendingEdit(input),
  };
}

/** Files of one patch recorded and checked (a larger patch is a bulk change). */
const MAX_PATCH_FILES = 200;

/** The files a Codex `apply_patch` patch adds, updates, deletes, or moves to, in order, once each. */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line);
    if (m && m[1]) out.add(m[1]);
  }
  return [...out];
}

/** The pending change an edit tool call carries (Claude Code's Write, Edit, and MultiEdit inputs). */
function pendingEdit(input: Record<string, unknown>): Pick<HookPayload, 'edit'> {
  if (typeof input.content === 'string') return { edit: { content: input.content } };
  const one = (e: unknown) => {
    const x = e as Record<string, unknown> | null;
    return x && typeof x.old_string === 'string' && typeof x.new_string === 'string'
      ? { oldString: x.old_string, newString: x.new_string, replaceAll: x.replace_all === true } : null;
  };
  const list = Array.isArray(input.edits) ? input.edits.map(one) : [one(input)];
  if (!list.length || list.some(e => e === null)) return {};
  return { edit: { edits: list as Array<{ oldString: string; newString: string; replaceAll: boolean }> } };
}

/**
 * The text a pending edit would produce from `current` (null: the file does not exist), or undefined
 * when it cannot be told exactly — an old string that is absent or (without replace-all) not unique,
 * as the edit tool itself would refuse it.
 */
export function applyPendingEdit(current: string | null, edit: NonNullable<HookPayload['edit']>): string | undefined {
  if (edit.content !== undefined) return edit.content;
  if (!edit.edits) return undefined;
  // An Edit with an empty old string creates the file (or fills an empty one).
  if (edit.edits.length === 1 && !edit.edits[0].oldString && (current === null || current === '')) return edit.edits[0].newString;
  if (current === null) return undefined;
  const apply = (start: string): string | undefined => {
    let text = start;
    for (const e of edit.edits!) {
      if (!e.oldString) return undefined;
      // Occurrences as the tool counts them (non-overlapping).
      const parts = text.split(e.oldString);
      if (parts.length < 2 || (!e.replaceAll && parts.length > 2)) return undefined;
      text = parts.join(e.newString);
    }
    return text;
  };
  // The edit tool matches a CRLF file's text with LF line ends.
  return apply(current) ?? (current.includes('\r\n') ? apply(current.replace(/\r\n/g, '\n')) : undefined);
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
function renderShown(moment: HookMoment, items: HookItem[], budgetChars = BUDGET_CHARS[moment]): { text: string | null; shown: HookItem[] } {
  if (!items.length) return { text: null, shown: [] };
  const sorted = [...items].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
  const header = `[openlore ${moment}]`;
  const lines: string[] = [];
  let used = header.length;
  let omitted = 0;
  const shown: HookItem[] = [];
  for (const it of sorted) {
    // Proof and action are labeled data beside the next action, never an imperative of the hook's own.
    const labels = [it.next && `next action: ${it.next}`, it.action && `action: ${it.action}`, proofLabel(it)].filter(Boolean);
    const line = sanitizeForTerminal(`- ${it.text}${labels.length ? ` (${labels.join('; ')})` : ''}${it.id ? ` [f:${it.id}]` : ''}`);
    if (used + line.length + 1 > budgetChars) { omitted++; continue; }
    lines.push(line);
    shown.push(it);
    used += line.length + 1;
  }
  if (!lines.length) return { text: null, shown: [] };
  if (omitted) lines.push(`- ${omitted} more fact(s) not shown (budget); they are stated on a later call.`);
  return { text: `${header}\n${lines.join('\n')}`, shown };
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf899d15f71049056';

/**
 * What this session's facts compare with: its start commit, when every move of HEAD since then was
 * a commit (the session's own work). A checkout, pull, merge, reset, or rebase since then brings in
 * work that is not the session's, so the facts compare with HEAD from that point. Unknown (no HEAD
 * yet): the empty tree.
 */
async function sessionBaseline(root: string, startHead: string): Promise<string | undefined> {
  const head = await headSha(root);
  if (!head) return startHead === EMPTY_TREE ? EMPTY_TREE : undefined;
  if (startHead === EMPTY_TREE || startHead === head) return startHead;
  try {
    const { execFileGit } = await import('../../utils/git-exec.js');
    const log = String((await execFileGit('git', ['reflog', '--format=%H %gs', '-n', '500', 'HEAD'], { cwd: root })).stdout).split('\n');
    for (const line of log) {
      const [sha, ...rest] = line.split(' ');
      if (sha === startHead) return startHead; // reached the start: only commits since
      if (!/^commit\b/.test(rest.join(' '))) return head;
    }
  } catch { /* no reflog: compare with HEAD */ }
  return head;
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

/** The item's identity and printed id; an item with no code is identified by its key. */
function withIdentity(i: HookItem): { identity: string; id: string } {
  return i.code ? findingIdentity(i.code, i.subject ?? '', i.proof) : findingIdentity(i.key, '');
}

/** The text of line `line` of a repository path (`prefix` + root-relative), or undefined. */
async function citedLine(root: string, prefix: string, repoFile: string, line: number): Promise<string | undefined> {
  if (prefix && !repoFile.startsWith(prefix)) return undefined;
  try {
    const { readFileConfined } = await import('../../utils/path-confinement.js');
    const text = await readFileConfined(root, repoFile.slice(prefix.length), MAX_PENDING_BYTES);
    return text.split(/\r?\n/)[line - 1];
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
async function beforeEdit(root: string, files: string[], edit?: HookPayload['edit']): Promise<HookItem[]> {
  const { classifyGeneratedFiles } = await import('../../core/services/generated-file-guard.js');
  const { facts } = await classifyGeneratedFiles(root, files);
  const items: HookItem[] = [...facts.values()].map(f => ({
    key: `generated:${f.file}`,
    code: 'generated-file', subject: f.file, proof: { path: f.file, discriminator: f.kind }, check: 'generated', file: f.file,
    severity: 'warning', action: 'fix' as const,
    text: generatedText(f),
    ...(f.kind !== 'lockfile' ? { next: f.regenerateWith !== 'unknown' ? `regenerate with \`${f.regenerateWith}\`` : 'edit the source and regenerate' } : {}),
  }));
  if (edit && files.length === 1) {
    // Bounded on its own: the generated-file facts above never wait on it.
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<HookItem[]>(r => { timer = setTimeout(() => r([]), PENDING_CHECK_MS); timer.unref?.(); });
    items.push(...(await Promise.race([pendingReferences(root, files[0], edit).catch(() => []), limit])));
    if (timer) clearTimeout(timer);
  }
  return items;
}

/** Time for the pending-edit reference check, inside the before-edit moment's 3 s limit. */
const PENDING_CHECK_MS = 2_000;
/** Pending-edit facts per call: the budget keeps room for the generated-file facts. */
const MAX_PENDING_FACTS = 3;
/** The size the after-write check reads (`phantom-references` MAX_FILE_BYTES): the same files are graded. */
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/**
 * The references a pending edit would add that do not resolve, graded on the pending text in memory
 * before the tool writes it. Same finding keys as after-tools, so a fact is stated once.
 */
async function pendingReferences(root: string, file: string, edit: NonNullable<HookPayload['edit']>): Promise<HookItem[]> {
  const { readFileConfined } = await import('../../utils/path-confinement.js');
  let current: string | null;
  try { current = await readFileConfined(root, file, MAX_PENDING_BYTES); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return [];
    current = null;
  }
  const next = applyPendingEdit(current, edit);
  if (next === undefined || next === current || Buffer.byteLength(next) > MAX_PENDING_BYTES) return [];
  const prefix = await repoPrefix(root);
  const { classifyFile } = await import('../../core/drift/git-diff.js');
  const path = prefix + file;
  const changed = [{ path, status: current === null ? 'added' as const : 'modified' as const, additions: 0, deletions: 0, ...classifyFile(path) }];
  const { checkPhantomReferences } = await import('../../core/services/phantom-references.js');
  const r = await checkPhantomReferences(root, 'HEAD', changed, undefined, { head: new Map([[file, next]]), base: new Map([[file, current]]) }).catch(() => undefined);
  // Own keys: a denied or failed edit must not silence the after-write fact of a later, real one.
  // Identity: the cited line's text in the pending content (the line number is left out). A
  // pending fact keeps its own code: a denied edit must not silence the after-write fact.
  const lines = next.split(/\r?\n/);
  const ident = (f: { code: string; subject: string; location?: { path: string; line?: number } }) => ({
    code: `pending:${f.code}`, subject: f.subject,
    proof: { path: f.location?.path ?? path, ...(f.location?.line ? { lineText: lines[f.location.line - 1] ?? '' } : {}) },
  });
  return (r?.findings ?? []).slice(0, MAX_PENDING_FACTS).map(f => f.code === 'unresolved-internal-import'
    // The module may be the agent's next write: a pending state, not yet an error.
    ? { key: `pending:${f.code}:${f.location?.path ?? ''}:${f.subject}`, ...ident(f), action: 'fix' as const, severity: 'warning', text: `Before the write: ${f.message.replace(/, which is not a module in this repository/, ', which does not exist yet')}`, next: 'create that module, or fix the path' }
    : { key: `pending:${f.code}:${f.location?.path ?? ''}:${f.subject}`, ...ident(f), action: 'fix' as const, severity: f.severity, text: `Before the write: ${f.message}`, ...(f.remediation ? { next: f.remediation } : {}) });
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
async function afterTools(root: string, files: string[], baseline: string | undefined, ran: Set<string> = new Set()): Promise<HookItem[]> {
  const items: HookItem[] = [];
  const { recordAgentEdit, readLiveLedger } = await import('../../core/services/session-ledger.js');
  for (const f of files) recordAgentEdit(root, f);

  const live = readLiveLedger(root);
  if ('ledger' in live) {
    for (const c of live.ledger.backgroundChanges) {
      items.push({ key: `bg:${c.id}@${c.changedAt}`, code: 'background-change', subject: c.id, proof: { path: c.file, discriminator: String(c.changedAt) }, action: 'decide', severity: 'warning', text: `${c.name} (${c.file}) changed since this session read it (another process's edit).` });
    }
    for (const o of live.ledger.editOscillation) {
      items.push({ key: `loop:${o.id}#${o.returns}`, code: 'edit-loop', subject: o.id, proof: { path: o.file, discriminator: String(o.returns) }, action: 'decide', severity: 'warning', text: `${o.name} (${o.file}) returned to an earlier version ${o.returns} times this session.` });
    }
  }
  // A peer changed a symbol this worktree's agent declared it reads or was served (changes:
  // add-peer-change-notices, add-peer-notices-served-set-and-fleet-records).
  try {
    const { peerChangeNotices } = await import('../../core/services/peer-notices.js');
    const { emittedText: t } = await import('../../core/services/generated-file-guard.js');
    for (const n of await peerChangeNotices(root)) {
      items.push({
        key: `peer:${n.peer.actorId}:${n.repoPath}#${n.symbol}`,
        code: 'peer-change', subject: `${n.peer.actorId}:${n.repoPath}#${n.symbol}`,
        proof: { path: n.file, discriminator: n.at }, action: 'decide', severity: 'warning',
        // Board fields are peer-written: screened before they reach the agent.
        text: sanitizeForTerminal(`Peer ${t(n.peer.actorId)} (${t(n.peer.branch || 'detached')} in ${t(n.peer.worktree)}) changed ${t(n.symbol)} (${t(n.file)}), which ${n.via === 'served' ? 'was served in this worktree' : 'an agent in this worktree declared reading'} at ${t(n.at).slice(11, 16)} UTC.`),
        next: `re-read ${t(n.symbol)} before relying on it`,
      });
    }
  } catch { /* the board is optional */ }
  if (!files.length) return items;

  items.push(...(await beforeEdit(root, files)));
  ran.add('generated');

  if (!baseline) return items; // no commit to compare with (an unborn branch)
  // Compared with the commit this harness session started from: a finding in an earlier commit is
  // not this session's, and is not raised again in every session.
  const prefix = await repoPrefix(root);
  const repoFiles = files.map(f => prefix + f);
  const { classifyFile } = await import('../../core/drift/git-diff.js');
  const changed = repoFiles.map(path => ({ path, status: 'modified' as const, additions: 0, deletions: 0, ...classifyFile(path) }));
  const { checkPhantomReferences } = await import('../../core/services/phantom-references.js');
  const phantom = await checkPhantomReferences(root, baseline, changed).catch(() => undefined);
  if (phantom) ran.add('phantom');
  const rel = (p?: string) => (p && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  for (const f of phantom?.findings ?? []) {
    // Identity: the cited line's text, not its number (the source's discriminator carries the number).
    const lineText = f.location?.line ? await citedLine(root, prefix, f.location.path, f.location.line) : undefined;
    items.push({
      key: `${f.code}:${f.location?.path ?? ''}:${f.subject}`, code: f.code, subject: f.subject, check: 'phantom', file: rel(f.location?.path),
      proof: lineText !== undefined ? { path: f.location!.path, lineText } : { path: f.location?.path, discriminator: f.discriminator },
      action: 'fix', severity: f.severity, text: f.message, ...(f.remediation ? { next: f.remediation } : {}),
    });
  }

  const { checkWeakening } = await import('../../core/services/check-weakening.js');
  // The repository top, derived from this root and its prefix (git's own spelling of the path can
  // differ on Windows: forward slashes, a long name for an 8.3 one).
  const top = resolve(root, ...prefix.split('/').filter(Boolean).map(() => '..'));
  const weak = top ? await checkWeakening({ root: top, baseRef: baseline, files: repoFiles }).catch(() => undefined) : undefined;
  if (weak) ran.add('weakening');
  // Check-weakening discriminators are text-based (the added ignore line, the step), not line numbers.
  for (const f of weak?.findings ?? []) items.push({ key: `${f.code}:${f.subject}:${f.discriminator ?? ''}`, code: f.code, subject: f.subject, proof: { path: f.location?.path, discriminator: f.discriminator }, check: 'weakening', file: rel(f.location?.path), action: 'decide', severity: f.severity, text: f.message });
  return items;
}

/**
 * `before-stop`: the `verify_change` receipt. Blocks only when `enforcement.policy` makes one of its
 * findings blocking, and never twice in a row (`stop_hook_active`).
 */
/**
 * The symbols this session edited after its last observed test run, and the tests that reach them
 * (change: add-session-ledger-runs-contracts-tokens). OpenLore runs no test.
 */
async function testRunItem(root: string, sessionId: string | undefined): Promise<HookItem | undefined> {
  if (!sessionId) return undefined;
  const { editsAfterLastRun } = await import('../../core/services/test-run-ledger.js');
  const r = await editsAfterLastRun(root, sessionId);
  if (!r) return undefined;
  const when = (t: number) => new Date(t).toISOString().slice(11, 16);
  const shellNote = 'Edits made through shell commands are not tracked.';
  if (r.kind === 'not-observed') {
    return { key: 'test-runs:not-observed', code: 'test-runs', subject: 'not-observed', proof: { discriminator: 'no-shell-command-observed' }, severity: 'info', text: 'Test runs are not observed in this session (no shell command reached the after-tools hook), so edits after the last run are not stated.' };
  }
  if (r.kind === 'no-run') {
    const files = r.files!.slice(0, 5).join(', ');
    return {
      key: `test-runs:none:${r.files!.length}`, code: 'test-runs', subject: 'no-run', proof: { discriminator: String(r.files!.length) }, action: 'fix', severity: 'warning',
      text: `No completed test run was observed this session after editing ${files}${r.files!.length > 5 ? ` and ${r.files!.length - 5} more` : ''}${r.interruptedSince ? ` (${r.interruptedSince} run(s) were interrupted)` : ''}.`,
      next: 'run the tests that reach these files',
    };
  }
  const run = r.lastRun!;
  const runText = `\`${run.command.slice(0, 80)}\` at ${when(run.at)} UTC${run.exit !== undefined ? `, exit ${run.exit}` : ''}`;
  if (r.kind === 'clean') {
    return run.exit !== undefined && run.exit !== 0
      ? { key: `test-runs:failed:${run.at}`, code: 'test-runs', subject: 'failed', proof: { discriminator: String(run.at) }, action: 'fix', severity: 'warning', text: `The last test run (${runText}) failed, and nothing was edited after it.`, next: 'fix the failure and rerun' }
      : undefined;
  }
  const symbols = r.symbols ?? [];
  const parts: string[] = [];
  if (symbols.length) parts.push(`${symbols.slice(0, 8).map(s => `${s.name} (${s.file})${s.removed ? ' [removed]' : ''}`).join(', ')}${symbols.length > 8 ? ` and ${symbols.length - 8} more` : ''}`);
  if (r.undetermined?.length) parts.push(`${r.undetermined.slice(0, 5).join(', ')} (which symbols is not determined)`);
  // Only names the index knows exactly: a fuzzy name would seed tests for other symbols.
  let testText: string;
  try {
    const { readCachedContext } = await import('../../core/services/mcp-handlers/utils.js');
    const ctx = await readCachedContext(root);
    const known = new Set((ctx?.callGraph?.nodes ?? []).map(n => n.name));
    const names = [...new Set(symbols.filter(s => !s.removed).map(s => s.name))].filter(n => known.has(n));
    const unknown = symbols.filter(s => !s.removed && !known.has(s.name)).length;
    if (!ctx?.callGraph) testText = ' Tests that reach them are not computed (no index: run `openlore analyze`).';
    else if (!names.length) testText = unknown ? ' Tests that reach them are not computed (the symbols are not in the index yet).' : '';
    else {
      const { handleSelectTests } = await import('../../core/services/mcp-handlers/test-impact.js');
      const sel = await handleSelectTests({ directory: root, changedSymbols: names.slice(0, 50) }) as { selectedTests?: Array<{ test: string; file: string }>; error?: string };
      if (sel.error || !sel.selectedTests) testText = ` Tests that reach them are not computed (${sel.error ?? 'no result'}).`;
      else {
        const tests = [...new Set(sel.selectedTests.map(t => `${t.file} › ${t.test}`))];
        testText = tests.length
          ? ` Tests that reach them: ${tests.slice(0, 6).join(', ')}${tests.length > 6 ? ` and ${tests.length - 6} more` : ''}.`
          : ' No indexed test reaches them.';
        if (unknown) testText += ` ${unknown} symbol(s) are not in the index yet.`;
      }
    }
  } catch (e) {
    testText = ` Tests that reach them are not computed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}).`;
  }
  const keyBase = [...symbols.map(s => `${s.file}#${s.name}`), ...(r.undetermined ?? [])].join('\0');
  return {
    key: `test-runs:after:${run.at}:${createHash('sha256').update(keyBase).digest('hex').slice(0, 12)}`,
    code: 'test-runs', subject: 'edited-after-run', proof: { discriminator: `${run.at}:${createHash('sha256').update(keyBase).digest('hex')}` }, action: 'fix',
    severity: 'warning',
    text: sanitizeForTerminal(`Edited after the last test run (${runText}): ${parts.join('; ')}.${testText}${r.interruptedSince ? ` ${r.interruptedSince} later run(s) were interrupted.` : ''} ${shellNote}`),
    next: 'rerun the tests that reach these edits',
  };
}

/** Each certificate's own limit inside before-stop, and its item cap (change:
 *  reframe-governance-as-agent-evidence, design section 3). */
export const CERTIFICATE_MS = 10_000;
const CERTIFICATE_ITEMS = 3;

/**
 * Run one certificate source. Its items (at most {@link CERTIFICATE_ITEMS}), or none when it throws,
 * rejects, or passes its limit: a certificate that did not finish says nothing, never "passed".
 */
export async function certificateSlice(run: () => Promise<HookItem[]>, ms = CERTIFICATE_MS): Promise<HookItem[]> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<HookItem[]>(r => { timer = setTimeout(() => r([]), ms); timer.unref?.(); });
  try {
    const work = Promise.resolve().then(run).catch(() => [] as HookItem[]);
    return (await Promise.race([work, limit])).slice(0, CERTIFICATE_ITEMS);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The files whose exports the public-surface certificate classifies. */
export const PUBLIC_SURFACE_FILE = /\.(?:tsx?|jsx?|py)$/i;
/** The files the service-contract reader may accept (OpenAPI, protobuf, GraphQL). */
export const CONTRACT_FILE = /(?:\.(?:ya?ml|json|proto|graphqls?|gql)|(?:^|\/)\.graphqlconfig)$/i;

function consumersText(consumers: Array<{ file: string }> | undefined): string {
  const files = [...new Set((consumers ?? []).map(c => c.file))];
  if (!files.length) return 'no consumer in this repository; consumers outside it are not assessed';
  return `used by ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more file(s)` : ''}`;
}

/**
 * The before-stop certificates (design section 3): the public-surface, service-contract and
 * change-impact certificates, each started only when the session diff can give it something to
 * find, each limited by {@link certificateSlice}. Base ref = the session baseline.
 */
async function certificateItems(root: string, baseRef: string): Promise<HookItem[][]> {
  const { getChangedFiles } = await import('../../core/drift/git-diff.js');
  const changed = (await getChangedFiles({ rootPath: root, baseRef, includeUnstaged: true })).files.map(f => f.path);
  const slices: Array<Promise<HookItem[]>> = [];
  if (changed.some(f => PUBLIC_SURFACE_FILE.test(f))) {
    slices.push(certificateSlice(async () => {
      const { handleCertifyPublicSurface } = await import('../../core/services/mcp-handlers/public-surface.js');
      const r = await handleCertifyPublicSurface({ directory: root, baseRef }) as {
        breaking?: Array<{ class: string; name: string; file: string; changeKind: string; ruleCodes: string[]; consumers?: Array<{ file: string }> }>;
      };
      return (r.breaking ?? []).filter(b => b.class === 'breaking').map(b => ({
        key: `public-surface:${b.file}::${b.name}`, code: b.ruleCodes[0] ?? 'export-removed', subject: `${b.file}::${b.name}`,
        check: 'public_surface', file: b.file, severity: 'error', action: 'decide' as const,
        proof: { path: b.file, discriminator: `${b.changeKind}:${b.ruleCodes.join(',')}` },
        text: sanitizeForTerminal(`exported ${b.name} (${b.file}) ${b.changeKind.replace(/-/g, ' ')}: breaks ${b.ruleCodes.join(', ')}; ${consumersText(b.consumers)}`),
        next: 'update the consumers or keep the export compatible',
      }));
    }));
  }
  if (changed.some(f => CONTRACT_FILE.test(f))) {
    slices.push(certificateSlice(async () => {
      const { handleCertifyServiceContract } = await import('../../core/services/mcp-handlers/service-contract.js');
      const r = await handleCertifyServiceContract({ directory: root, baseRef }) as {
        findings?: Array<{ code: string; severity: string; subject: string; discriminator?: string; message: string; location?: { path: string } }>;
      };
      return (r.findings ?? []).filter(f => f.code === 'contract-breaking').map(f => ({
        key: `service-contract:${f.subject}:${f.discriminator ?? ''}`, code: f.code, subject: f.subject,
        check: 'service_contract', file: f.location?.path, severity: f.severity === 'error' ? 'error' : 'warning', action: 'decide' as const,
        proof: { path: f.location?.path, discriminator: f.discriminator },
        text: sanitizeForTerminal(`${f.subject}: ${f.message}`),
        next: 'update the callers or keep the contract compatible',
      }));
    }));
  }
  const { readOpenLoreConfig } = await import('../../core/services/config-manager.js');
  const config = await readOpenLoreConfig(root).catch(() => null);
  if (config?.impactCertificate?.surfaces?.length) {
    slices.push(certificateSlice(async () => {
      const { handleChangeImpactCertificate } = await import('../../core/services/mcp-handlers/impact-certificate.js');
      const r = await handleChangeImpactCertificate({ directory: root, baseRef, persist: false }) as {
        findings?: Array<{ code: string; severity: string; subject: string; message: string; remediation: string }>;
        newlyOpenedPaths?: Array<{ surface: string; openingEdge: { from: string; to: string } }>;
      };
      return (r.findings ?? []).filter(f => f.code === 'surface-critical' || f.code === 'surface-newly-reached').map(f => {
        const edge = r.newlyOpenedPaths?.find(p => p.surface === f.subject)?.openingEdge;
        return {
          key: `impact:${f.subject}`, code: f.code, subject: f.subject, check: 'impact_certificate', action: 'raise' as const,
          severity: f.severity === 'error' ? 'error' : 'warning',
          proof: { discriminator: edge ? `${edge.from}->${edge.to}` : f.message },
          text: sanitizeForTerminal(f.message), next: f.remediation,
        };
      });
    }));
  }
  return Promise.all(slices);
}

const VERIFY_CHANGE_ACTION: Record<string, HookAction> = { blast_radius: 'decide', check_weakening: 'decide' };

async function beforeStop(root: string, baseline: string | undefined, sessionId?: string): Promise<{ items: HookItem[]; block?: string }> {
  const runItem = await testRunItem(root, sessionId).catch(() => undefined);
  const { handleVerifyChange } = await import('../../core/services/mcp-handlers/verify-change.js');
  // The certificates start with verify_change and run beside it; a failure there costs only them.
  const certificates = certificateItems(root, baseline ?? 'HEAD').catch(() => [] as HookItem[][]);
  const r = await handleVerifyChange({ directory: root, ...(baseline ? { baseRef: baseline } : {}) }) as {
    error?: string;
    items?: Array<{ subject: string; check: string; severity: string; nextAction: string }>;
    findings?: Array<{ code: string; subject: string; message: string; enforcementClass?: string; remediation?: string; discriminator?: string; location?: { path: string; line?: number } }>;
    gated?: boolean;
  };
  const certified = (await certificates).flat();
  if (r.error) return { items: [...certified, ...(runItem ? [runItem] : [])] };
  // A receipt item built from a phantom-reference or check-weakening finding gets that finding's
  // identity, the same one the after-edit hook gave it: one problem is one finding, so its outcome
  // (fixed, decided, open) is counted once (change: hook-reliability, task 7.2).
  const prefix = await repoPrefix(root).catch(() => '');
  const rel = (p?: string) => (p && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const sameFinding: Record<string, string> = { phantom_references: 'phantom', check_weakening: 'weakening' };
  const items: HookItem[] = [];
  for (const i of r.items ?? []) {
    // The verify_change receipt is the proof of its own items; a trade-off (who else this reaches)
    // is the agent's to weigh, everything else is repaired in its diff.
    const item: HookItem = {
      key: `${i.check}:${i.subject}`, code: i.check, subject: i.subject, severity: i.severity, text: `${i.subject} [${i.check}]`, next: i.nextAction,
      proof: { discriminator: `verify_change:${i.check}` }, action: VERIFY_CHANGE_ACTION[i.check] ?? 'fix',
    };
    const check = sameFinding[i.check];
    const f = check ? (r.findings ?? []).find(x => x.message === i.subject) : undefined;
    if (check && f) {
      const lineText = check === 'phantom' && f.location?.line ? await citedLine(root, prefix, f.location.path, f.location.line) : undefined;
      Object.assign(item, {
        code: f.code, subject: f.subject, check, file: rel(f.location?.path),
        // A finding that carries no location or discriminator keeps the receipt as its proof.
        proof: lineText !== undefined ? { path: f.location!.path, lineText }
          : f.location?.path || f.discriminator ? { path: f.location?.path, discriminator: f.discriminator } : item.proof,
      });
    }
    items.push(item);
  }
  // One problem is one line: a certificate item verify_change already names (the same removed or
  // re-signed symbol in the same file) is dropped.
  const named = new Set(items.map(i => i.text));
  for (const c of certified) {
    const [file, name] = c.check === 'public_surface' && c.subject ? [c.subject.slice(0, c.subject.lastIndexOf('::')), c.subject.slice(c.subject.lastIndexOf('::') + 2)] : [];
    if (name && [`removed ${name} (${file}) [structural_diff]`, `signature changed: ${name} (${file}) [structural_diff]`].some(t => named.has(t))) continue;
    items.push(c);
  }
  if (runItem) items.push(runItem);
  const blocking = (r.findings ?? []).filter(f => f.enforcementClass === 'blocking');
  if (!r.gated || !blocking.length) return { items };
  const reason = [
    `[openlore before-stop] ${blocking.length} finding(s) are blocking under this repository's enforcement.policy:`,
    ...blocking.map(f => `- ${f.code}: ${f.message}${f.remediation ? ` (next action: ${f.remediation})` : ''}`),
  ].join('\n');
  return { items, block: reason };
}

/**
 * `subagent-start`: the starting sub-agent's task-scoped briefing (its task as queued by
 * `before-subagent`) and the live peers on the footprint board. Not deduplicated: each sub-agent is
 * a fresh context.
 */
async function subagentStart(root: string, payload: HookPayload, timeoutMs: number, report: HookRunReport): Promise<HookRunResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs); timer.unref?.(); });
  try {
    const work = withLoggerOptions({ quiet: true }, async () => {
      const { takeSubagentTask, subagentBriefing } = await import('../../core/services/subagent-briefing.js');
      const prompt = await takeSubagentTask(root, { sessionId: payload.sessionId, agentType: payload.agentType }).catch(() => undefined);
      return subagentBriefing(root, prompt, BUDGET_CHARS['subagent-start']);
    });
    const text = await Promise.race([work, timeout]);
    if (text === 'timeout') report.outcome = 'overrun';
    if (text === 'timeout' || !text) return { stdout: '', exitCode: 0 };
    const capped = sanitizeForTerminal(text, { keepNewlines: true }).slice(0, BUDGET_CHARS['subagent-start']).replace(/[\uD800-\uDBFF]$/, '');
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: capped } }), exitCode: 0 };
  } catch (error) {
    report.outcome = 'error';
    report.reason = errorReason(error);
    return { stdout: '', exitCode: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `after-compact`: the handoff briefing, so the agent resumes from the computed state of its change
 * rather than the compaction summary alone. Stated after every compaction (not deduplicated).
 */
async function afterCompact(root: string, timeoutMs: number, report: HookRunReport): Promise<HookRunResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs); timer.unref?.(); });
  try {
    const work = withLoggerOptions({ quiet: true }, async () => {
      const { handleGetHandoffBriefing, renderHandoff } = await import('../../core/services/mcp-handlers/handoff.js');
      return renderHandoff(await handleGetHandoffBriefing({ directory: root }), { boundaries: 'summary' });
    });
    const text = await Promise.race([work, timeout]);
    if (text === 'timeout') report.outcome = 'overrun';
    if (text === 'timeout' || !text) return { stdout: '', exitCode: 0 };
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text.slice(0, BUDGET_CHARS['after-compact']).replace(/[\uD800-\uDBFF]$/, '') } }), exitCode: 0 };
  } catch (error) {
    report.outcome = 'error';
    report.reason = errorReason(error);
    return { stdout: '', exitCode: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether task-scoped context injection is turned off (`contextInjection.mode: "off"`). */
function injectionOff(root: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(root, OPENLORE_DIR, 'config.json'), 'utf-8')) as { contextInjection?: { mode?: string } };
    return cfg?.contextInjection?.mode === 'off';
  } catch { return false; }
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

/** What one run did, for the hook-health record (change: hook-reliability, task 6.1). */
export interface HookRunReport { root?: string; outcome: HookOutcome; shown: number; reason?: string }

/**
 * Run one moment over a payload, then SCREEN the result.
 *
 * Never throws and always exits 0: a timeout or an error prints nothing. Exported for tests; the
 * CLI prints `stdout`.
 *
 * Screening happens here rather than in each moment, because every moment's payload is
 * repository-derived text going straight into model context and only `subagent-start` screened its
 * own. The class only removes characters inside the JSON's string literals, so the harness still
 * parses exactly one object.
 */
export async function runHook(
  moment: HookMoment, raw: string,
  opts: { cwd?: string; timeoutMs?: number; userScope?: boolean; onRun?: (report: HookRunReport) => void } = {},
): Promise<HookRunResult> {
  const report: HookRunReport = { outcome: 'ok', shown: 0 };
  // The last line of the fail-open contract: a check module that does not load, or a throw on any
  // path outside a moment's own guard, still ends in silence (change: hook-reliability).
  try {
    const r = await runHookUnscreened(moment, raw, opts, report);
    return r.stdout ? { ...r, stdout: screenJsonText(r.stdout) } : r;
  } catch (error) {
    report.outcome = 'error';
    report.reason = errorReason(error);
    return { stdout: '', exitCode: 0 };
  } finally {
    opts.onRun?.(report);
  }
}

async function runHookUnscreened(moment: HookMoment, raw: string, opts: { cwd?: string; timeoutMs?: number; userScope?: boolean }, report: HookRunReport): Promise<HookRunResult> {
  const silent: HookRunResult = { stdout: '', exitCode: 0 };
  const payload = parseHookPayload(raw);
  // The OpenLore root: the nearest directory at or above the session's working directory (the agent
  // may have `cd`-ed into a subdirectory) that has `.openlore`. None: nothing to say.
  const start = resolve(payload.cwd ?? opts.cwd ?? process.cwd());
  // The working directory first; when it is above the project (a monorepo top), the edited file's.
  const root = openloreProjectRoot(start) ?? (payload.files[0] ? openloreProjectRoot(dirname(resolve(start, payload.files[0]))) : undefined);
  if (!root) return silent;
  // The user-scope wiring stands down where the repository wires this moment itself: one receipt,
  // and one hook-health record, per event (change: user-scope-loop-hooks).
  if (opts.userScope) {
    const { repoWiresStep } = await import('../install/hook-wiring-health.js');
    if (repoWiresStep([process.env.CLAUDE_PROJECT_DIR, root, start], `hook ${moment}`)) return silent;
  }
  report.root = root;
  if (momentDisabled(root, moment)) return silent;
  if (moment === 'before-stop' && payload.stopHookActive) return silent;
  if (moment === 'after-compact') return afterCompact(root, opts.timeoutMs ?? TIMEOUT_MS[moment], report);
  if (moment === 'before-subagent') {
    // Nothing reads the queue when sub-agent briefings or task injection are off: nothing is stored.
    if ((payload.toolName === 'Agent' || payload.toolName === 'Task') && payload.agentPrompt && !momentDisabled(root, 'subagent-start') && !injectionOff(root)) {
      const { queueSubagentTask } = await import('../../core/services/subagent-briefing.js');
      let timer: NodeJS.Timeout | undefined;
      // Bounded: a held queue lock must never stall the parent's Agent call.
      const limit = new Promise<void>(r => { timer = setTimeout(r, opts.timeoutMs ?? TIMEOUT_MS[moment]); timer.unref?.(); });
      await Promise.race([withLoggerOptions({ quiet: true }, async () => queueSubagentTask(root, { sessionId: payload.sessionId, agentType: payload.subagentType, prompt: payload.agentPrompt! })).catch(() => undefined), limit]);
      if (timer) clearTimeout(timer);
    }
    return silent; // only queues: the parent's tool call gets no output
  }
  if (moment === 'subagent-start') return subagentStart(root, payload, opts.timeoutMs ?? TIMEOUT_MS[moment], report);
  // A relative path is the harness's, from its working directory (Codex patches), not the root's.
  const files = payload.files.map(f => repoPath(root, resolve(start, f))).filter((f): f is string => !!f);
  // A shell command (after-tools sees them too): count it and record a test run, nothing else, so a
  // shell call stays cheap.
  if (moment === 'after-tools' && payload.command !== undefined && !files.length) {
    if (payload.sessionId) {
      const { recordShellCommand } = await import('../../core/services/test-run-ledger.js');
      await withLoggerOptions({ quiet: true }, async () => recordShellCommand(root, payload.sessionId!, payload.command!, payload.exit, payload.interrupted === true)).catch(() => undefined);
    }
    return silent;
  }
  if (moment === 'before-edit' && !files.length) return silent;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), opts.timeoutMs ?? TIMEOUT_MS[moment]); timer.unref?.(); });
  try {
    const session = readSession(root, payload.sessionId);
    // The commit this session started from: recorded by its first hook (git's empty tree on an
    // unborn branch), reused by every later one.
    if (!session.startHead) session.startHead = (await headSha(root)) ?? EMPTY_TREE;
    const baseline = await sessionBaseline(root, session.startHead);
    // Quiet: the hook's stdout is the harness's JSON channel, so no log line may reach it.
    const work = withLoggerOptions({ quiet: true }, async () => {
      const runs = await import('../../core/services/test-run-ledger.js');
      if (moment === 'before-edit') {
        if (payload.sessionId) await runs.recordEditIntent(root, payload.sessionId, files).catch(() => undefined);
        return { items: await beforeEdit(root, files, payload.edit) };
      }
      if (moment === 'after-tools') {
        if (payload.sessionId) await runs.recordEdits(root, payload.sessionId, files).catch(() => undefined);
        const ran = new Set<string>();
        return { items: await afterTools(root, files, baseline, ran), ran };
      }
      return beforeStop(root, baseline, payload.sessionId);
    });
    const done = await Promise.race([work, timeout]);
    if (done === 'timeout') { report.outcome = 'overrun'; return silent; }
    if ('block' in done && done.block) {
      return { stdout: JSON.stringify({ decision: 'block', reason: done.block }), exitCode: 0 };
    }
    // Once per session per audience: the before-stop receipt is the user's, every other moment
    // speaks to the agent (design section 3).
    const audience = moment === 'before-stop' ? 'user' : 'agent';
    // A finding with no proof is not stated (design section 4); briefings are other moments.
    const all = done.items.filter(hasProof).map(i => ({ ...i, ...withIdentity(i) }));
    const reported = new Set(all.map(i => i.identity));
    // Acted-on states (design section 4): after an agent edit, a check that ran to completion and
    // no longer reports a finding on the edited file fixed it; the stop receipt marks what is open.
    if ('ran' in done) for (const check of done.ran) markFixed(session, check, files, reported);
    if (moment === 'before-stop') markOpen(session, reported);
    const fresh = all.filter(i => !wasShown(session, i.identity, audience));
    const { text, shown } = renderShown(moment, fresh);
    if (!text) { await writeSession(root, payload.sessionId, session); return silent; }
    report.shown = shown.length;
    for (const i of shown as Array<HookItem & { identity: string }>) {
      session.keys.add(i.key);
      markShown(session, i.identity, { code: i.code ?? i.key, subject: i.subject ?? '', check: i.check, file: i.file }, moment, audience);
    }
    // A finding first shown in this stop receipt is open too.
    if (moment === 'before-stop') markOpen(session, reported);
    await writeSession(root, payload.sessionId, session);
    // At Stop, context for the model makes it continue working; the advisory receipt is for the
    // user instead. Only a policy block reaches the model at Stop.
    if (moment === 'before-stop') return { stdout: JSON.stringify({ systemMessage: text }), exitCode: 0 };
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT[moment], additionalContext: text } }), exitCode: 0 };
  } catch (error) {
    report.outcome = 'error';
    report.reason = errorReason(error);
    return silent;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const hookCommand = new Command('hook')
  .description('Print the receipt for one moment of the agent loop (wired by `openlore install` into harness hooks)')
  .argument('<moment>', `one of: ${HOOK_MOMENTS.join(', ')}`)
  .option('--harness <name>', 'the harness that runs the hook (claude-code, codex); wired by install')
  .option('--scope <scope>', 'the install scope that wired it; `user` stands down where the repository wires the moment itself')
  .addHelpText('after', `
Reads the harness hook payload on stdin and prints at most one receipt as the event's
additionalContext. Prints nothing when there is nothing new; always exits 0. Turn a moment off with
"hooks": { "<moment>": false } in .openlore/config.json.
`)
  .action(async (moment: string, options: { harness?: string; scope?: string }) => {
    if (!(HOOK_MOMENTS as readonly string[]).includes(moment)) process.exit(0);
    let raw = '';
    try { raw = await readStdin(process.stdin, 1500, STDIN_MAX_BYTES); } catch { /* no payload */ }
    // Anything a dependency prints while the receipt is computed is dropped: stdout must carry
    // exactly one JSON object (or nothing) for the harness to parse.
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let r: HookRunResult;
    let report: HookRunReport | undefined;
    try { r = await runHook(moment as HookMoment, raw, { userScope: options.scope === 'user', onRun: rep => { report = rep; } }); } finally { process.stdout.write = write; }
    // The hook's one stdout write is also its screening choke point: every moment's
    // additionalContext is repository-derived text headed straight into model context, and only
    // 'subagent-start' sanitized its own. The class only removes characters inside the JSON's
    // string literals, so the harness still parses one object.
    if (r.stdout) write(sanitizeForTerminal(r.stdout, { keepNewlines: true }) + '\n');
    // Codex expects JSON from a Stop hook that exits 0; an empty object says nothing.
    else if (options.harness === 'codex' && moment === 'before-stop') write('{}\n');
    // Whole-process time, as the p95 targets are; after the output, so it never delays the agent.
    if (report?.root) await recordHookRun(report.root, { moment, ms: process.uptime() * 1000, outcome: report.outcome, shown: report.shown, ...(report.reason ? { reason: report.reason } : {}) });
    process.exit(0);
  });
