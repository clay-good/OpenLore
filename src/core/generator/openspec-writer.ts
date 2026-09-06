/**
 * OpenSpec Writer
 *
 * Takes generated specifications and writes them to the OpenSpec directory structure.
 * Handles initialization, merging with existing specs, and output tracking.
 */

import { readFile, writeFile, mkdir, cp, copyFile, readdir, rm } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import logger from '../../utils/logger.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_BACKUPS_SUBDIR,
  OPENLORE_OUTPUTS_SUBDIR,
  OPENLORE_LOGS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  OPENSPEC_DECISIONS_SUBDIR,
  OPENSPEC_CONFIG_FILENAME,
  ARTIFACT_GENERATION_REPORT,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { toRepositoryPath } from '../analyzer/file-walker.js';
import { detectOpenSpecPackageVersion, OPENLORE_PACKAGE_VERSION } from '../runtime/package-versions.js';
import {
  OpenSpecConfigManager,
  buildDetectedContext,
  normalizeDomainName,
  validateFullSpec,
  type OpenLoreMetadata,
} from './openspec-compat.js';
import type { GeneratedSpec } from './openspec-format-generator.js';
import type { ProjectSurveyResult } from './spec-pipeline.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Write mode for handling existing specs
 */
export type WriteMode = 'replace' | 'merge' | 'skip';

/**
 * Options for OpenSpec writer
 */
export interface OpenSpecWriterOptions {
  /** Root path of the project */
  rootPath: string;
  /** Concrete OpenSpec root. Defaults to `<rootPath>/openspec`. */
  openspecRoot?: string;
  /**
   * Concrete `.openlore` root for backups, outputs, and logs. Defaults to
   * `<rootPath>/.openlore`. A preview (`generate --dry-run`) redirects it into its
   * throwaway workspace so the project tree really is left byte-identical.
   */
  openloreRoot?: string;
  /** How to handle existing specs */
  writeMode?: WriteMode;
  /** Version string for generated specs */
  version?: string;
  /** Whether to create backups */
  createBackups?: boolean;
  /** Whether to update config.yaml */
  updateConfig?: boolean;
  /** Whether to validate specs before writing */
  validateBeforeWrite?: boolean;
  /** Remove existing domain directories not present in the new generation (used with --force) */
  cleanBeforeWrite?: boolean;
}

/**
 * Result of writing a single spec
 */
export interface WriteResult {
  path: string;
  action: 'written' | 'skipped' | 'merged' | 'backed_up';
  success: boolean;
  error?: string;
  backupPath?: string;
}

/**
 * Generation report
 */
export interface GenerationReport {
  timestamp: string;
  openspecVersion: string;
  openloreVersion: string;
  configSchemaVersion: string;
  filesWritten: string[];
  filesSkipped: string[];
  filesBackedUp: string[];
  filesMerged: string[];
  domainsRemoved: string[];
  configUpdated: boolean;
  validationErrors: string[];
  warnings: string[];
  nextSteps: string[];
}

/**
 * Stale-domain cleanup is destructive, so it is authorized only by an unfiltered
 * full regeneration. A domain filter scopes what is written; it is not a delete list.
 * (change: harden-openspec-writer-fidelity)
 */
export function shouldCleanStaleDomains(
  force: boolean | undefined,
  domains: readonly string[] | undefined,
  adrOnly: boolean | undefined,
): boolean {
  return force === true && (domains?.length ?? 0) === 0 && adrOnly !== true;
}

const GENERATED_SECTION_START = '<!-- openlore-generated -->';
const GENERATED_SECTION_HEADING = '## Generated Analysis';
const GENERATED_SECTION_END = '<!-- /openlore-generated -->';
const ESCAPED_GENERATED_SECTION_START = '&lt;!-- openlore-generated --&gt;';
const ESCAPED_GENERATED_SECTION_END = '&lt;!-- /openlore-generated --&gt;';
const RESERVED_SPEC_DIRECTORIES = new Set(['overview', 'architecture']);

// ============================================================================
// OPENSPEC WRITER
// ============================================================================

/**
 * OpenSpec Writer - writes generated specs to the OpenSpec directory structure
 */
