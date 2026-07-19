/**
 * Configuration management service
 *
 * Handles reading/writing .openlore/config.json and openspec/config.yaml
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { ProjectType, OpenLoreConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_ANTHROPIC_MODEL,
  OPENLORE_DIR,
  OPENLORE_CONFIG_FILENAME,
  OPENLORE_CONFIG_REL_PATH,
  OPENSPEC_CONFIG_FILENAME,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import { validateOpenLoreConfig, CONFIG_SCHEMA_VERSION } from './config-schema.js';

/**
 * OpenSpec config.yaml structure
 */
export interface OpenSpecConfig {
  schema?: string;
  context?: string;
  'openlore'?: {
    generatedAt?: string;
    domains?: string[];
    confidence?: number;
    sourceProject?: string;
  };
  [key: string]: unknown;
}

/**
 * Process-scoped override for the primary root's config-file location, set by the
 * CLI when the user passes an explicit global `--config <path>` (change:
 * wire-global-config-path). It is keyed to the resolved primary root so it
 * redirects ONLY that root's config file — a federation / spec-store read of a
 * different repository never matches and always resolves to the peer's own
 * `.openlore/config.json`. With no explicit `--config`, this stays null and every
 * path resolves exactly as the default.
 */
let primaryConfigOverride: { root: string; configPath: string } | null = null;

/**
 * Register the explicit config-file path for a primary root. Both arguments are
 * resolved to absolute paths so a later `resolveOpenLoreConfigPath` comparison is
 * stable regardless of how a caller spells the root (`.`, cwd, absolute).
 */
export function setPrimaryConfigPath(rootPath: string, configPath: string): void {
  primaryConfigOverride = { root: resolve(rootPath), configPath: resolve(configPath) };
}

/** Clear the primary-config override (test hook; also for a host reusing the process). */
export function clearPrimaryConfigPath(): void {
  primaryConfigOverride = null;
}

/**
 * The single source of truth for "where is this root's config file". Returns the
 * registered override ONLY when its root matches the resolved `rootPath`; otherwise
 * the default `<rootPath>/.openlore/config.json`. Every config read/write/exists
 * check — and the two direct readers outside this module — routes through here so
 * an explicit `--config` is honored uniformly.
 */
export function resolveOpenLoreConfigPath(rootPath: string): string {
  if (primaryConfigOverride && resolve(rootPath) === primaryConfigOverride.root) {
    return primaryConfigOverride.configPath;
  }
  return join(rootPath, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME);
}

/**
 * Ensure directory exists, creating it if necessary
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    // Ignore if directory already exists
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Get default openlore configuration
 */
export function getDefaultConfig(projectType: ProjectType, openspecPath: string): OpenLoreConfig {
  return {
    version: CONFIG_SCHEMA_VERSION,
    projectType,
    openspecPath,
    analysis: {
      maxFiles: DEFAULT_MAX_FILES,
      includePatterns: [],
      excludePatterns: [],
    },
    generation: {
      model: DEFAULT_ANTHROPIC_MODEL,
      domains: 'auto',
    },
    panicResponse: { mode: 'off' },
    createdAt: new Date().toISOString(),
    lastRun: null,
  };
}

/**
 * Per-process memory of config-validation warnings already emitted, so a hub caller
 * (`readOpenLoreConfig` has ~45 call sites) emits each finding at most once per process
 * instead of once per read (change: add-config-schema-validation).
 */
const emittedConfigWarnings = new Set<string>();

/** Test hook: clear the per-process config-validation warning dedup memory. */
export function resetConfigValidationWarnings(): void {
  emittedConfigWarnings.clear();
}

/**
 * Validate a parsed config against the type-derived schema and emit any findings once
 * per process. Warnings are advisory: a typo'd key, a type mismatch, or a version skew
 * is disclosed and then ignored — never a hard failure, and never emitted for a config
 * that uses only known keys with correctly-typed values (change: add-config-schema-validation).
 *
 * Emitted to STDERR (honoring the logger's quiet/noColor state), not stdout: this is a
 * ~45-caller hub read by machine-output paths — `--json` commands, `orient`, and the MCP
 * JSON-RPC stream — where a warning on stdout would corrupt the output. Humans still see
 * the diagnostic in their terminal; `openlore doctor` additionally surfaces it as a
 * structured `Config schema` finding.
 */
function emitConfigValidationWarnings(configPath: string, parsed: unknown): void {
  const findings = validateOpenLoreConfig(parsed);
  if (findings.length === 0) return;
  const { quiet, noColor } = logger.getOptions();
  if (quiet) return; // errors-only mode — match logger.warning's suppression
  const prefix = noColor ? '[warn]' : '\x1b[33m[warn]\x1b[0m';
  for (const finding of findings) {
    const signature = `${configPath} ${finding.kind} ${finding.key ?? ''}`;
    if (emittedConfigWarnings.has(signature)) continue;
    emittedConfigWarnings.add(signature);
    process.stderr.write(`${prefix} ${OPENLORE_CONFIG_REL_PATH}: ${finding.message}\n`);
  }
}

