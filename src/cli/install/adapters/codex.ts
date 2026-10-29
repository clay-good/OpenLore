import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

function tomlString(value: string): string {
  return JSON.stringify(value);
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

function hasTomlHooks(raw: string): boolean {
  return /^\s*\[\[?hooks(?:\.|\])/m.test(raw);
}

function hasTomlOpenLoreServer(raw: string): boolean {
  return /^\s*\[\[?mcp_servers\.openlore(?:\.|\])[^\n]*$/m.test(raw);
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
  if (ctx.scope !== 'user' && ctx.userScopeRoot && await connected(ctx.userScopeRoot)) {
    return {
      changes: [{ path: safeJoin(ctx.root, CONFIG_REL), kind: 'noop', summary: 'Codex already wired in user scope; skipped duplicate project hook' }],
      warnings: [],
      conflict: false,
    };
  }
  // A user-scope hook can exist without its MCP server (for example after a
  // partial install). In that case, add the project MCP server but avoid
  // installing a second proposal hook.
  const skipProjectHook = ctx.scope !== 'user'
    && !!ctx.userScopeRoot
    && await hasManagedHook(ctx.userScopeRoot);
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

  return { changes, warnings, conflict: false };
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

  const hooksPath = safeJoin(ctx.root, HOOKS_REL);
  const rawHooks = await readIfExists(hooksPath);
  if (rawHooks !== null) {
    const parsed = parseHooks(rawHooks);
    if (!parsed) {
      warnings.push(`codex: refused to edit ${HOOKS_REL}; it is not valid JSON with a hooks object.`);
      changes.push({ path: hooksPath, kind: 'noop', summary: `${HOOKS_REL} left untouched (invalid Codex hooks JSON)` });
    } else {
      const groups = parsed.groups.filter((group) => asObject(group)?.matcher !== MANAGED_MATCHER);
      if (groups.length !== parsed.groups.length) {
        const serialized = JSON.stringify(nextHooksDocument(parsed.doc, groups), null, 2) + '\n';
        await writeManagedText(ctx, hooksPath, rawHooks, serialized, `${HOOKS_REL} — removed OpenLore proposal hook`, changes);
      }
    }
  }
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