export class OpenSpecWriter {
  private rootPath: string;
  private openspecRoot: string;
  private openloreRoot: string;
  private options: Required<OpenSpecWriterOptions>;
  private configManager: OpenSpecConfigManager;

  constructor(options: OpenSpecWriterOptions) {
    this.rootPath = resolve(options.rootPath);
    this.openspecRoot = options.openspecRoot
      ? resolve(options.openspecRoot)
      : safeJoin(this.rootPath, OPENSPEC_DIR);
    this.openloreRoot = options.openloreRoot
      ? resolve(options.openloreRoot)
      : safeJoin(this.rootPath, OPENLORE_DIR);
    this.options = {
      rootPath: this.rootPath,
      openspecRoot: this.openspecRoot,
      openloreRoot: this.openloreRoot,
      writeMode: options.writeMode ?? 'replace',
      version: options.version ?? '1.0.0',
      createBackups: options.createBackups ?? true,
      updateConfig: options.updateConfig ?? true,
      validateBeforeWrite: options.validateBeforeWrite ?? true,
      cleanBeforeWrite: options.cleanBeforeWrite ?? false,
    };
    this.configManager = new OpenSpecConfigManager(this.rootPath, this.openspecRoot);
  }

  /**
   * Initialize OpenSpec directory structure
   */
  async initialize(): Promise<void> {
    // Create openspec directory structure
    await mkdir(safeJoin(this.openspecRoot, OPENSPEC_SPECS_SUBDIR), { recursive: true });
    await mkdir(safeJoin(this.openspecRoot, OPENSPEC_DECISIONS_SUBDIR), { recursive: true });
    await mkdir(safeJoin(this.openspecRoot, join('changes', 'archive')), { recursive: true });

    // Create the .openlore directory structure under the configured root, which a
    // preview redirects away from the project.
    await mkdir(safeJoin(this.openloreRoot, OPENLORE_ANALYSIS_SUBDIR), { recursive: true });
    await mkdir(safeJoin(this.openloreRoot, OPENLORE_BACKUPS_SUBDIR), { recursive: true });
    await mkdir(safeJoin(this.openloreRoot, OPENLORE_OUTPUTS_SUBDIR), { recursive: true });
    await mkdir(safeJoin(this.openloreRoot, OPENLORE_LOGS_SUBDIR), { recursive: true });

    logger.success('Initialized OpenSpec directory structure');
  }

