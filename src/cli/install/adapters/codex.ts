import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LEAN_DEFAULT_PRESET } from '../../../constants.js';
import { confinedAtomicWriteFile, safeJoin } from '../../../utils/path-confinement.js';
import { formatPlatformCommand, resolveOpenloreCommand } from '../../../utils/platform-command.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

const HOOKS_REL = join('.codex', 'hooks.json');
const CONFIG_REL = join('.codex', 'config.toml');
const MANAGED_MATCHER = 'openlore-proposal-context-v1';
const EVENT = 'UserPromptSubmit';
const MCP_START = '# >>> openlore managed mcp server';
const MCP_END = '# <<< openlore managed mcp server';
const HOOK_START = '# >>> openlore managed proposal hook';
const HOOK_END = '# <<< openlore managed proposal hook';

/**
 * The agent-loop moments Codex can receive (change: add-agent-loop-hooks-codex-and-pi). Codex's
 * hooks follow Claude Code's protocol: `apply_patch` edits and `Bash` commands on PreToolUse and
 * PostToolUse, `additionalContext`, and a SessionStart `compact` source. Repository scope only, in
 * `.codex/hooks.json`. A group is recognized by its command (`openlore … hook <moment> --harness
 * codex`), since Codex's hook schema has no room for an ownership marker.
 */
const LOOP_HOOKS: ReadonlyArray<{ event: string; moment: string; matcher?: string; timeout: number }> = [
  { event: 'PreToolUse', moment: 'before-edit', matcher: 'apply_patch', timeout: 15 },
  { event: 'PostToolUse', moment: 'after-tools', matcher: 'apply_patch|Bash', timeout: 30 },
  { event: 'Stop', moment: 'before-stop', timeout: 90 },
  { event: 'SessionStart', moment: 'after-compact', matcher: 'compact', timeout: 60 },
];
const LOOP_COMMAND = /\bhook (?:before-edit|after-tools|before-stop|after-compact) --harness codex$/;

/** Whether a hooks.json group is one of OpenLore's loop moments. */
function isLoopGroup(group: unknown): boolean {
  const hooks = asObject(group)?.hooks;
  return Array.isArray(hooks) && hooks.length > 0
    && hooks.every((h) => typeof asObject(h)?.command === 'string' && LOOP_COMMAND.test(asObject(h)!.command as string));
}

interface CodexHookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

interface ManagedTextResult {
  text?: string;
  warning?: string;
}

async function readIfExists(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseHooks(raw: string | null): { doc: Record<string, unknown>; groups: CodexHookGroup[] } | null {
  if (raw === null) return { doc: {}, groups: [] };
  try {
    const doc = asObject(JSON.parse(raw));
    if (!doc) return null;
    const hooks = doc.hooks === undefined ? {} : asObject(doc.hooks);
    if (!hooks) return null;
    const value = hooks[EVENT];
    if (value !== undefined && !Array.isArray(value)) return null;
    return { doc, groups: (value ?? []) as CodexHookGroup[] };
  } catch {
    return null;
  }
}

function nextHooksDocument(doc: Record<string, unknown>, groups: CodexHookGroup[]): Record<string, unknown> {
  const hooks = asObject(doc.hooks) ?? {};
  const nextHooks = { ...hooks };
  if (groups.length > 0) nextHooks[EVENT] = groups;
  else delete nextHooks[EVENT];
  const next = { ...doc };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

/** A TOML basic string. JSON escapes are valid TOML except that TOML also forbids a raw DEL. */
function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, '\\u007F');
}

