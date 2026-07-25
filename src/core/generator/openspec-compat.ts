/**
 * OpenSpec Compatibility Layer
 *
 * Ensures perfect compatibility with OpenSpec's tooling and conventions.
 * Handles config.yaml integration, validation, and context injection.
 */

import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml, parseDocument } from 'yaml';
import logger from '../../utils/logger.js';
import { OPENSPEC_DIR, OPENSPEC_CONFIG_FILENAME } from '../../constants.js';
import type { ProjectSurveyResult } from './spec-pipeline.js';

/**
 * Top-level `config.yaml` keys OpenSpec (the host) owns when OpenLore runs as an
 * OpenSpec plugin. Their presence marks the config as host-managed, in which case
 * OpenLore writes ONLY its `openlore` key (the one it declares via
 * `ownsConfigKeys`) and leaves every other key byte-for-byte unchanged — it never
 * introduces or overwrites a host-owned key. When none of these are present the
 * config is treated as standalone OpenLore's own, and OpenLore may create
 * `schema`/`context` as before (it is then the legitimate creator).
 */
export const HOST_OWNED_CONFIG_KEYS = [
  'version',
  'profile',
  'delivery',
  'workflows',
  'featureFlags',
  'plugins',
] as const;

/**
 * Replace (or append) a single top-level YAML block by name in `raw`, touching no
 * other bytes. The block spans the `<key>:` line at column 0 through the LAST
 * following indented (non-blank) line — blank lines *within* the body are kept as
 * part of the block, while trailing blank lines that merely separate it from the
 * next top-level key are preserved as host content. Replacement stops at the next
 * column-0 non-blank line (a new top-level key or a column-0 comment) or EOF. When
 * the key is absent the block is appended. This is a literal text edit — not a YAML
 * re-serialization — so host content (other keys, comments, CRLF, folded scalars)
 * is preserved byte-for-byte.
 *
 * @param blockText  the serialized `<key>: …` YAML (LF-separated)
 * @param eol        the file's detected line ending (`\n` or `\r\n`)
 */
export function spliceTopLevelBlock(raw: string, key: string, blockText: string, eol: string): string {
  const blockLines = blockText.replace(/\n+$/, '').split('\n');
  const keyLine = new RegExp(`^${key}\\s*:`);
  const lines = raw.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => keyLine.test(l));

  // Key absent → append, keeping `raw` byte-for-byte and adding a newline separator
  // only when it does not already end with one.
  if (startIdx === -1) {
    const block = blockLines.join(eol) + eol;
    if (raw.length === 0) return block;
    return raw + (raw.endsWith('\n') ? '' : eol) + block;
  }

  // Key present → replace the `<key>:` line plus its indented body. Scan forward
  // until the next column-0 non-blank line (or EOF), tracking the last indented,
  // non-blank line: that is the true end of the block. A blank line alone never
  // ends a YAML mapping value, so blanks embedded in the body are absorbed; trailing
  // blanks after the body stay with the following host content.
  let lastBody = startIdx;
  let scan = startIdx + 1;
  while (scan < lines.length && !/^\S/.test(lines[scan])) {
    if (/^[ \t]/.test(lines[scan]) && lines[scan].trim() !== '') lastBody = scan;
    scan++;
  }
  return [...lines.slice(0, startIdx), ...blockLines, ...lines.slice(lastBody + 1)].join(eol);
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Validation result for specs and config
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * OpenSpec config.yaml structure
 */
export interface OpenSpecConfig {
  schema?: string;
  context?: string;
  rules?: {
    proposal?: string[];
    specs?: string[];
    design?: string[];
    tasks?: string[];
  };
  'openlore'?: OpenLoreMetadata;
}

/**
 * openlore metadata added to config.yaml
 */
export interface OpenLoreMetadata {
  version: string;
  generatedAt: string;
  domains: string[];
  confidence: number;
  adrCount?: number;
}

/**
 * Detected project context for injection
 */
export interface DetectedContext {
  techStack: string;
  architecture: string;
  domains: string[];
  patterns: string[];
}

/**
 * Options for context update
 */
export interface ContextUpdateOptions {
  preserveUserContext: boolean;
  appendDetectedInfo: boolean;
  version: string;
}

// ============================================================================
// OPENSPEC VALIDATION
// ============================================================================

/**
 * OpenSpec validator for specs and configuration
 */
