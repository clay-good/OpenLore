/**
 * openlore init — programmatic API
 *
 * Detects project type and creates openlore configuration.
 * Performs the documented filesystem initialization without process control or console output.
 */

import { resolve } from 'node:path';
import { OPENLORE_DIR, OPENLORE_CONFIG_REL_PATH, DEFAULT_OPENSPEC_PATH } from '../constants.js';
import {
  detectProjectType,
  getProjectTypeName,
} from '../core/services/project-detector.js';
import {
  getDefaultConfig,
  readOpenLoreConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  openspecDirExists,
  createOpenSpecStructure,
  detectExistingSpecDir,
} from '../core/services/config-manager.js';
import { ensureGitignored } from '../core/services/gitignore-manager.js';
import type { InitApiOptions, InitResult, ProgressCallback } from './types.js';
import { safeJoin } from '../utils/path-confinement.js';
import { withLoggerOptions } from '../utils/logger.js';
import { errors, isOpenLoreError } from '../utils/errors.js';

function progress(onProgress: ProgressCallback | undefined, step: string, status: 'start' | 'progress' | 'complete' | 'skip', detail?: string): void {
  onProgress?.({ phase: 'init', step, status, detail });
}

/**
 * Initialize openlore in a project directory.
 *
 * Creates `.openlore/config.json`, the `openspec/` directory structure,
 * and updates `.gitignore`.
 *
 * @throws OpenLoreError if initialization fails; an existing config returns `created: false`
 */
async function init(options: InitApiOptions): Promise<InitResult> {
  const rootPath = resolve(options.rootPath ?? process.cwd());
  const configPath = options.configPath ?? OPENLORE_CONFIG_REL_PATH;
  let openspecRelPath = options.openspecPath ?? DEFAULT_OPENSPEC_PATH;
  // Point at existing specs (docs/specs/, specs/) rather than creating an empty
  // openspec/ blind to them, unless an explicit path was given (Spec 26 B5).
  if (!options.openspecPath) {
    const detected = await detectExistingSpecDir(rootPath);
    if (detected && detected.root !== 'openspec') openspecRelPath = detected.root;
  }
  const openspecFullPath = safeJoin(rootPath, openspecRelPath);
  const force = options.force ?? false;
  const { onProgress } = options;

  // Detect project type
  progress(onProgress, 'Detecting project type', 'start');
  const detection = await detectProjectType(rootPath);
  const projectType = getProjectTypeName(detection.projectType);
  progress(onProgress, 'Detecting project type', 'complete', projectType);

  // Check existing config
  const configExists = await openloreConfigExists(rootPath, options.configPath);
  if (configExists && !force) {
    const existingConfig = await readOpenLoreConfig(rootPath, options.configPath);
    progress(onProgress, 'Configuration exists', 'skip');
    return {
      configPath,
      openspecPath: existingConfig?.openspecPath ?? openspecRelPath,
      projectType,
      created: false,
    };
  }

  // Create config
  progress(onProgress, 'Creating configuration', 'start');
  const config = getDefaultConfig(detection.projectType, openspecRelPath);
  await writeOpenLoreConfig(rootPath, config, options.configPath);
  progress(onProgress, 'Creating configuration', 'complete');

  // Create openspec directory
  const hasOpenspec = await openspecDirExists(openspecFullPath);
  if (!hasOpenspec) {
    progress(onProgress, 'Creating openspec directory', 'start');
    await createOpenSpecStructure(openspecFullPath);
    progress(onProgress, 'Creating openspec directory', 'complete');
  } else {
    progress(onProgress, 'OpenSpec directory exists', 'skip');
  }

  // Ensure .openlore/ analysis artifacts (multi-MB lance binaries) are ignored,
  // creating .gitignore when absent so a fresh `git init` repo doesn't leak them.
  progress(onProgress, 'Updating .gitignore', 'start');
  const gitignoreResult = await ensureGitignored(rootPath, `${OPENLORE_DIR}/`, 'openlore analysis artifacts');
  progress(onProgress, 'Updating .gitignore', gitignoreResult === 'present' ? 'skip' : 'complete');

  return {
    configPath,
    openspecPath: openspecRelPath,
    projectType,
    created: true,
  };
}

export function openloreInit(options: InitApiOptions = {}): Promise<InitResult> {
  return withLoggerOptions({ quiet: options.quiet ?? true }, async () => {
    try {
      return await init(options);
    } catch (error) {
      if (isOpenLoreError(error)) throw error;
      throw errors.pipelineFailed(`Initialization failed: ${(error as Error).message}`, error);
    }
  });
}