  /**
   * Write all generated specs
   */
  async writeSpecs(
    specs: GeneratedSpec[],
    survey: ProjectSurveyResult,
    metadataSpecs: GeneratedSpec[] = specs,
  ): Promise<GenerationReport> {
    const report: GenerationReport = {
      timestamp: new Date().toISOString(),
      openspecVersion: await this.detectOpenSpecVersion(),
      openloreVersion: OPENLORE_PACKAGE_VERSION,
      configSchemaVersion: this.options.version,
      filesWritten: [],
      filesSkipped: [],
      filesBackedUp: [],
      filesMerged: [],
      domainsRemoved: [],
      configUpdated: false,
      validationErrors: [],
      warnings: [],
      nextSteps: [],
    };

    // Ensure directories exist
    await this.initialize();

    // Remove stale domain directories when --force is used
    if (this.options.cleanBeforeWrite) {
      const incomingDomains = new Set(
        specs
          .filter(s => s.type === 'domain' || s.type === 'api')
          .map(s => normalizeDomainName(s.domain))
      );
      const specsDir = safeJoin(this.openspecRoot, OPENSPEC_SPECS_SUBDIR);
      let entries: Dirent[];
      try {
        entries = await readdir(specsDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
        else throw error;
      }
      const staleDomains = entries
        .filter(entry =>
          entry.isDirectory() &&
          !RESERVED_SPEC_DIRECTORIES.has(entry.name) &&
          !incomingDomains.has(entry.name)
        )
        .map(entry => ({
          name: entry.name,
          domainDir: safeJoin(
            this.openspecRoot,
            join(OPENSPEC_SPECS_SUBDIR, entry.name),
          ),
        }));

      // Complete every recursive backup before the first removal. If any backup
      // fails, no stale source directory has been deleted.
      if (this.options.createBackups && staleDomains.length > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const stale of staleDomains) {
          const backupDir = safeJoin(
            this.openloreRoot,
            join(OPENLORE_BACKUPS_SUBDIR, timestamp, OPENSPEC_SPECS_SUBDIR, stale.name),
          );
          await cp(stale.domainDir, backupDir, { recursive: true });
          report.filesBackedUp.push(toRepositoryPath(relative(this.rootPath, backupDir)));
        }
      }

      for (const stale of staleDomains) {
        await rm(stale.domainDir, { recursive: true, force: true });
        report.domainsRemoved.push(stale.name);
        logger.warning(`Removed stale domain: ${stale.name}`);
      }
    }

    // Write each spec
    for (const spec of specs) {
      if (this.options.validateBeforeWrite) {
        const validation = validateFullSpec(spec.content);
        for (const error of validation.errors) {
          report.validationErrors.push(`${spec.path}: ${error}`);
        }
        for (const warning of validation.warnings) {
          report.warnings.push(`${spec.path}: ${warning}`);
        }
        if (!validation.valid) {
          logger.warning(`Validation errors for ${spec.path}: ${validation.errors.join(', ')}`);
        }
      }

      const result = await this.writeSpec(spec);

      if (result.success) {
        switch (result.action) {
          case 'written':
            report.filesWritten.push(result.path);
            break;
          case 'skipped':
            report.filesSkipped.push(result.path);
            break;
          case 'merged':
            report.filesMerged.push(result.path);
            if (result.backupPath) report.filesBackedUp.push(result.backupPath);
            break;
          case 'backed_up':
            if (result.backupPath) {
              report.filesBackedUp.push(result.backupPath);
            }
            report.filesWritten.push(result.path);
            break;
        }
      } else {
        report.warnings.push(`Failed to write ${result.path}: ${result.error}`);
      }
    }

    // Update config.yaml
    if (this.options.updateConfig) {
      try {
        await this.updateConfig(metadataSpecs, survey);
        report.configUpdated = true;
      } catch (error) {
        report.warnings.push(`Failed to update config.yaml: ${(error as Error).message}`);
      }
    }

    // Generate next steps
    report.nextSteps = this.generateNextSteps(report);

    // Save generation report
    await this.saveReport(report);

    // Log summary
    this.logSummary(report);

    return report;
  }