/**
 * Read openlore configuration from .openlore/config.json
 */
export async function readOpenLoreConfig(rootPath: string): Promise<OpenLoreConfig | null> {
  const configPath = resolveOpenLoreConfigPath(rootPath);
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return null; // File doesn't exist — normal case before init
  }
  let parsed: OpenLoreConfig;
  try {
    parsed = JSON.parse(content) as OpenLoreConfig;
  } catch (err) {
    logger.warning(`Failed to parse ${configPath}: ${(err as Error).message}`);
    logger.warning(`Delete ${configPath} and run 'openlore init' to recreate it.`);
    return null;
  }
  emitConfigValidationWarnings(configPath, parsed);
  return parsed;
}

/**
 * Write openlore configuration to .openlore/config.json
 */
export async function writeOpenLoreConfig(
  rootPath: string,
  config: OpenLoreConfig
): Promise<void> {
  const configPath = resolveOpenLoreConfigPath(rootPath);

  await ensureDir(dirname(configPath));
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Check if openlore config already exists
 */
export async function openloreConfigExists(rootPath: string): Promise<boolean> {
  return fileExists(resolveOpenLoreConfigPath(rootPath));
}

/**
 * Read OpenSpec config.yaml if it exists
 */
export async function readOpenSpecConfig(openspecPath: string): Promise<OpenSpecConfig | null> {
  const configPath = join(openspecPath, OPENSPEC_CONFIG_FILENAME);
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return null; // File doesn't exist — normal case before generate
  }
  try {
    return YAML.parse(content) as OpenSpecConfig;
  } catch (err) {
    logger.warning(`Failed to parse ${configPath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Write OpenSpec config.yaml
 */
export async function writeOpenSpecConfig(
  openspecPath: string,
  config: OpenSpecConfig
): Promise<void> {
  const configPath = join(openspecPath, OPENSPEC_CONFIG_FILENAME);

  await ensureDir(openspecPath);
  await writeFile(configPath, YAML.stringify(config), 'utf-8');
}

/**
 * Check if openspec directory exists
 */
export async function openspecDirExists(openspecPath: string): Promise<boolean> {
  return fileExists(openspecPath);
}

/**
 * Check if openspec/config.yaml exists
 */
export async function openspecConfigExists(openspecPath: string): Promise<boolean> {
  return fileExists(join(openspecPath, OPENSPEC_CONFIG_FILENAME));
}

/**
 * Create minimal OpenSpec directory structure
 */
export async function createOpenSpecStructure(openspecPath: string): Promise<void> {
  await ensureDir(openspecPath);
  await ensureDir(join(openspecPath, 'specs'));
}

/** A spec directory discovered on disk before `init` decides where to point. */
export interface DetectedSpecDir {
  /** openspec-root, relative to the project root (config `openspecPath`). */
  root: string;
  /** The `<root>/specs` directory, relative to the project root. */
  specsRel: string;
  /** Count of `*.md` files found beneath the specs dir. */
  count: number;
}

/**
 * Detect an existing specs directory so `init` does not create an empty
 * `openspec/` blind to specs that already live in `docs/specs/` or `specs/`
 * (Spec 26 B5). Candidate openspec-roots are scanned in priority order; the
 * first whose `<root>/specs` contains at least one `*.md` wins. Returns null
 * when nothing is found.
 */
export async function detectExistingSpecDir(rootPath: string): Promise<DetectedSpecDir | null> {
  // root (relative) → specs live at `<root>/specs`. '.' covers a bare `specs/`.
  const candidateRoots = ['openspec', 'docs', '.'];
  for (const root of candidateRoots) {
    const specsRel = root === '.' ? 'specs' : `${root}/specs`;
    const specsDir = join(rootPath, specsRel);
    let count = 0;
    try {
      const stack = [specsDir];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const d of await readdir(dir, { withFileTypes: true })) {
          if (d.isDirectory()) stack.push(join(dir, d.name));
          else if (d.name.endsWith('.md')) count++;
        }
      }
    } catch {
      continue; // specs dir doesn't exist — try the next candidate
    }
    if (count > 0) return { root, specsRel, count };
  }
  return null;
}

/**
 * Merge existing OpenSpec config with openlore metadata
 */
export function mergeOpenSpecConfig(
  existing: OpenSpecConfig | null,
  openloreMeta: OpenSpecConfig['openlore']
): OpenSpecConfig {
  if (existing) {
    return {
      ...existing,
      'openlore': {
        ...existing['openlore'],
        ...openloreMeta,
      },
    };
  }

  return {
    schema: 'spec-driven',
    context: '',
    'openlore': openloreMeta,
  };
}