function replaceManagedBlock(raw: string, start: string, end: string, block: string): ManagedTextResult {
  const starts = raw.split(start).length - 1;
  const ends = raw.split(end).length - 1;
  if (starts !== ends || starts > 1) return { warning: 'managed TOML markers are malformed or duplicated' };
  if (starts === 1) {
    const expression = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
    return { text: raw.replace(expression, block) };
  }
  if (!block) return { text: raw };
  return { text: `${raw.trimEnd()}${raw.trim() ? '\n\n' : ''}${block}` };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderMcpBlock(ctx: ApplyContext): string {
  const invocation = resolveOpenloreCommand(
    ['mcp', '--preset', ctx.preset ?? LEAN_DEFAULT_PRESET],
    ctx.platform,
    ctx.platformCommandRuntime,
  );
  return [
    MCP_START,
    '[mcp_servers.openlore]',
    `command = ${tomlString(invocation.command)}`,
    `args = [${invocation.args.map(tomlString).join(', ')}]`,
    MCP_END,
    '',
  ].join('\n');
}

function renderTomlHookBlock(command: string): string {
  return [
    HOOK_START,
    `[[hooks.${EVENT}]]`,
    `matcher = ${tomlString(MANAGED_MATCHER)}`,
    `[[hooks.${EVENT}.hooks]]`,
    'type = "command"',
    `command = ${tomlString(command)}`,
    'timeout = 15',
    HOOK_END,
    '',
  ].join('\n');
}

function isManagedText(raw: string, start: string, end: string): boolean {
  return raw.includes(start) && raw.includes(end);
}

interface TomlDefinition {
  /** Full dotted key path, quotes removed. */
  path: string[];
  kind: 'table' | 'array-table' | 'key';
}

function tomlKeySegments(key: string): string[] {
  return (key.match(/"[^"]*"|'[^']*'|[^.]+/g) ?? [])
    .map((segment) => segment.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter((segment) => segment.length > 0);
}

/**
 * Line-based scan of the tables and keys a TOML document defines. Not a parser: it only has
 * to recognize every spelling of a definition OpenLore's appended block would collide with
 * (quoted keys, dotted keys, inline tables under a parent table), so a false positive costs
 * only a warning while a miss would make Codex reject the whole file.
 */
function tomlDefinitions(raw: string): TomlDefinition[] {
  const definitions: TomlDefinition[] = [];
  let table: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*(\[\[?)\s*([^\]#]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = tomlKeySegments(header[2]);
      definitions.push({ path: table, kind: header[1] === '[[' ? 'array-table' : 'table' });
      continue;
    }
    const key = /^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_\-.\s])+?)\s*=/.exec(line);
    if (key) definitions.push({ path: [...table, ...tomlKeySegments(key[1])], kind: 'key' });
  }
  return definitions;
}

function startsWithPath(path: string[], prefix: string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function hasTomlHooks(raw: string): boolean {
  return tomlDefinitions(raw).some((definition) => startsWithPath(definition.path, ['hooks']));
}

/**
 * Whether the document defines `hooks` or `hooks.UserPromptSubmit` in a form an appended
 * `[[hooks.UserPromptSubmit]]` cannot extend (an inline table/array or a plain table): appending
 * there would be a TOML redefinition error.
 */
function hasUnextendableTomlHookEvent(raw: string): boolean {
  return tomlDefinitions(raw).some(({ path, kind }) =>
    (kind === 'key' && (
      (path.length === 1 && path[0] === 'hooks')
      || (path.length === 2 && path[0] === 'hooks' && path[1] === EVENT)))
    || (kind === 'table' && path.length === 2 && path[0] === 'hooks' && path[1] === EVENT));
}

function hasTomlOpenLoreServer(raw: string): boolean {
  return tomlDefinitions(raw).some((definition) => startsWithPath(definition.path, ['mcp_servers', 'openlore']));
}

async function writeManagedText(
  ctx: ApplyContext,
  path: string,
  original: string | null,
  next: string,
  summary: string,
  changes: PlannedChange[],
): Promise<void> {
  if (original === next) {
    changes.push({ path, kind: 'noop', summary: `${path.slice(ctx.root.length + 1)} already up to date` });
    return;
  }
  if (!ctx.dryRun) await confinedAtomicWriteFile(ctx.root, path, next, { preserveMode: true });
  changes.push({
    path,
    kind: original === null ? 'create' : 'update',
    summary,
    preview: `--- ${path.slice(ctx.root.length + 1)}\nOpenLore-managed entries updated; unrelated configuration is preserved.`,
  });
}

async function apply(ctx: ApplyContext): Promise<ApplyResult> {
  const projectBesideUser = ctx.scope !== 'user' && !!ctx.userScopeRoot
    && resolve(ctx.root) !== resolve(ctx.userScopeRoot);
  if (projectBesideUser && await connected(ctx.userScopeRoot!)) {
    const changes: PlannedChange[] = [{ path: safeJoin(ctx.root, CONFIG_REL), kind: 'noop', summary: 'Codex already wired in user scope; skipped duplicate project hook' }];
    const warnings: string[] = [];
    await removeManagedHook(ctx, changes, warnings);
    if (ctx.scope !== 'user') await applyLoopHooks(ctx, changes, warnings);
    return { changes, warnings, conflict: false };
  }
  // A user-scope hook can exist without its MCP server (for example after a
  // partial install). In that case, add the project MCP server but avoid
  // installing a second proposal hook, and drop one an earlier project install left.
  const skipProjectHook = projectBesideUser && await hasManagedHook(ctx.userScopeRoot!);
  const warnings: string[] = [];
  const changes: PlannedChange[] = [];
  const tomlPath = safeJoin(ctx.root, CONFIG_REL);
  const originalToml = await readIfExists(tomlPath);

  // Codex needs both the prompt hook and the OpenLore MCP server for the agent to call orient.
  const mcpBlock = renderMcpBlock(ctx);
  let toml = originalToml ?? '';
  const mcpManaged = replaceManagedBlock(toml, MCP_START, MCP_END, mcpBlock);
  if (mcpManaged.warning) {
    warnings.push(`codex: ${CONFIG_REL} ${mcpManaged.warning}; left unchanged.`);
  } else if (!isManagedText(toml, MCP_START, MCP_END) && hasTomlOpenLoreServer(toml)) {
    warnings.push(`codex: ${CONFIG_REL} already defines mcp_servers.openlore; OpenLore preserved it.`);
  } else {
    toml = mcpManaged.text ?? toml;
  }

  let command: string;
  try {
    command = formatPlatformCommand(
      resolveOpenloreCommand(['orient', '--proposal-only'], ctx.platform, ctx.platformCommandRuntime),
      ctx.platform,
    );
  } catch (error) {
    warnings.push(`codex: could not configure the proposal hook: ${(error as Error).message}`);
    command = '';
  }

  let tomlHookHandled = false;
  if (command && !skipProjectHook && hasTomlHooks(toml) && !isManagedText(toml, HOOK_START, HOOK_END)
    && hasUnextendableTomlHookEvent(toml)) {
    warnings.push(`codex: ${CONFIG_REL} defines hooks.${EVENT} inline; OpenLore preserved it and did not add the proposal hook.`);
    command = '';
  }
  if (command && !skipProjectHook && hasTomlHooks(toml)) {
    const hookBlock = renderTomlHookBlock(command);
    const result = replaceManagedBlock(toml, HOOK_START, HOOK_END, hookBlock);
    if (result.warning) warnings.push(`codex: ${CONFIG_REL} ${result.warning}; left hook unchanged.`);
    else {
      toml = result.text ?? toml;
      tomlHookHandled = true;
    }
  }

  // Validate JSON hooks before writing config.toml so a malformed hooks file cannot
  // leave installation half-applied across the two Codex configuration files.
  const hooksPath = safeJoin(ctx.root, HOOKS_REL);
  const rawHooks = command && !tomlHookHandled && !skipProjectHook ? await readIfExists(hooksPath) : null;
  const parsedHooks = command && !tomlHookHandled && !skipProjectHook ? parseHooks(rawHooks) : null;
  if (command && !tomlHookHandled && !skipProjectHook && !parsedHooks) {
    warnings.push(`codex: refused to rewrite ${HOOKS_REL}; it is not valid JSON with a hooks object.`);
    changes.push({ path: hooksPath, kind: 'noop', summary: `${HOOKS_REL} left untouched (invalid Codex hooks JSON)` });
    return { changes, warnings, conflict: true };
  }

  if (toml !== originalToml) {
    await writeManagedText(ctx, tomlPath, originalToml, toml, `${CONFIG_REL} — OpenLore MCP and hook configuration`, changes);
  }

  // The hook moved into config.toml (the user added TOML hooks after an earlier install wrote
  // hooks.json): drop the earlier managed copy so the proposal hook does not fire twice.
  if (tomlHookHandled) {
    const staleRaw = await readIfExists(hooksPath);
    const stale = staleRaw === null ? null : parseHooks(staleRaw);
    const kept = stale?.groups.filter((group) => asObject(group)?.matcher !== MANAGED_MATCHER);
    if (stale && kept && kept.length !== stale.groups.length) {
      const serialized = JSON.stringify(nextHooksDocument(stale.doc, kept), null, 2) + '\n';
      await writeManagedText(ctx, hooksPath, staleRaw, serialized, `${HOOKS_REL} — moved OpenLore proposal hook to ${CONFIG_REL}`, changes);
    }
  }

  if (command && !tomlHookHandled && !skipProjectHook) {
    const raw = rawHooks;
    const parsed = parsedHooks!;
    const managed = {
      matcher: MANAGED_MATCHER,
      hooks: [{ type: 'command', command, timeout: 15 }],
    };
    const groups = parsed.groups.filter((group) => asObject(group)?.matcher !== MANAGED_MATCHER);
    groups.push(managed);
    const next = JSON.stringify(nextHooksDocument(parsed.doc, groups), null, 2) + '\n';
    await writeManagedText(ctx, hooksPath, raw, next, `${HOOKS_REL} — Codex proposal hook (review/trust in Codex)`, changes);
  }

  if (skipProjectHook) await removeManagedHook(ctx, changes, warnings);
  if (ctx.scope !== 'user') await applyLoopHooks(ctx, changes, warnings);

  return { changes, warnings, conflict: false };
}

/**
 * Write (or, with `remove`, drop) the agent-loop groups in `.codex/hooks.json`, keeping every other
 * group. A hooks file that is not a JSON object of event arrays is left untouched with a warning.
 */
async function applyLoopHooks(ctx: ApplyContext, changes: PlannedChange[], warnings: string[], remove = false): Promise<void> {
  const hooksPath = safeJoin(ctx.root, HOOKS_REL);
  const raw = await readIfExists(hooksPath);
  if (raw === null && remove) return;
  let doc: Record<string, unknown> | null = {};
  if (raw !== null) {
    try { doc = asObject(JSON.parse(raw)); } catch { doc = null; }
  }
  if (!doc || (doc.hooks !== undefined && !asObject(doc.hooks))) {
    warnings.push(`codex: refused to edit ${HOOKS_REL} for the agent-loop hooks; it is not valid JSON with a hooks object.`);
    return;
  }
  const hooks: Record<string, unknown> = { ...(asObject(doc.hooks) ?? {}) };
  for (const { event, moment, matcher, timeout } of LOOP_HOOKS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      warnings.push(`codex: ${HOOKS_REL} hooks.${event} is not a list; OpenLore did not add its ${moment} hook.`);
      continue;
    }
    const kept = ((current ?? []) as unknown[]).filter((g) => !isLoopGroup(g));
    if (!remove) {
      let command: string;
      try {
        command = formatPlatformCommand(resolveOpenloreCommand(['hook', moment, '--harness', 'codex'], ctx.platform, ctx.platformCommandRuntime), ctx.platform);
      } catch (error) {
        warnings.push(`codex: could not configure the ${moment} hook: ${(error as Error).message}`);
        continue;
      }
      kept.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout }] });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  const next = { ...doc };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  const serialized = Object.keys(next).length ? JSON.stringify(next, null, 2) + '\n' : '';
  if (remove && !serialized) {
    if (!ctx.dryRun) await rm(hooksPath, { force: true });
    changes.push({ path: hooksPath, kind: 'update', summary: `${HOOKS_REL} — removed OpenLore agent-loop hooks` });
    return;
  }
  await writeManagedText(ctx, hooksPath, raw, serialized, `${HOOKS_REL} — ${remove ? 'removed OpenLore agent-loop hooks' : 'Codex agent-loop hooks (review/trust in Codex)'}`, changes);
}

