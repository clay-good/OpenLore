/**
 * Detect which agent surfaces are present in a project tree.
 *
 * We walk up from `cwd` checking up to 3 parent directories for marker files.
 * The first directory that has any marker becomes the "project root" for that
 * surface. `agents-md` is the universal fallback and is always included.
 */

import { access, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export type AgentName = 'claude-code' | 'cursor' | 'cline' | 'continue' | 'pi' | 'agents-md';

export const ALL_AGENTS: AgentName[] = [
  'claude-code',
  'cursor',
  'cline',
  'continue',
  'pi',
  'agents-md',
];

export interface DetectedSurface {
  agent: AgentName;
  /** Absolute path to the directory we will treat as the project root. */
  root: string;
  /** Which marker(s) triggered detection (for the dry-run summary). */
  markers: string[];
}

const PARENTS_TO_CHECK = 3;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function hasClineSettings(p: string): Promise<boolean> {
  const settings = join(p, '.vscode', 'settings.json');
  if (!(await exists(settings))) return false;
  try {
    const raw = await readFile(settings, 'utf8');
    return /"cline\./.test(raw);
  } catch {
    return false;
  }
}

async function detectInDir(dir: string): Promise<DetectedSurface[]> {
  const found: DetectedSurface[] = [];

  // claude-code
  {
    const markers: string[] = [];
    if (await isDir(join(dir, '.claude'))) markers.push('.claude/');
    if (await exists(join(dir, 'CLAUDE.md'))) markers.push('CLAUDE.md');
    if (markers.length) found.push({ agent: 'claude-code', root: dir, markers });
  }

  // cursor
  {
    const markers: string[] = [];
    if (await isDir(join(dir, '.cursor'))) markers.push('.cursor/');
    if (await exists(join(dir, '.cursorrules'))) markers.push('.cursorrules');
    if (markers.length) found.push({ agent: 'cursor', root: dir, markers });
  }

  // cline
  {
    const markers: string[] = [];
    if (await exists(join(dir, '.clinerules'))) markers.push('.clinerules');
    if (await hasClineSettings(dir)) markers.push('.vscode/settings.json (cline.*)');
    if (markers.length) found.push({ agent: 'cline', root: dir, markers });
  }

  // continue
  {
    const markers: string[] = [];
    if (await isDir(join(dir, '.continue'))) markers.push('.continue/');
    if (markers.length) found.push({ agent: 'continue', root: dir, markers });
  }

  // pi — project-local extension/settings dir (pi.dev)
  {
    const markers: string[] = [];
    if (await isDir(join(dir, '.pi'))) markers.push('.pi/');
    if (await exists(join(dir, '.pi', 'settings.json'))) markers.push('.pi/settings.json');
    if (markers.length) found.push({ agent: 'pi', root: dir, markers });
  }

  return found;
}

/**
 * Detect surfaces by walking up from `startDir` up to PARENTS_TO_CHECK levels.
 * Each surface is reported at most once, anchored at the deepest dir where its
 * marker was found. `agents-md` is always appended last as a universal fallback.
 */
export async function detect(startDir: string): Promise<DetectedSurface[]> {
  const seen = new Set<AgentName>();
  const out: DetectedSurface[] = [];
  let dir = resolve(startDir);
  for (let i = 0; i <= PARENTS_TO_CHECK; i++) {
    for (const s of await detectInDir(dir)) {
      if (seen.has(s.agent)) continue;
      seen.add(s.agent);
      out.push(s);
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // No in-tree markers at all: bias toward the agent homes the user actually has
  // (~/.claude — the headline audience; ~/.pi — a global Pi install writes no
  // project marker) rather than silently targeting only AGENTS.md and mis-wiring
  // a clean repo (Spec 26 B6B).
  if (out.length === 0) {
    const homes: Array<[AgentName, string]> = [
      ['claude-code', '.claude'],
      ['pi', '.pi'],
    ];
    for (const [agent, homeDir] of homes) {
      if (await isDir(join(homedir(), homeDir))) {
        out.push({ agent, root: resolve(startDir), markers: [`(~/${homeDir} present)`] });
      }
    }
  }

  // Universal fallback — anchored at the first detected root, or cwd.
  const fallbackRoot = out[0]?.root ?? resolve(startDir);
  out.push({ agent: 'agents-md', root: fallbackRoot, markers: ['(fallback)'] });
  return out;
}
