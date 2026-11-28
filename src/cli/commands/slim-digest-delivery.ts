/**
 * Whether the slim digest actually reaches a Claude Code agent in this repository
 * (change: trim-standing-agent-instructions).
 *
 * A full-digest `@`-import in `CLAUDE.md` is dead weight only when the slim digest replaces it.
 * That holds when all of these hold, and only then:
 * - no Claude settings file sets `disableAllHooks`, and managed policy settings neither disable
 *   hooks nor allow only managed hooks (`CLAUDE_CONFIG_DIR` relocates the user settings);
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

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSlimDigest } from './orient-inject.js';
import { promptSubmittedOff } from './orient.js';
import { assessHookWiring, claudeSettingsFiles, isUserScopeCommand } from '../install/hook-wiring-health.js';
import { estimateTokens } from '../../core/services/llm-service.js';
import { SILENCE_CONTRACT_LINE } from './orient-inject-render.js';

/** Claude Code's managed policy settings, per platform. */
export function managedSettingsFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

async function hooksDisabled(files: readonly string[], managed: string): Promise<boolean> {
  for (const file of [...files, managed]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { disableAllHooks?: unknown; allowManagedHooksOnly?: unknown };
      if (parsed?.disableAllHooks === true) return true;
      if (file === managed && parsed?.allowManagedHooksOnly === true) return true;
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
    // Claude Code reads user settings from CLAUDE_CONFIG_DIR when it is set.
    if (process.env.CLAUDE_CONFIG_DIR) files.push(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'));
    if (await hooksDisabled(files, managed)) return false;
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