/** Remove only the managed proposal hook (TOML block and hooks.json entry) from `ctx.root`. */
async function removeManagedHook(ctx: ApplyContext, changes: PlannedChange[], warnings: string[]): Promise<void> {
  const tomlPath = safeJoin(ctx.root, CONFIG_REL);
  const rawToml = await readIfExists(tomlPath);
  if (rawToml !== null && isManagedText(rawToml, HOOK_START, HOOK_END)) {
    const result = replaceManagedBlock(rawToml, HOOK_START, HOOK_END, '');
    if (result.warning) warnings.push(`codex: ${CONFIG_REL} ${result.warning}; left unchanged.`);
    else if (result.text !== undefined && result.text !== rawToml) {
      const next = result.text.trim() ? `${result.text.trimEnd()}\n` : '';
      await writeManagedText(ctx, tomlPath, rawToml, next, `${CONFIG_REL} — removed OpenLore proposal hook`, changes);
    }
  }
  await removeManagedJsonHook(ctx, changes, warnings);
}

async function removeManagedJsonHook(ctx: ApplyContext, changes: PlannedChange[], warnings: string[]): Promise<void> {
  const hooksPath = safeJoin(ctx.root, HOOKS_REL);
  const rawHooks = await readIfExists(hooksPath);
  if (rawHooks === null) return;
  const parsed = parseHooks(rawHooks);
  if (!parsed) {
    warnings.push(`codex: refused to edit ${HOOKS_REL}; it is not valid JSON with a hooks object.`);
    changes.push({ path: hooksPath, kind: 'noop', summary: `${HOOKS_REL} left untouched (invalid Codex hooks JSON)` });
    return;
  }
  const groups = parsed.groups.filter((group) => asObject(group)?.matcher !== MANAGED_MATCHER);
  if (groups.length === parsed.groups.length) return;
  const serialized = JSON.stringify(nextHooksDocument(parsed.doc, groups), null, 2) + '\n';
  await writeManagedText(ctx, hooksPath, rawHooks, serialized, `${HOOKS_REL} — removed OpenLore proposal hook`, changes);
}

