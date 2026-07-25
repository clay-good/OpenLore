/**
 * Repository Mapper
 *
 * Combines file walking and significance scoring into a comprehensive "map"
 * of the repository that guides all subsequent analysis.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  DEFAULT_MAX_FILES,
  HIGH_VALUE_FILES_LIMIT,
  HIGH_VALUE_FILES_PREVIEW_LIMIT,
  ENTRY_POINTS_PREVIEW_LIMIT,
  LANGUAGES_PREVIEW_LIMIT,
  DIRECTORIES_PREVIEW_LIMIT,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_REPOSITORY_MAP,
} from '../../constants.js';
import type { ProjectType, ScoredFile, FileMetadata } from '../../types/index.js';
import { FileWalker, type FileWalkerOptions } from './file-walker.js';
import { SignificanceScorer, type ScoringConfig } from './significance-scorer.js';
import { deriveDomainFromPath, DOMAIN_NOISE_DIRS } from './domain-naming.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Language breakdown in the repository
 */
export interface LanguageBreakdown {
  language: string;
  extension: string;
  fileCount: number;
  percentage: number;
}

/**
 * Detected framework information
 */
export interface DetectedFramework {
  name: string;
  category: 'frontend' | 'backend' | 'database' | 'testing' | 'auth' | 'ci' | 'other';
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

/**
 * Directory statistics
 */
export interface DirectoryStats {
  path: string;
  fileCount: number;
  purpose: string;
  avgScore: number;
}

/**
 * File clusters by domain/layer
 */
export interface FileClusters {
  byDirectory: Record<string, ScoredFile[]>;
  byDomain: Record<string, ScoredFile[]>;
  byLayer: {
    presentation: ScoredFile[];
    business: ScoredFile[];
    data: ScoredFile[];
    infrastructure: ScoredFile[];
  };
}

/**
 * Repository map metadata
 */
export interface RepositoryMapMetadata {
  projectName: string;
  projectType: ProjectType;
  rootPath: string;
  analyzedAt: string;
  version: string;
}

/**
 * Repository map summary
 */
export interface RepositoryMapSummary {
  totalFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  languages: LanguageBreakdown[];
  frameworks: DetectedFramework[];
  directories: DirectoryStats[];
}

/**
 * Complete repository map
 */
export interface RepositoryMap {
  metadata: RepositoryMapMetadata;
  summary: RepositoryMapSummary;
  highValueFiles: ScoredFile[];
  entryPoints: ScoredFile[];
  schemaFiles: ScoredFile[];
  configFiles: ScoredFile[];
  clusters: FileClusters;
  allFiles: ScoredFile[];
}

/**
 * Options for repository mapping
 */
export interface RepositoryMapperOptions {
  /** Maximum files to process */
  maxFiles?: number;
  /** Patterns to force-include, overriding gitignore and excludePatterns */
  includePatterns?: string[];
  /** Additional patterns to exclude */
  excludePatterns?: string[];
  /** Custom scoring configuration */
  scoringConfig?: ScoringConfig;
  /** Progress callback */
  onProgress?: (stage: string, progress: number) => void;
  /** Output directory for analysis files */
  outputDir?: string;
}

// ============================================================================
// FRAMEWORK DETECTION
// ============================================================================

interface FrameworkDetector {
  name: string;
  category: DetectedFramework['category'];
  detect: (files: FileMetadata[], packageJson: Record<string, unknown> | null) => {
    detected: boolean;
    confidence: DetectedFramework['confidence'];
    evidence: string[];
  };
}

const FRAMEWORK_DETECTORS: FrameworkDetector[] = [
  // JavaScript/TypeScript Frameworks
  {
    name: 'React',
    category: 'frontend',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['react']) evidence.push('react in dependencies');
      if (files.some(f => f.extension === '.jsx' || f.extension === '.tsx')) {
        evidence.push('.jsx/.tsx files found');
      }

      return {
        detected: evidence.length > 0,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        evidence,
      };
    },
  },
  {
    name: 'Next.js',
    category: 'frontend',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['next']) evidence.push('next in dependencies');
      if (files.some(f => f.name.startsWith('next.config'))) {
        evidence.push('next.config.* found');
      }
      if (files.some(f => f.directory === 'pages' || f.directory === 'app' || f.directory.startsWith('pages/') || f.directory.startsWith('app/'))) {
        evidence.push('pages/ or app/ directory found');
      }

      return {
        detected: evidence.length > 0,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        evidence,
      };
    },
  },
  {
    name: 'Express',
    category: 'backend',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['express']) evidence.push('express in dependencies');

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  {
    name: 'NestJS',
    category: 'backend',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (Object.keys(deps).some(d => d.startsWith('@nestjs/'))) {
        evidence.push('@nestjs/* packages in dependencies');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  {
    name: 'Vue',
    category: 'frontend',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['vue']) evidence.push('vue in dependencies');
      if (files.some(f => f.extension === '.vue')) {
        evidence.push('.vue files found');
      }

      return {
        detected: evidence.length > 0,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        evidence,
      };
    },
  },
  {
    name: 'Angular',
    category: 'frontend',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (Object.keys(deps).some(d => d.startsWith('@angular/'))) {
        evidence.push('@angular/* packages in dependencies');
      }
      if (files.some(f => f.name === 'angular.json')) {
        evidence.push('angular.json found');
      }

      return {
        detected: evidence.length > 0,
        confidence: evidence.length >= 2 ? 'high' : 'medium',
        evidence,
      };
    },
  },
  // Testing Frameworks
  {
    name: 'Jest',
    category: 'testing',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['jest']) evidence.push('jest in dependencies');
      if (files.some(f => f.name.startsWith('jest.config'))) {
        evidence.push('jest.config.* found');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  {
    name: 'Vitest',
    category: 'testing',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['vitest']) evidence.push('vitest in dependencies');
      if (files.some(f => f.name.startsWith('vitest.config'))) {
        evidence.push('vitest.config.* found');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  // Database
  {
    name: 'PostgreSQL',
    category: 'database',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['pg'] || deps['postgres'] || deps['@prisma/client']) {
        evidence.push('PostgreSQL client in dependencies');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'medium',
        evidence,
      };
    },
  },
  {
    name: 'MongoDB',
    category: 'database',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['mongodb'] || deps['mongoose']) {
        evidence.push('MongoDB client in dependencies');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  // Auth
  {
    name: 'JWT Auth',
    category: 'auth',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['jsonwebtoken'] || deps['jose']) {
        evidence.push('JWT library in dependencies');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  {
    name: 'Passport',
    category: 'auth',
    detect: (files, pkg) => {
      const evidence: string[] = [];
      const deps = { ...(pkg?.dependencies as Record<string, string> || {}), ...(pkg?.devDependencies as Record<string, string> || {}) };

      if (deps['passport']) {
        evidence.push('passport in dependencies');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  // CI/CD
  {
    name: 'GitHub Actions',
    category: 'ci',
    detect: (files) => {
      const evidence: string[] = [];

      if (files.some(f => f.path.includes('.github/workflows'))) {
        evidence.push('.github/workflows directory found');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
  {
    name: 'GitLab CI',
    category: 'ci',
    detect: (files) => {
      const evidence: string[] = [];

      if (files.some(f => f.name === '.gitlab-ci.yml')) {
        evidence.push('.gitlab-ci.yml found');
      }

      return {
        detected: evidence.length > 0,
        confidence: 'high',
        evidence,
      };
    },
  },
];

// ============================================================================
// LAYER DETECTION
// ============================================================================

const LAYER_PATTERNS = {
  presentation: [
    /\/(components?|views?|pages?|ui|screens?|layouts?)\//i,
    /\.(jsx|tsx|vue)$/,
    /\.component\./,
    /\.page\./,
  ],
  business: [
    /\/(services?|domain|business|core|logic|usecases?)\//i,
    /\.service\./,
    /\.usecase\./,
  ],
  data: [
    /\/(models?|entities?|repositories?|schemas?|db|database|data)\//i,
    /\.model\./,
    /\.entity\./,
    /\.repository\./,
    /\.schema\./,
  ],
  infrastructure: [
    /\/(config|utils?|helpers?|lib|middleware|infra|infrastructure)\//i,
    /\.config\./,
    /\.util\./,
    /\.helper\./,
    /\.middleware\./,
  ],
};

function detectLayer(file: ScoredFile): keyof typeof LAYER_PATTERNS | null {
  const pathAndName = file.path + '/' + file.name;

  for (const [layer, patterns] of Object.entries(LAYER_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(pathAndName)) {
        return layer as keyof typeof LAYER_PATTERNS;
      }
    }
  }

  return null;
}

// ============================================================================
// DOMAIN INFERENCE
// ============================================================================

/**
 * Infer domains from file paths and names
 */
function inferDomains(files: ScoredFile[]): Record<string, ScoredFile[]> {
  const domains: Record<string, ScoredFile[]> = {};

  // Common domain prefixes to look for
  const domainPrefixes = new Map<string, string[]>();

  for (const file of files) {
    // Skip test and config files for domain inference
    if (file.isTest || file.isConfig) continue;

    // Derive a domain from the file's directory by walking leaf-first and
    // skipping build-layout / reverse-DNS package noise (shared with the
    // dependency-graph cluster naming). Walking leaf-first is what keeps Java
    // (src/main/java/com/example/inventory/Foo.java) at the business package
    // ("inventory") instead of collapsing every source file into the org root
    // ("com"/"springframework"). See issue #138.
    const dirParts = file.path.replace(/\\/g, '/').split('/').slice(0, -1);
    const domain = deriveDomainFromPath(dirParts);
    if (domain) {
      if (!domains[domain]) {
        domains[domain] = [];
      }
      domains[domain].push(file);
    }

    // Also check file name prefixes (e.g., user-service.ts -> user)
    const nameWithoutExt = file.name.replace(/\.[^.]+$/, '');
    const nameParts = nameWithoutExt.split(/[-_.]/);

    if (nameParts.length > 1) {
      const prefix = nameParts[0].toLowerCase();
      if (prefix.length > 2 && !DOMAIN_NOISE_DIRS.has(prefix)) {
        if (!domainPrefixes.has(prefix)) {
          domainPrefixes.set(prefix, []);
        }
        domainPrefixes.get(prefix)!.push(file.path);
      }
    }
  }

  // Add domains from file prefixes if they have multiple files
  for (const [prefix, filePaths] of domainPrefixes) {
    if (filePaths.length >= 2 && !domains[prefix]) {
      domains[prefix] = files.filter(f => filePaths.includes(f.path));
    }
  }

  // Remove domains with only 1 file
  for (const domain of Object.keys(domains)) {
    if (domains[domain].length < 2) {
      delete domains[domain];
    }
  }

  return domains;
}

// ============================================================================
// REPOSITORY MAPPER CLASS
// ============================================================================

export class RepositoryMapper {
  private rootPath: string;
  private options: RepositoryMapperOptions;
  private packageJson: Record<string, unknown> | null = null;

  constructor(rootPath: string, options: RepositoryMapperOptions = {}) {
    this.rootPath = rootPath;
    this.options = {
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      includePatterns: options.includePatterns ?? [],
      excludePatterns: options.excludePatterns ?? [],
      scoringConfig: options.scoringConfig ?? {},
      onProgress: options.onProgress ?? (() => {}),
      outputDir: options.outputDir ?? join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR),
    };
  }

  /**
   * Load package.json if it exists
   */
  private async loadPackageJson(): Promise<void> {
    try {
      const content = await readFile(join(this.rootPath, 'package.json'), 'utf-8');
      this.packageJson = JSON.parse(content);
    } catch {
      this.packageJson = null;
    }
  }

  /**
   * Get project name from package.json or directory name
   */
  private getProjectName(): string {
    if (this.packageJson?.name && typeof this.packageJson.name === 'string') {
      return this.packageJson.name;
    }
    return basename(this.rootPath);
  }

  /**
   * Detect project type
   */
  private detectProjectType(files: FileMetadata[]): ProjectType {
    // Check for language-specific files
    const hasPackageJson = files.some(f => f.name === 'package.json');
    const hasPyproject = files.some(f => f.name === 'pyproject.toml' || f.name === 'setup.py');
    const hasCargoToml = files.some(f => f.name === 'Cargo.toml');
    const hasGoMod = files.some(f => f.name === 'go.mod');
    const hasJavaBuild = files.some(f => f.name === 'pom.xml' || f.name === 'build.gradle' || f.name === 'build.gradle.kts');
    const hasGemfile = files.some(f => f.name === 'Gemfile');
    const hasComposer = files.some(f => f.name === 'composer.json');

    if (hasPackageJson) return 'nodejs';
    if (hasPyproject) return 'python';
    if (hasCargoToml) return 'rust';
    if (hasGoMod) return 'go';
    if (hasJavaBuild) return 'java';
    if (hasGemfile) return 'ruby';
    if (hasComposer) return 'php';

    return 'unknown';
  }

  /**
   * Calculate language breakdown
   */
  private calculateLanguages(files: FileMetadata[]): LanguageBreakdown[] {
    const extCounts: Record<string, number> = {};
    const extToLang: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript (React)',
      '.mts': 'TypeScript',
      '.cts': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript (React)',
      '.mjs': 'JavaScript',
      '.cjs': 'JavaScript',
      '.py': 'Python',
      '.rs': 'Rust',
      '.go': 'Go',
      '.java': 'Java',
      '.rb': 'Ruby',
      '.php': 'PHP',
      '.vue': 'Vue',
      '.svelte': 'Svelte',
      '.css': 'CSS',
      '.scss': 'SCSS',
      '.less': 'LESS',
      '.html': 'HTML',
      '.json': 'JSON',
      '.yaml': 'YAML',
      '.yml': 'YAML',
      '.md': 'Markdown',
      '.sql': 'SQL',
      '.graphql': 'GraphQL',
      '.prisma': 'Prisma',
    };

    for (const file of files) {
      const ext = file.extension.toLowerCase();
      extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }

    const total = files.length;
    const languages: LanguageBreakdown[] = [];

    for (const [ext, count] of Object.entries(extCounts)) {
      if (count > 0) {
        languages.push({
          language: extToLang[ext] ?? ext.slice(1).toUpperCase(),
          extension: ext,
          fileCount: count,
          percentage: Math.round((count / total) * 100),
        });
      }
    }

    // Sort by file count descending
    languages.sort((a, b) => b.fileCount - a.fileCount);

    return languages;
  }

  /**
   * Detect frameworks
   */
  private detectFrameworks(files: FileMetadata[]): DetectedFramework[] {
    const frameworks: DetectedFramework[] = [];

    for (const detector of FRAMEWORK_DETECTORS) {
      const result = detector.detect(files, this.packageJson);
      if (result.detected) {
        frameworks.push({
          name: detector.name,
          category: detector.category,
          confidence: result.confidence,
          evidence: result.evidence,
        });
      }
    }

    return frameworks;
  }

  /**
   * Calculate directory statistics
   */
  private calculateDirectoryStats(files: ScoredFile[]): DirectoryStats[] {
    const dirStats: Record<string, { files: ScoredFile[]; totalScore: number }> = {};

    for (const file of files) {
      const dir = file.directory || '(root)';
      if (!dirStats[dir]) {
        dirStats[dir] = { files: [], totalScore: 0 };
      }
      dirStats[dir].files.push(file);
      dirStats[dir].totalScore += file.score;
    }

    const stats: DirectoryStats[] = [];

    for (const [path, data] of Object.entries(dirStats)) {
      // Infer purpose from directory name
      let purpose = 'unknown';
      const pathLower = path.toLowerCase();

      if (pathLower.includes('test') || pathLower.includes('spec')) purpose = 'tests';
      else if (pathLower.includes('component')) purpose = 'components';
      else if (pathLower.includes('service')) purpose = 'services';
      else if (pathLower.includes('model') || pathLower.includes('entity')) purpose = 'models';
      else if (pathLower.includes('route') || pathLower.includes('api')) purpose = 'api';
      else if (pathLower.includes('config')) purpose = 'configuration';
      else if (pathLower.includes('util') || pathLower.includes('helper')) purpose = 'utilities';
      else if (pathLower.includes('middleware')) purpose = 'middleware';
      else if (path === '(root)') purpose = 'root';
      else if (pathLower === 'src' || pathLower === 'lib') purpose = 'source';

      stats.push({
        path,
        fileCount: data.files.length,
        purpose,
        avgScore: Math.round(data.totalScore / data.files.length),
      });
    }

    // Sort by file count descending
    stats.sort((a, b) => b.fileCount - a.fileCount);

    return stats;
  }

  /**
   * Cluster files by various dimensions
   */
  private clusterFiles(files: ScoredFile[]): FileClusters {
    // By directory
    const byDirectory: Record<string, ScoredFile[]> = {};
    for (const file of files) {
      const dir = file.directory || '(root)';
      if (!byDirectory[dir]) {
        byDirectory[dir] = [];
      }
      byDirectory[dir].push(file);
    }

    // By domain (inferred)
    const byDomain = inferDomains(files);

    // By layer
    const byLayer: FileClusters['byLayer'] = {
      presentation: [],
      business: [],
      data: [],
      infrastructure: [],
    };

    for (const file of files) {
      const layer = detectLayer(file);
      if (layer) {
        byLayer[layer].push(file);
      }
    }

    return { byDirectory, byDomain, byLayer };
  }

  /**
   * Generate the repository map
   */
  async map(): Promise<RepositoryMap> {
    this.options.onProgress?.('loading', 0);

    // Load package.json
    await this.loadPackageJson();

    this.options.onProgress?.('walking', 10);

    // Walk the directory
    const walkerOptions: FileWalkerOptions = {
      maxFiles: this.options.maxFiles,
      includePatterns: this.options.includePatterns,
      excludePatterns: this.options.excludePatterns,
      onProgress: (progress) => {
        const cap = Math.min(this.options.maxFiles ?? DEFAULT_MAX_FILES, 5_000);
        const pct = 10 + Math.round((Math.min(progress.filesFound, cap) / cap) * 30);
        this.options.onProgress?.('walking', Math.min(pct, 40));
      },
    };

    const walker = new FileWalker(this.rootPath, walkerOptions);
    const walkResult = await walker.walk();

    this.options.onProgress?.('scoring', 40);

    // Score all files
    const scorer = new SignificanceScorer(this.options.scoringConfig);
    const scoredFiles = await scorer.scoreFiles(walkResult.files);

    this.options.onProgress?.('analyzing', 70);

    // Detect project type and frameworks
    const projectType = this.detectProjectType(walkResult.files);
    const languages = this.calculateLanguages(walkResult.files);
    const frameworks = this.detectFrameworks(walkResult.files);

    // Extract special file categories
    const highValueFiles = scoredFiles.slice(0, HIGH_VALUE_FILES_LIMIT);
    const entryPoints = scoredFiles.filter(f => f.isEntryPoint);
    const schemaFiles = scoredFiles.filter(f =>
      f.tags.includes('schema') ||
      f.name.toLowerCase().includes('model') ||
      f.name.toLowerCase().includes('entity') ||
      f.name.toLowerCase().includes('schema')
    );
    const configFiles = scoredFiles.filter(f => f.isConfig);

    // Calculate directory stats and clusters
    const directories = this.calculateDirectoryStats(scoredFiles);
    const clusters = this.clusterFiles(scoredFiles);

    this.options.onProgress?.('complete', 100);

    // Build the map
    const map: RepositoryMap = {
      metadata: {
        projectName: this.getProjectName(),
        projectType,
        rootPath: this.rootPath,
        analyzedAt: new Date().toISOString(),
        version: '1.0.0',
      },
      summary: {
        totalFiles: walkResult.summary.totalFiles + walkResult.summary.skippedCount,
        analyzedFiles: walkResult.summary.totalFiles,
        skippedFiles: walkResult.summary.skippedCount,
        languages,
        frameworks,
        directories,
      },
      highValueFiles,
      entryPoints,
      schemaFiles,
      configFiles,
      clusters,
      allFiles: scoredFiles,
    };

    return map;
  }

  /**
   * Write repository map to output directory
   */
  async writeOutput(map: RepositoryMap): Promise<void> {
    // Ensure output directory exists
    await mkdir(this.options.outputDir!, { recursive: true });

    // Write JSON map
    const mapPath = join(this.options.outputDir!, ARTIFACT_REPOSITORY_MAP);
    await writeFile(mapPath, JSON.stringify(map, null, 2), 'utf-8');

    // Write summary markdown
    const summaryPath = join(this.options.outputDir!, 'SUMMARY.md');
    const summary = this.generateSummaryMarkdown(map);
    await writeFile(summaryPath, summary, 'utf-8');
  }

  /**
   * Generate human-readable summary
   */
  private generateSummaryMarkdown(map: RepositoryMap): string {
    const lines: string[] = [];

    lines.push(`# Repository Analysis: ${map.metadata.projectName}`);
    lines.push('');
    lines.push(`> Generated by openlore v${map.metadata.version} on ${map.metadata.analyzedAt}`);
    lines.push('');

    // Overview
    lines.push('## Overview');
    lines.push('');
    lines.push(`- **Project Type**: ${map.metadata.projectType}`);
    lines.push(`- **Total Files**: ${map.summary.totalFiles}`);
    lines.push(`- **Analyzed Files**: ${map.summary.analyzedFiles}`);
    lines.push(`- **Skipped Files**: ${map.summary.skippedFiles}`);
    lines.push('');

    // Languages
    lines.push('## Languages');
    lines.push('');
    lines.push('| Language | Files | Percentage |');
    lines.push('|----------|-------|------------|');
    for (const lang of map.summary.languages.slice(0, LANGUAGES_PREVIEW_LIMIT)) {
      lines.push(`| ${lang.language} | ${lang.fileCount} | ${lang.percentage}% |`);
    }
    lines.push('');

    // Frameworks
    if (map.summary.frameworks.length > 0) {
      lines.push('## Detected Frameworks');
      lines.push('');
      for (const fw of map.summary.frameworks) {
        lines.push(`- **${fw.name}** (${fw.category}, ${fw.confidence} confidence)`);
        for (const evidence of fw.evidence) {
          lines.push(`  - ${evidence}`);
        }
      }
      lines.push('');
    }

    // High Value Files
    lines.push(`## High Value Files (Top ${HIGH_VALUE_FILES_PREVIEW_LIMIT})`);
    lines.push('');
    lines.push('| File | Score | Tags |');
    lines.push('|------|-------|------|');
    for (const file of map.highValueFiles.slice(0, HIGH_VALUE_FILES_PREVIEW_LIMIT)) {
      const tags = file.tags.join(', ') || '-';
      lines.push(`| ${file.path} | ${file.score} | ${tags} |`);
    }
    lines.push('');

    // Entry Points
    if (map.entryPoints.length > 0) {
      lines.push('## Entry Points');
      lines.push('');
      for (const file of map.entryPoints.slice(0, ENTRY_POINTS_PREVIEW_LIMIT)) {
        lines.push(`- ${file.path} (score: ${file.score})`);
      }
      lines.push('');
    }

    // Inferred Domains
    const domains = Object.keys(map.clusters.byDomain);
    if (domains.length > 0) {
      lines.push('## Inferred Domains');
      lines.push('');
      lines.push('These domains may become separate spec files:');
      lines.push('');
      for (const domain of domains) {
        const files = map.clusters.byDomain[domain];
        lines.push(`- **${domain}** (${files.length} files)`);
      }
      lines.push('');
    }

    // Directory Structure
    lines.push('## Directory Structure');
    lines.push('');
    lines.push('| Directory | Files | Purpose | Avg Score |');
    lines.push('|-----------|-------|---------|-----------|');
    for (const dir of map.summary.directories.slice(0, DIRECTORIES_PREVIEW_LIMIT)) {
      lines.push(`| ${dir.path} | ${dir.fileCount} | ${dir.purpose} | ${dir.avgScore} |`);
    }
    lines.push('');

    return lines.join('\n');
  }
}

/**
 * Convenience function to map a repository
 */
export async function mapRepository(
  rootPath: string,
  options?: RepositoryMapperOptions
): Promise<RepositoryMap> {
  const mapper = new RepositoryMapper(rootPath, options);
  const map = await mapper.map();

  await mapper.writeOutput(map);

  return map;
}
