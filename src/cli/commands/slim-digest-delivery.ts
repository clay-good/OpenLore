/**
 * Whether the slim digest actually reaches a Claude Code agent in this repository
 * (change: trim-standing-agent-instructions).
 *
 * A full-digest `@`-import in `CLAUDE.md` is dead weight only when the slim digest replaces it.
 * That holds when all of these hold, and only then:
 * - no Claude settings file sets `disableAllHooks`, and the managed settings file (and its
 *   `managed-settings.d/*.json` drop-ins) neither disables hooks nor allows only managed hooks.
 *   `CLAUDE_CONFIG_DIR` replaces `~/.claude`. MDM profiles, registry policy and server-managed
 *   settings are not read; plugin hooks are not counted. Every gap errs toward "does not reach",
 *   which keeps the import;
 * - the prompt hook (`openlore orient --inject`) is wired and its program exists. A repository-scope
 *   hook makes the user-scope one stand down (`repoWiresStep`), so when the repository wires one,
 *   only repository-scope hooks count. An `npx` command cannot be checked for its program; it
 *   counts as wired;
 * - `hooks.prompt-submitted` is not turned off in `.openlore/config.json`;
 * - the hook would print the digest (`readSlimDigest`: injection on, an index built on this
 *   machine at the default path, a well-formed digest), and the digest fits the injection token
 *   budget beside the silence line, the smallest block a prompt carries with it. A budget that the
 *   task block fills on every prompt can still hold the digest back; that is not predicted here.
 * Any other case keeps the import, so the agent never loses its only repository shape.
 */

import { constants } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSlimDigest } from './orient-inject.js';
import { promptSubmittedOff } from './orient.js';
import { assessHookWiring, claudeSettingsFiles, isUserScopeCommand } from '../install/hook-wiring-health.js';
import { estimateTokens } from '../../core/services/llm-service.js';
import { SILENCE_CONTRACT_LINE, resolveInjectionConfig } from './orient-inject-render.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';

const SETTINGS_MAX_BYTES = 1_048_576;

/**
 * Whether a settings file is absent, a regular file this check may read, or something it refuses
 * (a FIFO, a device, a directory, an oversized file). Opened with O_NONBLOCK so a FIFO a hostile
 * repository ships at `.claude/settings.json` cannot block the command. Symlinks are followed:
 * `~/.claude` is often a link into a dotfiles repository.
 */
async function settingsFileState(path: string): Promise<'absent' | 'ok' | 'refused'> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'refused';
  }
  try {
    const s = await handle.stat();
    return s.isFile() && s.size <= SETTINGS_MAX_BYTES ? 'ok' : 'refused';
  } catch {
    return 'refused';
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Claude Code's managed policy settings file, per platform. */
export function managedSettingsFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** The managed file and the `managed-settings.d/*.json` drop-ins beside it. */
async function managedFiles(managed: string): Promise<string[]> {
  const dir = join(dirname(managed), 'managed-settings.d');
  try {
    return [managed, ...(await readdir(dir)).filter(n => n.endsWith('.json')).sort().map(n => join(dir, n))];
  } catch {
    return [managed];
  }
}

async function hooksDisabled(files: readonly string[], managed: readonly string[]): Promise<boolean> {
  for (const file of [...files, ...managed]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { disableAllHooks?: unknown; allowManagedHooksOnly?: unknown };
      if (parsed?.disableAllHooks === true) return true;
      if (managed.includes(file) && parsed?.allowManagedHooksOnly === true) return true;
    } catch { /* absent or unreadable: no setting */ }
  }
  return false;
}

export async function slimDigestReachesAgent(
  rootPath: string,
  home: string = process.env.OPENLORE_HOME || homedir(),
  managed: string = managedSettingsFile(),
): Promise<boolean> {
  try {
    if (promptSubmittedOff(rootPath)) return false;
    const files = claudeSettingsFiles(rootPath, home);
    // Claude Code reads user settings from CLAUDE_CONFIG_DIR, in place of ~/.claude, when it is set.
    if (process.env.CLAUDE_CONFIG_DIR) files[0] = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
    // A settings file that is not a small regular file is not read; the import stays.
    const policy = await managedFiles(managed);
    const states = await Promise.all([...files, ...policy].map(settingsFileState));
    if (states.includes('refused')) return false;
    if (await hooksDisabled(files, policy)) return false;
    const { hooks, missing } = await assessHookWiring(files);
    const inject = hooks.filter(h => h.event === 'UserPromptSubmit' && h.step === 'orient --inject');
    const repoScoped = inject.filter(h => !isUserScopeCommand(h.command));
    const running = repoScoped.length ? repoScoped : inject;
    const broken = new Set(missing.map(m => m.hook));
    if (!running.some(h => !broken.has(h))) return false;
    const slim = await readSlimDigest(rootPath);
    return slim !== undefined && estimateTokens(`${slim.text}\n\n${SILENCE_CONTRACT_LINE}`) <= slim.tokenBudget;
  } catch {
    return false;
  }
}

/**
 * A configured reason the prompt hook will not print the slim digest, or null when none is set.
 * Unlike `slimDigestReachesAgent` (which errs toward "no"), this names only a definite negative
 * a user chose, so a status note built on it is exact.
 */
export async function slimDigestWithheldByConfig(rootPath: string): Promise<string | null> {
  if (promptSubmittedOff(rootPath)) return '`hooks.prompt-submitted` is false in .openlore/config.json';
  try {
    const cfg = resolveInjectionConfig((await readOpenLoreConfig(rootPath))?.contextInjection);
    if (cfg.mode === 'off') return '`contextInjection.mode` is "off" in .openlore/config.json';
  } catch { /* unreadable config: the hook uses its defaults */ }
  return null;
}