export class OpenSpecValidator {
  /**
   * Validate the complete spec structure
   */
  validateSpecStructure(content: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for title (# heading at start)
    if (!content.match(/^#\s+.+/m)) {
      errors.push('Missing title (# heading)');
    }

    // Check for Purpose section
    if (!content.includes('## Purpose')) {
      warnings.push('Missing Purpose section (recommended)');
    }

    // Check for Requirements section (except overview which may have Domains instead)
    if (!content.includes('## Requirements') && !content.includes('## Domains') && !content.includes('## Key Capabilities')) {
      warnings.push('Missing Requirements section');
    }

    // Check for delta markers (should not be in generated specs)
    if (content.match(/\[ADDED\]|\[MODIFIED\]|\[REMOVED\]/)) {
      errors.push('Generated specs should not contain delta markers ([ADDED], [MODIFIED], [REMOVED])');
    }

    // Check markdown structure is valid
    const headingLevels = this.checkHeadingHierarchy(content);
    if (!headingLevels.valid) {
      warnings.push(...headingLevels.issues);
    }

    // Check for broken links
    const brokenLinks = this.checkMarkdownLinks(content);
    if (brokenLinks.length > 0) {
      warnings.push(...brokenLinks.map(link => `Potentially malformed link: ${link}`));
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate requirement format follows RFC 2119
   */
  validateRequirementFormat(requirement: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for RFC 2119 keywords
    const rfc2119Keywords = /\b(SHALL|MUST|SHOULD|MAY|SHALL NOT|MUST NOT|SHOULD NOT|MAY NOT)\b/;
    if (!rfc2119Keywords.test(requirement)) {
      warnings.push('Requirement does not use RFC 2119 keywords (SHALL, MUST, SHOULD, MAY)');
    }

    // Check for imperative form
    if (requirement.match(/^The system\s+/i) === null && requirement.match(/^The\s+\w+\s+(SHALL|MUST|SHOULD|MAY)/i) === null) {
      warnings.push('Requirement should start with "The system" or "The [component]"');
    }

    // Check it's not too short (likely incomplete)
    if (requirement.split(/\s+/).length < 5) {
      warnings.push('Requirement may be too brief');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate scenario format (Given/When/Then)
   */
  validateScenarioFormat(scenario: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for scenario heading with exactly 4 hashtags
    if (!scenario.match(/^####\s+Scenario:/m)) {
      errors.push('Scenario heading must use exactly 4 hashtags (####)');
    }

    // Check for GIVEN
    if (!scenario.includes('**GIVEN**') && !scenario.includes('- **GIVEN**')) {
      errors.push('Scenario missing GIVEN clause');
    }

    // Check for WHEN
    if (!scenario.includes('**WHEN**') && !scenario.includes('- **WHEN**')) {
      errors.push('Scenario missing WHEN clause');
    }

    // Check for THEN
    if (!scenario.includes('**THEN**') && !scenario.includes('- **THEN**')) {
      errors.push('Scenario missing THEN clause');
    }

    // AND is optional but if present should be formatted correctly
    if (scenario.includes('AND') && !scenario.match(/\*\*AND\*\*/)) {
      warnings.push('AND clause should be bolded (**AND**)');
    }

    // Check order: GIVEN should come before WHEN, WHEN before THEN
    const givenIndex = scenario.indexOf('**GIVEN**');
    const whenIndex = scenario.indexOf('**WHEN**');
    const thenIndex = scenario.indexOf('**THEN**');

    if (givenIndex !== -1 && whenIndex !== -1 && givenIndex > whenIndex) {
      errors.push('GIVEN must come before WHEN');
    }
    if (whenIndex !== -1 && thenIndex !== -1 && whenIndex > thenIndex) {
      errors.push('WHEN must come before THEN');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate config.yaml structure
   */
  validateConfigYaml(config: unknown): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof config !== 'object' || config === null) {
      errors.push('Config must be an object');
      return { valid: false, errors, warnings };
    }

    const configObj = config as Record<string, unknown>;

    // Check schema field
    if (configObj.schema !== undefined && typeof configObj.schema !== 'string') {
      errors.push('schema must be a string');
    }

    // Check context field
    if (configObj.context !== undefined && typeof configObj.context !== 'string') {
      errors.push('context must be a string');
    }

    // Check rules field
    if (configObj.rules !== undefined) {
      if (typeof configObj.rules !== 'object' || configObj.rules === null) {
        errors.push('rules must be an object');
      } else {
        const rules = configObj.rules as Record<string, unknown>;
        const allowedRuleKeys = ['proposal', 'specs', 'design', 'tasks'];

        for (const key of Object.keys(rules)) {
          if (!allowedRuleKeys.includes(key)) {
            warnings.push(`Unknown rule key: ${key}`);
          }
          if (!Array.isArray(rules[key])) {
            errors.push(`rules.${key} must be an array`);
          }
        }
      }
    }

    // Check openlore metadata if present
    if (configObj['openlore'] !== undefined) {
      const openlore = configObj['openlore'] as Record<string, unknown>;

      if (typeof openlore.version !== 'string') {
        warnings.push('openlore.version should be a string');
      }
      if (typeof openlore.generatedAt !== 'string') {
        warnings.push('openlore.generatedAt should be a string');
      }
      if (!Array.isArray(openlore.domains)) {
        warnings.push('openlore.domains should be an array');
      }
      if (typeof openlore.confidence !== 'number') {
        warnings.push('openlore.confidence should be a number');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Check heading hierarchy is valid (no skipped levels)
   */
  private checkHeadingHierarchy(content: string): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    const headings = content.match(/^#{1,6}\s+.+/gm) || [];

    let lastLevel = 0;
    for (const heading of headings) {
      const match = heading.match(/^(#{1,6})/);
      if (match) {
        const level = match[1].length;
        if (level > lastLevel + 1 && lastLevel !== 0) {
          issues.push(`Heading level jumped from ${lastLevel} to ${level}: "${heading.slice(0, 50)}..."`);
        }
        lastLevel = level;
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Check for malformed markdown links
   */
  private checkMarkdownLinks(content: string): string[] {
    const malformed: string[] = [];

    // Find all markdown links
    const linkPattern = /\[([^\]]*)\]\(([^)]*)\)/g;
    let match;

    while ((match = linkPattern.exec(content)) !== null) {
      const [fullMatch, text, url] = match;

      // Check for empty text or URL
      if (!text.trim()) {
        malformed.push(fullMatch);
      }
      if (!url.trim()) {
        malformed.push(fullMatch);
      }
      // Check for obviously broken URLs
      if (url.includes(' ') && !url.startsWith('http')) {
        malformed.push(fullMatch);
      }
    }

    return malformed;
  }
}

// ============================================================================
// CONFIG.YAML MANAGER
// ============================================================================

/**
 * OpenSpec config.yaml manager
 */
export class OpenSpecConfigManager {
  private configPath: string;
  private openspecRoot: string;

  constructor(projectRoot: string) {
    this.openspecRoot = join(projectRoot, OPENSPEC_DIR);
    this.configPath = join(this.openspecRoot, OPENSPEC_CONFIG_FILENAME);
  }

  /**
   * Check if OpenSpec is initialized
   */
  async isInitialized(): Promise<boolean> {
    try {
      await access(this.openspecRoot);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if config.yaml exists
   */
  async hasConfig(): Promise<boolean> {
    try {
      await access(this.configPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read existing config.yaml
   */
  async readConfig(): Promise<OpenSpecConfig | null> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      return parseYaml(content) as OpenSpecConfig;
    } catch {
      return null;
    }
  }

  /**
   * Write config.yaml, preserving user content
   */
  async writeConfig(config: OpenSpecConfig): Promise<void> {
    await mkdir(this.openspecRoot, { recursive: true });
    const content = stringifyYaml(config, { lineWidth: 100 });
    await writeFile(this.configPath, content, 'utf-8');
    logger.success(`Updated ${this.configPath}`);
  }

  /**
   * Update config with openlore metadata while preserving user/host content.
   *
   * Write discipline (config-key ownership): OpenLore owns exactly the `openlore`
   * key. When a config.yaml already exists, the update is performed surgically
   * through the YAML Document API so every other key — and every comment — is
   * preserved verbatim. If the existing config is host-managed (it carries any
   * {@link HOST_OWNED_CONFIG_KEYS}, i.e. OpenSpec created it), OpenLore touches
   * ONLY its `openlore` key and never introduces or overwrites a host-owned key
   * (context auto-injection is skipped — the host owns `context`). When no config
   * exists, OpenLore is the legitimate creator and may seed `schema`/`context`.
   */
  async updateWithOpenLoreMetadata(
    metadata: OpenLoreMetadata,
    detectedContext?: DetectedContext,
    options: ContextUpdateOptions = {
      preserveUserContext: true,
      appendDetectedInfo: true,
      version: '1.0.0',
    }
  ): Promise<OpenSpecConfig> {
    let raw: string | null;
    try {
      raw = await readFile(this.configPath, 'utf-8');
    } catch {
      raw = null;
    }

    if (raw !== null) {
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) {
        // Never clobber a host file we cannot parse — fail loudly instead of
        // re-serializing (or truncating) malformed YAML.
        throw new Error(
          `Refusing to update ${this.configPath}: it is not valid YAML (${doc.errors[0].message}). ` +
            `Fix the file and retry.`
        );
      }
      const hostManaged = HOST_OWNED_CONFIG_KEYS.some((key) => doc.has(key));

      if (hostManaged) {
        // Byte-exact: splice ONLY the top-level `openlore:` block into the raw
        // text. Every other byte — host keys, comments, CRLF line endings, folded
        // scalars — is left untouched. `context` is host-owned, so it is not
        // injected here.
        const eol = raw.includes('\r\n') ? '\r\n' : '\n';
        const block = stringifyYaml({ openlore: metadata }, { lineWidth: 100 });
        const next = spliceTopLevelBlock(raw, 'openlore', block, eol);

        // Safety net: never let a splice that produced invalid YAML reach disk.
        // The on-disk file stays the (valid) original if anything is off.
        const verified = parseDocument(next);
        if (verified.errors.length > 0) {
          throw new Error(
            `Internal error updating ${this.configPath} (${verified.errors[0].message}); ` +
              `left the file unchanged.`
          );
        }

        await mkdir(this.openspecRoot, { recursive: true });
        await writeFile(this.configPath, next, 'utf-8');
        logger.success(`Updated ${this.configPath}`);
        return verified.toJSON() as OpenSpecConfig;
      }

      // Standalone OpenLore-owned file (no host keys): re-serialization is fine —
      // it is our file — and context auto-injection is allowed.
      doc.set('openlore', metadata);
      if (detectedContext && options.appendDetectedInfo) {
        const existing = doc.get('context');
        doc.set(
          'context',
          this.buildContext(
            typeof existing === 'string' ? existing : undefined,
            detectedContext,
            options.preserveUserContext
          )
        );
      }

      await mkdir(this.openspecRoot, { recursive: true });
      await writeFile(this.configPath, doc.toString(), 'utf-8');
      logger.success(`Updated ${this.configPath}`);
      return doc.toJSON() as OpenSpecConfig;
    }

    // No config yet → OpenLore is the legitimate creator (standalone mode).
    const config: OpenSpecConfig = { schema: 'spec-driven' };
    config['openlore'] = metadata;
    if (detectedContext && options.appendDetectedInfo) {
      config.context = this.buildContext(undefined, detectedContext, options.preserveUserContext);
    }

    await this.writeConfig(config);
    return config;
  }

  /**
   * Build context string combining user and detected info
   */
  private buildContext(
    existingContext: string | undefined,
    detected: DetectedContext,
    preserveUser: boolean
  ): string {
    const lines: string[] = [];

    // Preserve user context if it exists
    if (preserveUser && existingContext) {
      lines.push('# User-provided context (preserved)');
      lines.push(existingContext.trim());
      lines.push('');
    }

    // Add auto-detected context
    lines.push('# Auto-detected by openlore');
    lines.push(`Tech stack: ${detected.techStack}`);
    lines.push(`Architecture: ${detected.architecture}`);
    lines.push(`Domains: ${detected.domains.join(', ')}`);
    if (detected.patterns.length > 0) {
      lines.push(`Key patterns: ${detected.patterns.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Get existing user context from config
   */
  async getUserContext(): Promise<string | null> {
    const config = await this.readConfig();
    return config?.context ?? null;
  }

  /**
   * Get existing domains from specs directory
   */
  async getExistingDomains(): Promise<string[]> {
    const specsDir = join(this.openspecRoot, 'specs');
    try {
      const entries = await readdir(specsDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => !['overview', 'architecture', 'api'].includes(name));
    } catch {
      return [];
    }
  }
}

// ============================================================================
// CONTEXT INJECTION
// ============================================================================

/**
 * Build detected context from analysis results
 */
export function buildDetectedContext(survey: ProjectSurveyResult): DetectedContext {
  // Build tech stack description
  const techStack = [survey.primaryLanguage, ...survey.frameworks].join(', ');

  // Build architecture description
  const archPatterns: Record<string, string> = {
    layered: 'Layered (routes → controllers → services → repositories)',
    hexagonal: 'Hexagonal/Ports & Adapters',
    microservices: 'Microservices',
    monolith: 'Monolithic',
    serverless: 'Serverless',
    'event-driven': 'Event-Driven',
    mvc: 'Model-View-Controller',
    other: 'Custom architecture',
  };
  const architecture = archPatterns[survey.architecturePattern] || survey.architecturePattern;

  // Detect common patterns from frameworks
  const patterns: string[] = [];
  if (survey.frameworks.some(f => f.toLowerCase().includes('typeorm') || f.toLowerCase().includes('prisma'))) {
    patterns.push('Repository pattern');
  }
  if (survey.frameworks.some(f => f.toLowerCase().includes('inversify') || f.toLowerCase().includes('tsyringe'))) {
    patterns.push('Dependency injection');
  }
  if (survey.frameworks.some(f => f.toLowerCase().includes('express') || f.toLowerCase().includes('fastify'))) {
    patterns.push('Middleware pipeline');
  }
  if (survey.frameworks.some(f => f.toLowerCase().includes('react') || f.toLowerCase().includes('vue'))) {
    patterns.push('Component-based UI');
  }

  return {
    techStack,
    architecture,
    domains: survey.suggestedDomains,
    patterns,
  };
}

// ============================================================================
// DOMAIN NAMING
// ============================================================================

/**
 * Normalize domain name to OpenSpec conventions
 */
export function normalizeDomainName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

/**
 * Check if domain name follows conventions
 */
export function isValidDomainName(name: string): boolean {
  // Must be lowercase kebab-case
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z]$/.test(name)) {
    return false;
  }

  // Avoid generic names
  const genericNames = ['misc', 'other', 'utils', 'common', 'shared', 'general', 'helpers'];
  if (genericNames.includes(name)) {
    return false;
  }

  return true;
}

/**
 * Match suggested domains against existing domains
 */
export function matchExistingDomains(
  suggestedDomains: string[],
  existingDomains: string[]
): Map<string, string> {
  const matches = new Map<string, string>();

  for (const suggested of suggestedDomains) {
    const normalized = normalizeDomainName(suggested);

    // Exact match
    if (existingDomains.includes(normalized)) {
      matches.set(suggested, normalized);
      continue;
    }

    // Partial match (suggested is substring or vice versa)
    for (const existing of existingDomains) {
      if (existing.includes(normalized) || normalized.includes(existing)) {
        matches.set(suggested, existing);
        break;
      }
    }
  }

  return matches;
}

// ============================================================================
// FULL SPEC VALIDATION
// ============================================================================

/**
 * Validate a complete spec file
 */
export function validateFullSpec(content: string): ValidationResult {
  const validator = new OpenSpecValidator();
  const result = validator.validateSpecStructure(content);

  // Also validate all requirements in the spec
  const requirementBlocks = content.match(/###\s+Requirement:[^\n]+[\s\S]*?(?=###\s+Requirement:|## |$)/g) || [];
  for (const block of requirementBlocks) {
    const reqResult = validator.validateRequirementFormat(block);
    result.warnings.push(...reqResult.warnings);
    result.errors.push(...reqResult.errors);
  }

  // Validate all scenarios
  const scenarioBlocks = content.match(/####\s+Scenario:[^\n]+[\s\S]*?(?=####\s+Scenario:|###\s+Requirement:|## |$)/g) || [];
  for (const block of scenarioBlocks) {
    const scenResult = validator.validateScenarioFormat(block);
    result.warnings.push(...scenResult.warnings);
    result.errors.push(...scenResult.errors);
  }

  // Update valid status
  result.valid = result.errors.length === 0;

  return result;
}

/**
 * Validate all specs in a directory
 */
export async function validateSpecsDirectory(specsDir: string): Promise<{
  valid: boolean;
  results: Map<string, ValidationResult>;
}> {
  const results = new Map<string, ValidationResult>();
  let allValid = true;

  try {
    const entries = await readdir(specsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const specPath = join(specsDir, entry.name, 'spec.md');
        try {
          const content = await readFile(specPath, 'utf-8');
          const result = validateFullSpec(content);
          results.set(entry.name, result);
          if (!result.valid) {
            allValid = false;
          }
        } catch {
          // spec.md doesn't exist in this directory
          results.set(entry.name, {
            valid: false,
            errors: ['spec.md not found'],
            warnings: [],
          });
          allValid = false;
        }
      }
    }
  } catch {
    // specs directory doesn't exist
    return {
      valid: false,
      results: new Map([['specs', { valid: false, errors: ['specs directory not found'], warnings: [] }]]),
    };
  }

  return { valid: allValid, results };
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

/**
 * Create a new OpenSpec compatibility helper
 */
export function createOpenSpecCompat(projectRoot: string): {
  validator: OpenSpecValidator;
  configManager: OpenSpecConfigManager;
} {
  return {
    validator: new OpenSpecValidator(),
    configManager: new OpenSpecConfigManager(projectRoot),
  };
}
