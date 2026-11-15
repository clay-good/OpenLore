/**
 * openlore init command
 *
 * Verifies we're in a valid project and creates .openlore configuration.
 * Detects project type, existing OpenSpec setup, and prepares for analysis.
 */

import { Command } from 'commander';
import { resolve, relative } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { logger } from '../../utils/logger.js';
import {
  detectProjectType,
  getProjectTypeName,
} from '../../core/services/project-detector.js';
import {
  getDefaultConfig,
  readOpenLoreConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  readOpenSpecConfig,
  openspecDirExists,
  openspecConfigExists,
  detectExistingSpecDir,
} from '../../core/services/config-manager.js';
import {
  gitignoreExists,
  isInGitignore,
  ensureGitignored,
} from '../../core/services/gitignore-manager.js';
import {
  OPENLORE_DIR,
  OPENLORE_CONFIG_REL_PATH,
  DEFAULT_OPENSPEC_PATH,
} from '../../constants.js';
import type { InitOptions } from '../../types/index.js';

export const initCommand = new Command('init')
  .description('Initialize openlore in the current project')
  .option('--force', 'Overwrite existing configuration', false)
  .option(
    '--openspec-path <path>',
    // No commander default: an always-set value hid the detection below (it never ran) and
    // recorded a spec path in every config (change: spec-framework-neutrality, task 3.1).
    `Path of an OpenSpec folder (default: an OpenSpec corpus found here, else ${DEFAULT_OPENSPEC_PATH} when generate writes)`,
  )
  .addHelpText(
    'after',
    `
Examples:
  $ openlore init                    Initialize with defaults
  $ openlore init --force            Overwrite existing config
  $ openlore init --openspec-path ./docs/specs
                                     Use custom output path

What this command does:
  1. Detects project type (Node.js, Python, Rust, Go, etc.)
  2. Checks for existing OpenSpec setup
  3. Creates .openlore/config.json configuration file
  4. Updates .gitignore to exclude .openlore/
  5. Prepares project for analysis

After initialization, run 'openlore analyze' to scan your codebase.
`
  )
  .action(async (options: Partial<InitOptions>) => {
    const rootPath = process.cwd();
    // Honor an explicit --openspec-path; otherwise detect specs that already
    // live in docs/specs/ or specs/ so we don't create an empty openspec/ that
    // is blind to them (Spec 26 B5).
    let openspecRelPath = options.openspecPath ?? DEFAULT_OPENSPEC_PATH;
    let detectedSpecDir = null as Awaited<ReturnType<typeof detectExistingSpecDir>>;
    if (!options.openspecPath) {
      detectedSpecDir = await detectExistingSpecDir(rootPath);
      if (detectedSpecDir && detectedSpecDir.root !== 'openspec') {
        openspecRelPath = detectedSpecDir.root === '.' ? '.' : detectedSpecDir.root;
      }
    }
    const openspecPath = resolve(rootPath, openspecRelPath);
    const force = options.force ?? false;

    // Prevent path traversal — openspec directory must be within the project root
    const relPath = relative(rootPath, openspecPath);
    if (relPath.startsWith('..')) {
      logger.error('OpenSpec path must be within the project directory.');
      process.exitCode = 1;
      return;
    }

    logger.section('Initializing openlore');

    // Step 1: Project Detection
    logger.discovery('Detecting project type...');

    const detection = await detectProjectType(rootPath);

    if (!detection.hasGit) {
      logger.warning('No .git directory found. This may not be a repository root.');
      logger.debug('Continuing anyway - openlore works without git');
    } else {
      logger.debug('Git repository detected');
    }

    if (detection.projectType === 'unknown') {
      logger.warning('Could not detect project type. No known manifest files found.');
      logger.info('Supported', 'package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml, Gemfile, composer.json');
    } else {
      logger.success(`Detected ${getProjectTypeName(detection.projectType)} project`);
      if (detection.manifestFile) {
        logger.debug(`Found manifest: ${detection.manifestFile}`);
      }
      if (detection.confidence !== 'high') {
        logger.debug(`Detection confidence: ${detection.confidence}`);
      }
    }

    logger.blank();

    // Step 2: Check for existing configurations
    logger.discovery('Checking for existing configurations...');

    const existingOpenLoreConfig = await openloreConfigExists(rootPath);
    const existingOpenspecDir = await openspecDirExists(openspecPath);
    const existingOpenspecConfig = await openspecConfigExists(openspecPath);

    if (existingOpenLoreConfig && !force) {
      logger.warning(`${OPENLORE_CONFIG_REL_PATH} already exists`);

      const existingConfig = await readOpenLoreConfig(rootPath);
      if (existingConfig) {
        logger.info('Existing project type', getProjectTypeName(existingConfig.projectType));
        logger.info('Created', existingConfig.createdAt);
        if (existingConfig.lastRun) {
          logger.info('Last run', existingConfig.lastRun);
        }
      }

      logger.blank();

      // Check if running in TTY for interactive prompt
      if (process.stdin.isTTY) {
        const overwrite = await confirm({
          message: 'Overwrite existing configuration?',
          default: false,
        });

        if (!overwrite) {
          logger.info('Aborted', 'Use --force to overwrite without prompting');
          return;
        }
      } else {
        logger.error('Configuration exists. Use --force to overwrite in non-interactive mode.');
        process.exitCode = 1;
        return;
      }
    }

    if (detectedSpecDir && detectedSpecDir.root !== 'openspec') {
      logger.success(
        `Found existing specs in ${detectedSpecDir.specsRel}/ (${detectedSpecDir.count} file(s)) — pointing openspecPath at ${openspecRelPath}`
      );
    } else if (existingOpenspecDir) {
      logger.success('Found existing openspec/ directory');
      if (existingOpenspecConfig) {
        const openspecConfig = await readOpenSpecConfig(openspecPath);
        if (openspecConfig?.context) {
          logger.info('Existing context', 'Will preserve during generation');
        }
        logger.debug('Will integrate with existing OpenSpec setup');
      }
    } else {
      logger.debug('No existing openspec/ directory');
    }

    logger.blank();

    // Step 3: Create configuration
    logger.analysis('Creating configuration...');

    // The spec path is recorded only when a corpus was found or named (spec-framework-neutrality 3.1).
    const config = getDefaultConfig(detection.projectType, options.openspecPath ?? (detectedSpecDir ? openspecRelPath : undefined));

    await writeOpenLoreConfig(rootPath, config);
    logger.success(`Created ${OPENLORE_CONFIG_REL_PATH}`);

    // No spec folder is created here: OpenLore works without one, and `openlore generate` creates
    // what it writes (change: spec-framework-neutrality, task 1.1).

    // Step 5: Update .gitignore
    logger.blank();
    logger.discovery('Checking .gitignore...');

    const hasGitignore = await gitignoreExists(rootPath);
    const alreadyIgnored = hasGitignore && (await isInGitignore(rootPath, `${OPENLORE_DIR}/`));

    if (alreadyIgnored) {
      logger.debug(`${OPENLORE_DIR}/ already in .gitignore`);
    } else {
      // Whether or not a .gitignore already exists, ensure .openlore/ is ignored.
      // A fresh `git init` repo has no .gitignore yet; addToGitignore creates one.
      // Without this, analysis artifacts (multi-MB lance binaries) leak into git
      // status and pollute diff-based tools (impact-certificate, blast-radius).
      let shouldAdd = true;

      if (process.stdin.isTTY) {
        shouldAdd = await confirm({
          message: `Add ${OPENLORE_DIR}/ to .gitignore? (recommended)`,
          default: true,
        });
      }

      if (shouldAdd) {
        const result = await ensureGitignored(rootPath, `${OPENLORE_DIR}/`);
        logger.success(
          result === 'created'
            ? `Created .gitignore with ${OPENLORE_DIR}/`
            : `Added ${OPENLORE_DIR}/ to .gitignore`
        );
      } else {
        logger.warning(`${OPENLORE_DIR}/ not added to .gitignore`);
        logger.debug('Analysis artifacts may be committed to version control');
      }
    }

    // Step 6: Output summary
    logger.blank();
    logger.section('Initialization Complete');

    logger.info('Project type', getProjectTypeName(detection.projectType));
    logger.info('Config file', OPENLORE_CONFIG_REL_PATH);
    logger.info('Spec source', options.openspecPath || detectedSpecDir ? openspecRelPath : 'none found (OpenSpec is optional)');

    if (existingOpenspecDir) {
      logger.info('Integration', 'Will add to existing OpenSpec setup');
    }

    logger.blank();
    logger.success('Ready for analysis!');
    logger.blank();
    logger.info('Next step', "Run 'openlore analyze' to scan your codebase");
  });
