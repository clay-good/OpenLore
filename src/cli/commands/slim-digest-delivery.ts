/**
 * Whether the slim digest actually reaches a Claude Code agent in this repository
 * (change: trim-standing-agent-instructions).
 *
 * A full-digest `@`-import in `CLAUDE.md` is dead weight only when the slim digest replaces it.
 * That holds when all of these hold, and only then:
 * - the prompt hook (`openlore orient --inject`) is wired in the user or project Claude settings;
 * - `hooks.prompt-submitted` is not turned off in `.openlore/config.json`;
 * - the hook would print the digest (`readSlimDigest`: injection on, an index built on this
 *   machine at the default path, a well-formed digest).
 * Any other case keeps the import, so the agent never loses its only repository shape.
 */

import { homedir } from 'node:os';
import { readSlimDigest } from './orient-inject.js';
import { promptSubmittedOff } from './orient.js';
import { assessHookWiring, claudeSettingsFiles } from '../install/hook-wiring-health.js';

export async function slimDigestReachesAgent(
  rootPath: string,
  home: string = process.env.OPENLORE_HOME || homedir(),
): Promise<boolean> {
  try {
    if (promptSubmittedOff(rootPath)) return false;
    const { hooks } = await assessHookWiring(claudeSettingsFiles(rootPath, home));
    if (!hooks.some(h => h.event === 'UserPromptSubmit' && h.step === 'orient --inject')) return false;
    return (await readSlimDigest(rootPath)) !== undefined;
  } catch {
    return false;
  }
}
