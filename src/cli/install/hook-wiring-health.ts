/**
 * The health of the agent-loop hooks wired in Claude Code settings (change: hook-reliability,
 * task 8.3), read by `openlore doctor`.
 *
 * Two faults make a hook wrong without any error the user sees:
 * - its runtime is gone (a moved or removed install, a removed Node): every event then fails with
 *   `Cannot find module`;
 * - two different OpenLore commands run on the same event and step (a second checkout, or a group
 *   written before install marked its groups): the agent gets two briefings, possibly from two
 *   versions that disagree about one index.
 *
 * Claude Code runs an identical command string once, so only distinct commands count as
 * duplicates. Read-only.
 */
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { isAbsolute, join, win32 } from 'node:path';
import { isOpenloreCliEntryPath } from '../../utils/platform-command.js';

export interface WiredHook {
  /** The settings file it is in. */
  file: string;
  event: string;
  /** What it runs: `orient --inject`, `orient --json`, `hook <moment>`, … */
  step: string;
  command: string;
  /** Written by `openlore install` (it carries the `_openlore` marker). */
  marked: boolean;
}

export interface HookWiringHealth {
  hooks: WiredHook[];
  /** Absolute runtime paths a wired command names that do not exist. */
  missing: Array<{ hook: WiredHook; path: string }>;
  /** Event + step pairs that run more than one distinct OpenLore command. */
  duplicates: Array<{ event: string; step: string; hooks: WiredHook[] }>;
}

/** Split a shell command into words, honoring single and double quotes. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let inWord = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (/\s/.test(ch)) {
      if (inWord) { words.push(cur); cur = ''; inWord = false; }
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (inWord) words.push(cur);
  return words;
}

/** The OpenLore step a command runs, or undefined when it is not an OpenLore command. */
export function openloreStep(command: string): string | undefined {
  const words = shellWords(command);
  const isOpenlore = (w: string) => isOpenloreCliEntryPath(w) || w === 'openlore' || /[\\/]openlore(\.cmd|\.exe)?$/i.test(w);
  // The last mention: a guarded command names the entry first in its `[ -f … ]` test.
  let at = -1;
  words.forEach((w, i) => { if (isOpenlore(w) && words[i + 1] !== ']') at = i; });
  if (at < 0) return undefined;
  const rest = words.slice(at + 1);
  if (rest[0] === 'orient') return rest.includes('--inject') ? 'orient --inject' : rest.includes('--json') ? 'orient --json' : 'orient';
  if (rest[0] === 'hook' && rest[1]) return `hook ${rest[1]}`;
  return rest[0];
}

function isAbsolutePath(p: string): boolean {
  return isAbsolute(p) || win32.isAbsolute(p);
}

async function readHooks(file: string): Promise<WiredHook[]> {
  let parsed: { hooks?: Record<string, unknown> };
  try { parsed = JSON.parse(await readFile(file, 'utf8')) as typeof parsed; } catch { return []; }
  const out: WiredHook[] = [];
  for (const [event, groups] of Object.entries(parsed?.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g || typeof g !== 'object') continue;
      const group = g as { _openlore?: unknown; hooks?: unknown };
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        const command = (h as { command?: unknown })?.command;
        if (typeof command !== 'string') continue;
        const step = openloreStep(command);
        if (step) out.push({ file, event, step, command, marked: group._openlore === true });
      }
    }
  }
  return out;
}

/** Assess the hooks in these settings files (user scope first, then project). */
export async function assessHookWiring(files: readonly string[]): Promise<HookWiringHealth> {
  const hooks = (await Promise.all(files.map(readHooks))).flat();
  const missing: HookWiringHealth['missing'] = [];
  for (const hook of hooks) {
    const words = shellWords(hook.command);
    const runtime = [...new Set(words.filter(w => isAbsolutePath(w) && (isOpenloreCliEntryPath(w) || /(^|[\\/])node(\.exe)?$/i.test(w))))];
    for (const path of runtime) {
      try { await access(path, fsConstants.F_OK); } catch { missing.push({ hook, path }); }
    }
  }
  const byStep = new Map<string, WiredHook[]>();
  for (const hook of hooks) {
    const key = `${hook.event}\0${hook.step}`;
    byStep.set(key, [...(byStep.get(key) ?? []), hook]);
  }
  const duplicates: HookWiringHealth['duplicates'] = [];
  for (const group of byStep.values()) {
    // A user-scope command stands down at run time when a repo-scope one runs the same step, so
    // that pair is one step, not a duplicate (change: user-scope-loop-hooks).
    const repoScoped = group.filter(h => !isUserScopeCommand(h.command));
    const running = repoScoped.length ? repoScoped : group;
    if (new Set(running.map(h => h.command)).size > 1) duplicates.push({ event: group[0].event, step: group[0].step, hooks: running });
  }
  return { hooks, missing, duplicates };
}

/** Whether a command is the user-scope form, which stands down for a repository's own wiring. */
export function isUserScopeCommand(command: string): boolean {
  const words = shellWords(command);
  return words.some((w, i) => w === '--scope' && words[i + 1] === 'user');
}

/**
 * True when the repository's own Claude settings (`.claude/settings.json` or
 * `settings.local.json` in any of `dirs`) wire this OpenLore step with a repo-scope command. The
 * user-scope command then does nothing, so a repository wired at both scopes gets each receipt
 * once (change: user-scope-loop-hooks). Synchronous and cheap: it runs on every hook event.
 */
export function repoWiresStep(dirs: ReadonlyArray<string | undefined>, step: string): boolean {
  for (const dir of new Set(dirs.filter((d): d is string => !!d))) {
    for (const name of ['settings.json', 'settings.local.json']) {
      let parsed: { hooks?: Record<string, unknown> };
      try { parsed = JSON.parse(readFileSync(join(dir, '.claude', name), 'utf8')) as typeof parsed; } catch { continue; }
      for (const groups of Object.values(parsed?.hooks ?? {})) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of Array.isArray((g as { hooks?: unknown })?.hooks) ? (g as { hooks: unknown[] }).hooks : []) {
            const command = (h as { command?: unknown })?.command;
            if (typeof command === 'string' && openloreStep(command) === step && !isUserScopeCommand(command)) return true;
          }
        }
      }
    }
  }
  return false;
}

/** The Claude Code settings files that can hold hooks for this repository. */
export function claudeSettingsFiles(rootPath: string, home: string): string[] {
  return [
    join(home, '.claude', 'settings.json'),
    join(rootPath, '.claude', 'settings.json'),
    join(rootPath, '.claude', 'settings.local.json'),
  ];
}