async function uninstall(ctx: ApplyContext): Promise<ApplyResult> {
  const warnings: string[] = [];
  const changes: PlannedChange[] = [];
  const tomlPath = safeJoin(ctx.root, CONFIG_REL);
  const rawToml = await readIfExists(tomlPath);
  if (rawToml !== null) {
    let toml = rawToml;
    for (const [start, end] of [[HOOK_START, HOOK_END], [MCP_START, MCP_END]] as const) {
      const result = replaceManagedBlock(toml, start, end, '');
      if (result.warning) warnings.push(`codex: ${CONFIG_REL} ${result.warning}; left unchanged.`);
      else toml = result.text ?? toml;
    }
    if (toml !== rawToml) await writeManagedText(ctx, tomlPath, rawToml, toml.trim() ? `${toml.trimEnd()}\n` : '', `${CONFIG_REL} — removed OpenLore entries`, changes);
  } else {
    changes.push({ path: tomlPath, kind: 'noop', summary: `${CONFIG_REL} not present` });
  }

  await removeManagedJsonHook(ctx, changes, warnings);
  await applyLoopHooks(ctx, changes, warnings, true);
  return { changes, warnings, conflict: false };
}

async function connected(root: string): Promise<boolean> {
  const toml = await readIfExists(safeJoin(root, CONFIG_REL)) ?? '';
  return await hasManagedHook(root) && (
    isManagedText(toml, MCP_START, MCP_END) || hasTomlOpenLoreServer(toml)
  );
}

async function hasManagedHook(root: string): Promise<boolean> {
  const hooks = parseHooks(await readIfExists(safeJoin(root, HOOKS_REL)));
  const toml = await readIfExists(safeJoin(root, CONFIG_REL)) ?? '';
  return (hooks !== null && hooks.groups.some((group) => asObject(group)?.matcher === MANAGED_MATCHER))
    || isManagedText(toml, HOOK_START, HOOK_END);
}

export const codexAdapter: Adapter = {
  name: 'codex',
  supportsGlobal: true,
  isConnected: connected,
  isConnectedUserScope: connected,
  apply,
  uninstall,
};