  /**
   * Write a single spec file
   */
  private async writeSpec(spec: GeneratedSpec): Promise<WriteResult> {
    const relativePath = spec.path;

    // Confine every spec write to the project root through the shared, symlink-aware
    // guard — the same one every other untrusted-path surface routes through
    // (mcp-security: Symlink-Aware Path Confinement / Write Confinement). `spec.path`'s
    // domain segment derives from the Stage-3 LLM `domain` field over untrusted repo
    // content, so a traversal value must never escape the root (GHSA-5j8x-q7q6-58j5).
    // Fail closed for this one spec and let the rest proceed.
    let fullPath: string;
    try {
      const prefix = `${OPENSPEC_DIR}/`;
      if (!spec.path.startsWith(prefix)) throw new Error(`Spec path must start with ${prefix}`);
      fullPath = safeJoin(this.openspecRoot, spec.path.slice(prefix.length));
    } catch (error) {
      logger.warning(`Refusing to write spec outside project root: ${relativePath}`);
      return {
        path: relativePath,
        action: 'written',
        success: false,
        error: (error as Error).message,
      };
    }

    try {
      // Check if file exists
      const exists = await fileExists(fullPath);

      if (exists) {
        switch (this.options.writeMode) {
          case 'skip':
            logger.discovery(`Skipping existing spec: ${relativePath}`);
            return { path: relativePath, action: 'skipped', success: true };

          case 'merge':
            return await this.mergeSpec(spec, fullPath, relativePath);

          case 'replace':
          default:
            // Backup if enabled
            if (this.options.createBackups) {
              const backupPath = await this.backupFile(fullPath, relativePath);
              await this.ensureDir(fullPath);
              await writeFile(fullPath, spec.content, 'utf-8');
              logger.success(`Wrote ${relativePath} (backed up existing)`);
              return { path: relativePath, action: 'backed_up', success: true, backupPath };
            }
        }
      }

      // Write new file
      await this.ensureDir(fullPath);
      await writeFile(fullPath, spec.content, 'utf-8');
      logger.success(`Wrote ${relativePath}`);
      return { path: relativePath, action: 'written', success: true };
    } catch (error) {
      return {
        path: relativePath,
        action: 'written',
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Merge spec with existing content
   */
  private async mergeSpec(spec: GeneratedSpec, fullPath: string, relativePath: string): Promise<WriteResult> {
    try {
      const existingContent = await readFile(fullPath, 'utf-8');
      const backupPath = this.options.createBackups
        ? await this.backupFile(fullPath, relativePath)
        : undefined;
      const generatedBlock = [
        GENERATED_SECTION_START,
        GENERATED_SECTION_HEADING,
        '',
        this.escapeGeneratedBoundaryTokens(this.extractGeneratedSection(spec.content)),
        '',
        GENERATED_SECTION_END,
      ].join('\n');

      // Replace only a complete writer-owned pair. Unpaired legacy content is
      // ambiguous, so preserve it wholesale and append the first bounded block.
      const markerIndex = existingContent.indexOf(GENERATED_SECTION_START);
      if (markerIndex !== -1) {
        const endIndex = existingContent.indexOf(
          GENERATED_SECTION_END,
          markerIndex + GENERATED_SECTION_START.length,
        );
        if (endIndex !== -1) {
          const humanContent = existingContent.slice(0, markerIndex).trimEnd();
          const trailingHumanContent = existingContent
            .slice(endIndex + GENERATED_SECTION_END.length)
            .trim();
          const mergedContent = [humanContent, generatedBlock, trailingHumanContent]
            .filter(Boolean)
            .join('\n\n');
          await writeFile(fullPath, mergedContent, 'utf-8');
        } else {
          const preserved = this.escapeGeneratedBoundaryTokens(existingContent).trimEnd();
          await writeFile(fullPath, `${preserved}\n\n${generatedBlock}`, 'utf-8');
          logger.warning(`Preserved unbounded legacy generated content while migrating ${relativePath}`);
        }
      } else {
        // A heading-only block is the legacy format. It has no trustworthy end,
        // so preserve the entire file and append a deterministic paired block.
        const preserved = this.escapeGeneratedBoundaryTokens(existingContent).trimEnd();
        const mergedContent = `${preserved}\n\n${generatedBlock}`;
        await writeFile(fullPath, mergedContent, 'utf-8');
      }

      logger.success(`Merged ${relativePath}`);
      return { path: relativePath, action: 'merged', success: true, backupPath };
    } catch (error) {
      return {
        path: relativePath,
        action: 'merged',
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Extract generated content for merge (skip headers)
   */
  private extractGeneratedSection(content: string): string {
    // Skip the title and generated header lines
    const lines = content.split('\n');
    let startIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip title, blank lines, and metadata comments
      if (line.startsWith('#') && !line.startsWith('##')) continue;
      if (line.startsWith('>')) continue;
      if (line.trim() === '') continue;
      startIndex = i;
      break;
    }

    return lines.slice(startIndex).join('\n').trim();
  }

  /**
   * Boundary tokens can appear in LLM output or human documentation. Store those
   * occurrences as visible Markdown text so only writer-authored tokens delimit a
   * replaceable block.
   */
  private escapeGeneratedBoundaryTokens(content: string): string {
    return content
      .replaceAll(GENERATED_SECTION_START, ESCAPED_GENERATED_SECTION_START)
      .replaceAll(GENERATED_SECTION_END, ESCAPED_GENERATED_SECTION_END);
  }

  /**
   * Backup an existing file
   */
  private async backupFile(fullPath: string, relativePath: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = safeJoin(
      this.openloreRoot,
      join(OPENLORE_BACKUPS_SUBDIR, timestamp, relativePath),
    );

    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(fullPath, backupPath);

    // SERVED, so POSIX on every host (#458). `filesWritten`/`filesMerged` in the same report come
    // from `spec.path`, which is always POSIX — a native `filesBackedUp` made one report carry two
    // separator conventions at once, and only on Windows.
    logger.discovery(`Backed up ${relativePath} to ${relative(this.rootPath, backupPath)}`);
    return toRepositoryPath(relative(this.rootPath, backupPath));
  }

  /**
   * Update config.yaml with openlore metadata
   */
  private async updateConfig(specs: GeneratedSpec[], survey: ProjectSurveyResult): Promise<void> {
    const domains = specs
      .filter(s => s.type === 'domain')
      .map(s => normalizeDomainName(s.domain));

    const metadata: OpenLoreMetadata = {
      version: this.options.version,
      generatedAt: new Date().toISOString(),
      domains,
      confidence: survey.confidence,
    };

    const detectedContext = buildDetectedContext(survey);

    // Reject a repo-controlled config symlink before the config manager reads or writes it.
    safeJoin(this.openspecRoot, OPENSPEC_CONFIG_FILENAME);
    await this.configManager.updateWithOpenLoreMetadata(metadata, detectedContext, {
      preserveUserContext: true,
      appendDetectedInfo: true,
      version: this.options.version,
    });
  }

  /**
   * Detect OpenSpec version if installed
   */
  private async detectOpenSpecVersion(): Promise<string> {
    return detectOpenSpecPackageVersion(this.rootPath);
  }

  /**
   * Generate next steps based on results
   */
  private generateNextSteps(report: GenerationReport): string[] {
    const steps: string[] = [];

    if (report.filesWritten.length > 0 || report.filesMerged.length > 0) {
      steps.push("Review generated specs: openspec list --specs");
      steps.push("Validate structure: openspec validate --all");
      steps.push("Test accuracy: openlore verify");
    }

    if (report.filesSkipped.length > 0) {
      steps.push(`Review skipped files (${report.filesSkipped.length} existing specs preserved)`);
    }

    if (report.validationErrors.length > 0) {
      steps.push("Fix validation errors before using specs");
    }

    steps.push("Create a change proposal: openspec change my-feature");

    return steps;
  }

  /**
   * Save generation report to .openlore/outputs/
   */
  private async saveReport(report: GenerationReport): Promise<void> {
    const reportPath = safeJoin(
      this.openloreRoot,
      join(OPENLORE_OUTPUTS_SUBDIR, ARTIFACT_GENERATION_REPORT),
    );
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    logger.discovery(`Saved generation report to ${relative(this.rootPath, reportPath)}`);
  }

  /**
   * Log summary to console
   */
  private logSummary(report: GenerationReport): void {
    logger.blank();
    logger.success('=== Generation Complete ===');
    logger.blank();

    if (report.filesWritten.length > 0) {
      logger.success(`${report.filesWritten.length} spec(s) written`);
    }
    if (report.filesMerged.length > 0) {
      logger.success(`${report.filesMerged.length} spec(s) merged`);
    }
    if (report.filesSkipped.length > 0) {
      logger.info('Skipped', `${report.filesSkipped.length} spec(s) already exist`);
    }
    if (report.domainsRemoved.length > 0) {
      logger.warning(`Removed ${report.domainsRemoved.length} stale domain(s): ${report.domainsRemoved.join(', ')}`);
    }
    if (report.filesBackedUp.length > 0) {
      logger.info('Backups', `${report.filesBackedUp.length} created`);
    }
    if (report.configUpdated) {
      logger.success('config.yaml updated');
    }

    if (report.warnings.length > 0) {
      logger.blank();
      for (const warning of report.warnings) {
        logger.warning(warning);
      }
    }

    logger.blank();
    logger.info('Next steps', '');
    for (let i = 0; i < report.nextSteps.length; i++) {
      logger.info(`  ${i + 1}.`, report.nextSteps[i]);
    }
    logger.blank();
  }

  /**
   * Ensure directory exists for file
   */
  private async ensureDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
  }

  /**
   * Get list of existing spec domains
   */
  async getExistingDomains(): Promise<string[]> {
    return this.configManager.getExistingDomains();
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Write generated specs to OpenSpec directory
 */
export async function writeOpenSpecs(
  specs: GeneratedSpec[],
  survey: ProjectSurveyResult,
  options: OpenSpecWriterOptions
): Promise<GenerationReport> {
  const writer = new OpenSpecWriter(options);
  return writer.writeSpecs(specs, survey);
}

/**
 * Initialize OpenSpec directory structure without writing specs
 */
export async function initializeOpenSpec(rootPath: string): Promise<void> {
  const writer = new OpenSpecWriter({ rootPath });
  await writer.initialize();
}
