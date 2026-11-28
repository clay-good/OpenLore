/**
 * Whether the slim digest actually reaches a Claude Code agent in this repository
 * (change: trim-standing-agent-instructions).
 *
 * A full-digest `@`-import in `CLAUDE.md` is dead weight only when the slim digest replaces it.
 * That holds when all of these hold, and only then:
 * - no Claude settings file sets `disableAllHooks`;
 * - the prompt hook (`openlore orient --inject`) is wired and its program exists. A repository-scope
 *   hook makes the user-scope one stand down (`repoWiresStep`), so when the repository wires one,
 *   only repository-scope hooks count. An `npx` command cannot be checked for its program; it
 *   counts as wired;
 * - `hooks.prompt-submitted` is not turned off in `.openlore/config.json`;
 * - the hook would print the digest (`readSlimDigest`: injection on, an index built on this
 *   machine at the default path, a well-formed digest), and the digest alone fits the injection
 *   token budget.
 * Any other case keeps the import, so the agent never loses its only repository shape.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readSlimDigest } from './orient-inject.js';
import { promptSubmittedOff } from './orient.js';
import { assessHookWiring, claudeSettingsFiles, isUserScopeCommand } from '../install/hook-wiring-health.js';
import { estimateTokens } from '../../core/services/llm-service.js';

async function hooksDisabled(files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { disableAllHooks?: unknown };
      if (parsed?.disableAllHooks === true) return true;
    } catch { /* absent or unreadable: no setting */ }
  }
  return false;
}

export async function slimDigestReachesAgent(
  rootPath: string,
  home: string = process.env.OPENLORE_HOME || homedir(),
): Promise<boolean> {
  try {
    if (promptSubmittedOff(rootPath)) return false;
    const files = claudeSettingsFiles(rootPath, home);
    if (await hooksDisabled(files)) return false;
    const { hooks, missing } = await assessHookWiring(files);
    const inject = hooks.filter(h => h.event === 'UserPromptSubmit' && h.step === 'orient --inject');
    const repoScoped = inject.filter(h => !isUserScopeCommand(h.command));
    const running = repoScoped.length ? repoScoped : inject;
    const broken = new Set(missing.map(m => m.hook));
    if (!running.some(h => !broken.has(h))) return false;
    const slim = await readSlimDigest(rootPath);
    return slim !== undefined && estimateTokens(slim.text) <= slim.tokenBudget;
  } catch {
    return false;
  }
}
