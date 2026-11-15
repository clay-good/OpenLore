/**
 * The one rule for which OpenLore project a working directory belongs to. The agent-loop hooks,
 * the status line and the Pi extension all ask this; when each walked differently, a status line
 * could report a project the hooks ignored, and a stray `.openlore/` could capture the hooks.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { OPENLORE_ANALYSIS_REL_PATH, OPENLORE_CONFIG_REL_PATH } from '../constants.js';
import { globalOpenLoreConfigPath } from './config-layers.js';

/**
 * Whether `dir` is an OpenLore project: its `.openlore/` holds a config or an analysis. A bare
 * `.openlore/` (logs or telemetry a tool left behind) is not a project, and the user-level config
 * (`~/.openlore/config.json`) shares the relative path but marks no project.
 */
export function isOpenloreProject(dir: string): boolean {
  const config = join(dir, OPENLORE_CONFIG_REL_PATH);
  return (config !== globalOpenLoreConfigPath() && existsSync(config)) || existsSync(join(dir, OPENLORE_ANALYSIS_REL_PATH));
}

/**
 * The nearest OpenLore project at or above `start`, within the same repository: the walk stops at
 * the repository's top (a `.git` entry), so a nested repository never reports its parent, and never
 * accepts the home directory, whose `.openlore/` is the user-level store.
 */
export function openloreProjectRoot(start: string): string | undefined {
  const home = resolve(process.env.OPENLORE_HOME ?? homedir());
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (dir === home) return undefined;
    if (isOpenloreProject(dir)) return dir;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return undefined;
  }
}
